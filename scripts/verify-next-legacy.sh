#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Next.js 14 and 15 (no adapter API): build each fixture, read its .next/ into .nbo/ the way the
# control-plane's runner does, serve it with `nbo serve`, and check pages, routes, middleware and files.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
NBO_BIN="node packages/cli/dist/main.js"

check() { # name, expected substring, actual
  if [[ "$3" != *"$2"* ]]; then
    echo "FAIL $1: expected '$2' in: ${3:0:400}" >&2
    exit 1
  fi
  echo "ok   $1"
}

for v in ${NEXT_VERSIONS:-14 15}; do
  app="fixtures/next$v-app"
  port=$((4100 + v))
  echo "== Next.js $v: build =="
  rm -rf "$app/.next" "$app/.nbo"
  (cd "$app" && NEXT_TELEMETRY_DISABLED=1 NBO_BUILD_ID=verify pnpm build >/dev/null)
  echo "== Next.js $v: read .next/ into .nbo/ =="
  node --input-type=module -e "
    import { pathToFileURL } from 'node:url';
    const [lib, appDir, root] = process.argv.slice(1);
    const { produceLegacyNext } = await import(pathToFileURL(lib).href);
    await produceLegacyNext(appDir, { root });
  " "$ROOT/packages/next-adapter/src/legacy.js" "$ROOT/$app" "$ROOT" 2> >(grep -v '^nbo: ' >&2)
  $NBO_BIN validate --strict "$app/.nbo" >/dev/null

  log="$(mktemp)"
  $NBO_BIN serve "$app/.nbo" --port "$port" >"$log" 2>&1 &
  pid=$!
  trap 'kill "$pid" 2>/dev/null || true' EXIT
  for i in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "http://localhost:$port/" || true)" = 200 ] && break
    if [ "$i" -eq 30 ]; then cat "$log" >&2; exit 1; fi
    sleep 1
  done
  base="http://localhost:$port"
  check "/" "Hello from Next.js $v" "$(curl -s "$base/")"
  check "dynamic route" "post <!-- -->7" "$(curl -s "$base/posts/7")"
  check "middleware header" "x-from-middleware: 1" "$(curl -s -D - -o /dev/null "$base/posts/7" | tr -d '\r' | tr 'A-Z' 'a-z')"
  check "route handler" '{"hello":"nbo"}' "$(curl -s "$base/api/hello?name=nbo")"
  check "ISR page" "rendered at" "$(curl -s "$base/isr")"
  check "Pages Router page" "pages router says <!-- -->nbo" "$(curl -s "$base/old?name=nbo")"
  check "public file" "User-agent" "$(curl -s "$base/robots.txt")"
  asset="$(curl -s "$base/" | grep -o '/_next/static/[^"]*\.js' | head -1)"
  check "hashed asset is immutable" "immutable" "$(curl -s -D - -o /dev/null "$base$asset" | tr -d '\r')"
  check "unknown path" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$base/no-such-page")"
  kill "$pid"
  trap - EXIT
  rm -f "$log"
done
echo "PASS"
