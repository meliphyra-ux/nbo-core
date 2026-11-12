#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Local-only half of the real Slice 4 ISR verification: conformance
# plus the real fresh/stale/regenerate/draft-mode/revalidate behavior
# checks (scripts/lib-isr-checks.sh), against a plain local `nbo serve`
# pointed at the real, already-deployed, remote cache service. Run
# scripts/verify-slice4-isr-cache.sh first (or export NBO_ISRCACHE_URL
# yourself). Only tears down the local nbo serve process on exit — the
# cache service it points at is left running for
# scripts/verify-slice4-isr-cloud.sh to reuse.
set -euo pipefail
cd "$(dirname "$0")/.."

BYPASS_TOKEN="nbo-slice4-isr-test-token"
URL_FILE="/tmp/nbo-isr-cache-url.txt"
NBO_BIN="node packages/cli/dist/main.js"

CACHE_URL="${NBO_ISRCACHE_URL:-}"
if [ -z "$CACHE_URL" ]; then
  if [ ! -f "$URL_FILE" ]; then
    echo "no cache URL: run scripts/verify-slice4-isr-cache.sh first, or export NBO_ISRCACHE_URL yourself" >&2
    exit 1
  fi
  CACHE_URL=$(cat "$URL_FILE")
fi
echo "== using cache service at $CACHE_URL =="

SERVE_PID=""
cleanup() {
  echo "== tearing down (local nbo serve only — the cache service is untouched) =="
  if [ -n "$SERVE_PID" ]; then
    kill "$SERVE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "== building @nbo/cli (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build

echo "== building next-app (a real ISR page: /isr-demo, revalidate=2s) =="
# A node function host killed by a prior, failed run's own cleanup can
# be left orphaned on Windows (killing nbo serve doesn't recursively
# kill its spawned children — a known, accepted rough edge,
# docs/points-to-improve-or-fix.md), holding this directory open and
# making rm -rf fail with "Device or resource busy".
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'next-app' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
rm -rf fixtures/next-app/.next fixtures/next-app/.nbo
(cd fixtures/next-app && pnpm build)

export NBO_ISRCACHE_URL="$CACHE_URL"
export NBO_PRERENDER_BYPASS="$BYPASS_TOKEN"

echo "== starting nbo serve (local), pointed at the real, remote cache service =="
SERVE_LOG="$(mktemp)"
$NBO_BIN serve fixtures/next-app/.nbo --port 4104 > "$SERVE_LOG" 2>&1 &
SERVE_PID=$!
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:4104/isr-demo || echo 000)
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

echo "== conformance: nbo serve (local) =="
$NBO_BIN conformance fixtures/conformance/slice4-isr http://localhost:4104
rm -f "$SERVE_LOG"

source "$(dirname "$0")/lib-isr-checks.sh"
run_isr_checks "http://localhost:4104" "$BYPASS_TOKEN"

echo "== all local checks passed =="
echo "== next: scripts/verify-slice4-isr-cloud.sh =="
