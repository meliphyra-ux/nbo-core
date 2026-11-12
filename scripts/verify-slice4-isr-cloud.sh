#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Cloud half of the real Slice 4 ISR verification: deploys the same
# .nbo/ build to both Kubernetes and Cloud Run, each pointed at the
# same already-deployed, real ISR cache service, and proves the cache
# is genuinely shared across clouds — a render regenerated via the
# Kubernetes deployment must be visible, unregenerated, from the
# entirely separate Cloud Run deployment. Run
# scripts/verify-slice4-isr-cache.sh first (or export NBO_ISRCACHE_URL
# yourself). Only tears down the app deployments on exit — the cache
# service itself is left running; tear it down with
# scripts/verify-slice4-isr-teardown.sh once you're done with
# everything.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NBO_GCP_PROJECT:?export NBO_GCP_PROJECT first}"
: "${NBO_GCP_REGION:?export NBO_GCP_REGION first}"
: "${NBO_AR_REPO:?export NBO_AR_REPO first}"

APP="isr-next-app"
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

cleanup() {
  echo "== tearing down the app deployments (the cache service is untouched — run scripts/verify-slice4-isr-teardown.sh once you're done with everything) =="
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

echo "== building next-app (a real ISR page: /isr-demo, revalidate=2s) =="
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'next-app' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
rm -rf fixtures/next-app/.next fixtures/next-app/.nbo
(cd fixtures/next-app && pnpm build)

export NBO_ISRCACHE_URL="$CACHE_URL"
export NBO_PRERENDER_BYPASS="$BYPASS_TOKEN"

echo "== deploying the app to kubernetes (NBO_ISRCACHE_URL/NBO_PRERENDER_BYPASS baked in as /env.json) =="
$NBO_BIN deploy fixtures/next-app/.nbo --app "$APP" --target kubernetes
K8S_URL="https://$APP.127.0.0.1.sslip.io"
echo "== waiting for ingress/cert-manager to settle =="
sleep 5
echo "== conformance: kubernetes =="
$NBO_BIN conformance fixtures/conformance/slice4-isr "$K8S_URL" --insecure

echo "== deploying the app to cloud run =="
$NBO_BIN deploy fixtures/next-app/.nbo --app "$APP" --target cloudrun
CLOUDRUN_URL=$(gcloud run services describe "$APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --format='value(status.url)')
echo "== conformance: cloud run =="
$NBO_BIN conformance fixtures/conformance/slice4-isr "$CLOUDRUN_URL"

source "$(dirname "$0")/lib-isr-checks.sh"
run_isr_checks "$K8S_URL" "$BYPASS_TOKEN" -k

echo "== real ISR check: the cache is genuinely shared across clouds — a render on kubernetes is visible, unregenerated, from cloud run =="
# LAST_RENDERED_AT (set by run_isr_checks, above) just regenerated the
# cache via the kubernetes deployment's own on-demand revalidation. The
# SAME path, served by the entirely separate Cloud Run deployment, must
# see that exact same cached body — not independently re-render — or
# the two clouds are each keeping their own cache, which is the one
# thing this plan's own architecture exists to prevent.
t7=$(rendered_at "$CLOUDRUN_URL/isr-demo")
if [ "$t7" != "$LAST_RENDERED_AT" ]; then
  echo "expected cloud run to see the exact same cached body kubernetes just regenerated ($LAST_RENDERED_AT), got $t7 — the cache is not actually shared" >&2
  exit 1
fi

echo "== all cloud checks passed =="
echo "== next: scripts/verify-slice4-isr-teardown.sh (deletes the cache service too) =="
