#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Step 0's done-when gate: push static-site and react-spa through
# @nbo/producer-static -> `nbo validate` -> `nbo serve` and prove both
# serve locally. See docs/adr/0001-step-0-foundations.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# --- cleanup / safety net -------------------------------------------------
#
# SERVER_PID/SERVER_PORT track whatever server is currently running. Each
# server block below kills its own server explicitly once that block's
# checks are done (see stop_server calls further down) -- but under
# `set -e`, a single failing bare command (e.g. `curl -sf ... >/dev/null`)
# jumps straight to the EXIT trap and skips every line after it, including
# that explicit kill. This trap is the safety net for that path, not a
# replacement for the explicit kill: register it before anything else runs
# so it is always armed.
SERVER_PID=""
SERVER_PORT=""
FAILED=0

cleanup() {
  stop_server
}
trap cleanup EXIT

# True if something is LISTENING on TCP port $1, per netstat.
port_listening() {
  netstat -ano 2>/dev/null | grep -E "LISTENING" | grep -qE ":$1[[:space:]]"
}

# Poll until nothing is LISTENING on port $1, or give up after ~10s so a
# stuck port fails the script loudly instead of racing the next server.
wait_port_free() {
  local port="$1" tries=0
  while port_listening "$port"; do
    tries=$((tries + 1))
    if [ "$tries" -ge 40 ]; then
      echo "port $port is still listening after waiting ~10s" >&2
      return 1
    fi
    sleep 0.25
  done
}

# Kill the currently-tracked server and confirm its port is actually
# released before returning.
#
# On Git Bash on Windows, backgrounding a process goes through bash's exec
# emulation: the PID `$!` hands back is the emulation layer's PID, not
# always the PID of the process actually holding the listening socket --
# the real server shows up as THAT PID's child in `ps -ef`. Kill both the
# tracked PID and any child of it so nothing is left listening.
stop_server() {
  if [ -z "$SERVER_PID" ]; then
    return 0
  fi
  local pid="$SERVER_PID" port="$SERVER_PORT" child
  for child in $(ps -ef 2>/dev/null | awk -v p="$pid" '$3 == p { print $2 }'); do
    kill "$child" 2>/dev/null || true
  done
  kill "$pid" 2>/dev/null || true
  SERVER_PID=""
  if [ -n "$port" ]; then
    if ! wait_port_free "$port"; then
      echo "error: port $port is still in use after stop_server" >&2
      FAILED=1
    fi
  fi
  SERVER_PORT=""
}

# --- build @nbo/cli once; every validate/serve call below invokes the ---
# --- same compiled dist/main.js directly.                              ---
echo "== building @nbo/cli and @nbo/producer-static (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." --filter "@nbo/producer-static..." build
NBO_BIN="node packages/cli/dist/main.js"

echo "== building react-spa =="
(cd fixtures/react-spa && pnpm build)

# Run the static producer and print only the content id it reports.
# Usage: produce <buildDir> <outDir> [--spa]   (paths relative to the repo root)
produce() {
  local build_dir="$1" out_dir="$2"
  shift 2
  local out id
  out=$(pnpm --filter @nbo/producer-static exec node dist/cli.js \
    "../../$build_dir" --out "../../$out_dir" "$@")
  echo "$out" >&2
  id=$(echo "$out" | sed -n 's/.*(content id \(sha256:[0-9a-f]\{64\}\)).*/\1/p' | tail -n 1)
  if [ -z "$id" ]; then
    echo "could not find a content id in the producer output for $build_dir" >&2
    return 1
  fi
  echo "$id"
}

# Determinism gate (CLAUDE.md: building the same commit twice must yield the
# same content id). Build twice into the SAME --out path -- which, for these
# fixtures, sits inside the build dir, so a producer that ingests its own
# previous output fails here.
# Usage: produce_twice <buildDir> <outDir> [--spa]
produce_twice() {
  local build_dir="$1" out_dir="$2"
  shift 2
  local first second
  first=$(produce "$build_dir" "$out_dir" "$@")
  second=$(produce "$build_dir" "$out_dir" "$@")
  if [ "$first" != "$second" ]; then
    echo "NON-DETERMINISTIC BUILD for $build_dir: first run $first, second run $second" >&2
    return 1
  fi
  echo "deterministic: $build_dir -> $first (same id on both runs)"
}

# Expect HTTP status $2 from URL $1 (distinguishes a real 404 from a 500 or a
# connection reset, which `curl -f` alone would conflate).
expect_status() {
  local url="$1" want="$2" status
  status=$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)
  if [ "$status" != "$want" ]; then
    echo "expected $want for $url, got $status" >&2
    exit 1
  fi
}

echo "== producing static-site (twice, determinism check) =="
produce_twice fixtures/static-site fixtures/static-site/.nbo

echo "== producing react-spa (twice, determinism check) =="
produce_twice fixtures/react-spa/dist fixtures/react-spa/.nbo --spa

echo "== validating static-site (strict: a fresh build) =="
$NBO_BIN validate --strict fixtures/static-site/.nbo

echo "== validating react-spa (strict: a fresh build) =="
$NBO_BIN validate --strict fixtures/react-spa/.nbo

echo "== tampered static-site must fail validate and be refused by serve =="
TAMPERED_DIR=$(mktemp -d)
cp -r fixtures/static-site/.nbo/. "$TAMPERED_DIR"
printf 'tampered' >> "$TAMPERED_DIR/static/index.html"
if $NBO_BIN validate "$TAMPERED_DIR" 2>/dev/null; then
  echo "expected nbo validate to reject a tampered .nbo/ directory" >&2
  rm -rf "$TAMPERED_DIR"
  exit 1
fi
# serve must exit non-zero at startup instead of listening; `timeout` turns a
# server that wrongly starts into a failure (exit 124) rather than a hang.
set +e
timeout 10 $NBO_BIN serve "$TAMPERED_DIR" --port 4003 2>/dev/null
serve_status=$?
set -e
rm -rf "$TAMPERED_DIR"
if [ "$serve_status" -ne 1 ]; then
  echo "expected nbo serve to refuse a tampered .nbo/ directory with exit 1, got $serve_status" >&2
  exit 1
fi

echo "== serving static-site on :4001 =="
$NBO_BIN serve fixtures/static-site/.nbo --port 4001 &
SERVER_PID=$!
SERVER_PORT=4001
sleep 1
curl -sf http://localhost:4001/ > /dev/null
curl -sf http://localhost:4001/blog/hello > /dev/null
# non-ASCII (NFC) file name: fixtures/static-site/café.html -> /café
curl -sf "http://localhost:4001/caf%C3%A9" > /dev/null
expect_status http://localhost:4001/does-not-exist 404
stop_server

echo "== serving react-spa on :4002 =="
$NBO_BIN serve fixtures/react-spa/.nbo --port 4002 &
SERVER_PID=$!
SERVER_PORT=4002
sleep 1
curl -sf http://localhost:4002/ > /dev/null
curl -sf http://localhost:4002/about > /dev/null
# deep link with no matching static file must still load the SPA shell via fallback
curl -sf http://localhost:4002/settings/profile > /dev/null
# a missing hashed asset must still 404, not fall back to index.html
expect_status http://localhost:4002/assets/does-not-exist.js 404
stop_server

if [ "$FAILED" -ne 0 ]; then
  echo "== a server port failed to free in time -- treating this as a failed gate ==" >&2
  exit 1
fi

echo "== all checks passed =="
