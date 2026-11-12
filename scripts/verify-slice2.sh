#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== bootstrapping local cluster (idempotent if already up) =="
./scripts/bootstrap-local-k8s.sh

echo "== building @nbo/cli (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build
NBO_BIN="node packages/cli/dist/main.js"

echo "== building next-app (adapterPath is set in its own next.config.ts) =="
rm -rf fixtures/next-app/.next fixtures/next-app/.nbo
(cd fixtures/next-app && pnpm build)

echo "== conformance: nbo serve (local) =="
SERVE_LOG="$(mktemp)"
$NBO_BIN serve fixtures/next-app/.nbo --port 4100 > "$SERVE_LOG" 2>&1 &
serve_pid=$!
trap 'kill "$serve_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:4100/api/hello || echo 000)
  if [ "$code" == "200" ]; then
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "nbo serve never came up (last status $code)" >&2
    cat "$SERVE_LOG" >&2
    exit 1
  fi
  sleep 1
done
rm -f "$SERVE_LOG"
$NBO_BIN conformance fixtures/conformance/slice2 http://localhost:4100
$NBO_BIN conformance packages/conformance/transcripts/platform http://localhost:4100

echo "== streaming timing check (local): /api/stream must take measurably longer than an instant =="
start=$(date +%s%N)
curl -s -o /dev/null http://localhost:4100/api/stream
elapsed_ms=$(( ($(date +%s%N) - start) / 1000000 ))
echo "elapsed: ${elapsed_ms}ms"
if [ "$elapsed_ms" -lt 200 ]; then
  echo "expected /api/stream to take >= 200ms (its three chunks are 100ms apart) — got ${elapsed_ms}ms, buffering may have reappeared" >&2
  exit 1
fi

kill "$serve_pid" 2>/dev/null || true
trap - EXIT

echo "== deploying next-app to the cluster =="
out=$($NBO_BIN deploy fixtures/next-app/.nbo --app next-app)
echo "$out"

echo "== waiting for ingress/cert-manager to settle =="
sleep 5

echo "== conformance: deployed cluster =="
$NBO_BIN conformance fixtures/conformance/slice2 https://next-app.127.0.0.1.sslip.io --insecure
$NBO_BIN conformance packages/conformance/transcripts/platform https://next-app.127.0.0.1.sslip.io --insecure

echo "== streaming timing check (deployed): /api/stream must take measurably longer than an instant =="
start=$(date +%s%N)
curl -sk -o /dev/null https://next-app.127.0.0.1.sslip.io/api/stream
elapsed_ms=$(( ($(date +%s%N) - start) / 1000000 ))
echo "elapsed: ${elapsed_ms}ms"
if [ "$elapsed_ms" -lt 200 ]; then
  echo "expected /api/stream to take >= 200ms end-to-end — got ${elapsed_ms}ms, buffering may have reappeared somewhere in the full chain (k8s Service hop, ReverseProxy FlushInterval)" >&2
  exit 1
fi

echo "== all checks passed =="
