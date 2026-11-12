#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NBO_GCP_PROJECT:?export NBO_GCP_PROJECT first}"
: "${NBO_GCP_REGION:?export NBO_GCP_REGION first}"
: "${NBO_AR_REPO:?export NBO_AR_REPO first}"

APP="middleware-next-app"
SERVE_PID=""

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
}
trap cleanup EXIT

echo "== building @nbo/cli (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build
NBO_BIN="node packages/cli/dist/main.js"

echo "== building next-app (proxy.ts: 4 Next.js adapter middleware behaviors) =="
rm -rf fixtures/next-app/.next fixtures/next-app/.nbo
(cd fixtures/next-app && pnpm build)

echo "== conformance: nbo serve (local) =="
SERVE_LOG="$(mktemp)"
$NBO_BIN serve fixtures/next-app/.nbo --port 4101 > "$SERVE_LOG" 2>&1 &
SERVE_PID=$!
for i in $(seq 1 20); do
  if curl -s -o /dev/null http://localhost:4101/api/hello; then
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "nbo serve never came up — two functions (ssr + middleware) to spawn this time, not just one" >&2
    cat "$SERVE_LOG" >&2
    exit 1
  fi
  sleep 1
done
$NBO_BIN conformance fixtures/conformance/slice4-middleware http://localhost:4101
kill "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""
rm -f "$SERVE_LOG"

echo "== deploying to kubernetes =="
$NBO_BIN deploy fixtures/next-app/.nbo --app "$APP" --target kubernetes
echo "== waiting for ingress/cert-manager to settle =="
sleep 5
echo "== conformance: kubernetes =="
$NBO_BIN conformance fixtures/conformance/slice4-middleware "https://$APP.127.0.0.1.sslip.io" --insecure

echo "== deploying to cloud run =="
$NBO_BIN deploy fixtures/next-app/.nbo --app "$APP" --target cloudrun
CLOUDRUN_URL=$(gcloud run services describe "$APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --format='value(status.url)')
echo "== conformance: cloud run =="
$NBO_BIN conformance fixtures/conformance/slice4-middleware "$CLOUDRUN_URL"

echo "== all checks passed =="
