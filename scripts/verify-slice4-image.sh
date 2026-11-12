#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NBO_GCP_PROJECT:?export NBO_GCP_PROJECT first}"
: "${NBO_GCP_REGION:?export NBO_GCP_REGION first}"
: "${NBO_AR_REPO:?export NBO_AR_REPO first}"

APP="image-next-app"
NBO_BIN="node packages/cli/dist/main.js"
SERVE_PID=""
# Lives inside packages/serve/ itself (not a plain mktemp path) so
# Node's own ESM resolution — which walks up from the importing file's
# own location, not the process cwd — finds @nbo/serve's own sharp
# dependency in its node_modules. Found running this for real: a
# mktemp -d path outside the package tree hits ERR_MODULE_NOT_FOUND
# for "sharp" even under `pnpm --filter @nbo/serve exec`.
IMGCHECK_SRC="packages/serve/.imgcheck-verify-tmp.mjs"

cleanup() {
  echo "== tearing down =="
  if [ -n "$SERVE_PID" ]; then
    kill "$SERVE_PID" 2>/dev/null || true
  fi
  kubectl delete deployment "$APP" "$APP-fn-ssr" "$APP-fn-middleware" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete service "$APP" "$APP-fn-ssr" "$APP-fn-middleware" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete ingress "$APP" --ignore-not-found >/dev/null 2>&1 || true
  gcloud run services delete "$APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
  gcloud run services delete "$APP-fn-ssr" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
  gcloud run services delete "$APP-fn-middleware" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
  rm -f "$IMGCHECK_SRC"
}
trap cleanup EXIT

# A tiny, throwaway decoder: proves a response is a real, correctly-
# sized image rather than just "some bytes came back" — conformance
# transcripts can only assert status for a binary response (see
# @nbo/conformance's own status-only transcript support). Runs through
# @nbo/serve's own node_modules (pnpm --filter exec) so it reuses the
# sharp dependency @nbo/serve's own /_nbo/image route already depends
# on for the real resize, rather than adding a new one just to verify it.
cat > "$IMGCHECK_SRC" <<'EOF'
import sharp from "sharp";
const meta = await sharp(process.argv[2]).metadata();
console.log(meta.width);
EOF

echo "== building @nbo/cli (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build

echo "== building next-app (next/image config, Next's own defaults) =="
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'next-app' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
rm -rf fixtures/next-app/.next fixtures/next-app/.nbo
(cd fixtures/next-app && pnpm build)

echo "== conformance: nbo serve (local) =="
SERVE_LOG="$(mktemp)"
$NBO_BIN serve fixtures/next-app/.nbo --port 4108 > "$SERVE_LOG" 2>&1 &
SERVE_PID=$!
# Real bug found running this for real: on the very first iteration,
# right after backgrounding a server that hasn't started listening
# yet, curl itself returns a real non-zero exit (connection refused,
# not just a reported "000" status) — under `set -e`, a plain
# `code=$(curl ...)` assignment is NOT exempt the way an `if curl
# ...; then` condition is, so the whole script died silently on
# attempt 1 every time, never actually retrying. `|| echo 000` keeps
# the assignment itself always succeeding.
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:4108/_nbo/image?url=/images.jpg&w=384&q=75" || echo 000)
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
$NBO_BIN conformance fixtures/conformance/slice4-image http://localhost:4108

echo "== real check: the resize is genuinely real, not just bytes passing through =="
RESIZED="$(mktemp)"
curl -s "http://localhost:4108/_nbo/image?url=/images.jpg&w=384&q=75" -o "$RESIZED"
got_width=$(pnpm --filter @nbo/serve exec node "$(basename "$IMGCHECK_SRC")" "$RESIZED")
if [ "$got_width" != "384" ]; then
  echo "expected the decoded response width to be 384, got $got_width" >&2
  exit 1
fi
rm -f "$RESIZED"

kill "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""
rm -f "$SERVE_LOG"

echo "== deploying to kubernetes =="
$NBO_BIN deploy fixtures/next-app/.nbo --app "$APP" --target kubernetes
K8S_URL="https://$APP.127.0.0.1.sslip.io"
sleep 5
echo "== conformance: kubernetes =="
$NBO_BIN conformance fixtures/conformance/slice4-image "$K8S_URL" --insecure

echo "== deploying to cloud run =="
$NBO_BIN deploy fixtures/next-app/.nbo --app "$APP" --target cloudrun
CLOUDRUN_URL=$(gcloud run services describe "$APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --format='value(status.url)')
echo "== conformance: cloud run =="
$NBO_BIN conformance fixtures/conformance/slice4-image "$CLOUDRUN_URL"

echo "== all checks passed =="
