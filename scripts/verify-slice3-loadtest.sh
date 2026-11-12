#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail
cd "$(dirname "$0")/.."

# NBO_LOADTEST_SECOND=kubernetes puts the second backend on the local kind
# cluster too (a second app), so the weight shift runs with no cloud account.
SECOND="${NBO_LOADTEST_SECOND:-cloudrun}"
if [ "$SECOND" = "cloudrun" ]; then
  : "${NBO_GCP_PROJECT:?export NBO_GCP_PROJECT first}"
  : "${NBO_GCP_REGION:?export NBO_GCP_REGION first}"
  : "${NBO_AR_REPO:?export NBO_AR_REPO first}"
fi

APP="loadtest-next-app"
APP_B="$APP-b"
TEST_HOST="loadtest-test.local"
ADMIN="localhost:9444"
PROXY="localhost:9443"
EDGE_PID=""
EDGE_LOG="$(mktemp)"

cleanup() {
  echo "== tearing down =="
  if [ -n "$EDGE_PID" ]; then
    kill "$EDGE_PID" 2>/dev/null || true
  fi
  for a in "$APP" "$APP_B"; do
    kubectl delete deployment "$a" "$a-fn-ssr" "$a-fn-middleware" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete service "$a" "$a-fn-ssr" "$a-fn-middleware" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete ingress "$a" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete secret "$a-tls" --ignore-not-found >/dev/null 2>&1 || true
  done
  if [ "$SECOND" = "cloudrun" ]; then
    gcloud run services delete "$APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
    gcloud run services delete "$APP-fn-ssr" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
    gcloud run services delete "$APP-fn-middleware" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
  fi
  rm -f "$EDGE_LOG"
}
trap cleanup EXIT

echo "== building @nbo/cli, @nbo/edge and @nbo/loadtest (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build
pnpm --filter "@nbo/edge..." build
pnpm --filter "@nbo/loadtest..." build
NBO_BIN="node packages/cli/dist/main.js"
EDGE_BIN="${NBO_EDGE_BIN:-node packages/edge/dist/main.js}"
LOADTEST_BIN="node packages/loadtest/dist/main.js"

echo "== building next-app =="
rm -rf fixtures/next-app/.next fixtures/next-app/.nbo
# NEXT_ADAPTER_PATH as the control-plane sets it, so the build writes .nbo/
# whether or not next.config.ts names the adapter itself.
ADAPTER="$(pwd -W 2>/dev/null || pwd)/packages/next-adapter/src/adapter.js"
(cd fixtures/next-app && NEXT_ADAPTER_PATH="${NEXT_ADAPTER_PATH:-$ADAPTER}" pnpm build)

echo "== deploying to kubernetes =="
$NBO_BIN deploy fixtures/next-app/.nbo --app "$APP" --target kubernetes
K8S_URL="https://$APP.127.0.0.1.sslip.io"
sleep 5 # ingress/cert-manager settle, same as every other verify-slice*.sh

if [ "$SECOND" = "cloudrun" ]; then
  echo "== deploying to cloud run =="
  $NBO_BIN deploy fixtures/next-app/.nbo --app "$APP" --target cloudrun
  CLOUDRUN_URL=$(gcloud run services describe "$APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --format='value(status.url)')
else
  echo "== deploying the second backend to kubernetes as $APP_B (NBO_LOADTEST_SECOND=kubernetes) =="
  $NBO_BIN deploy fixtures/next-app/.nbo --app "$APP_B" --target kubernetes
  CLOUDRUN_URL="https://$APP_B.127.0.0.1.sslip.io"
  sleep 5
fi

echo "== confirming both backends are independently healthy =="
k8s_code=$(curl -sk -o /dev/null -w '%{http_code}' "$K8S_URL/api/hello")
cr_code=$(curl -sk -o /dev/null -w '%{http_code}' "$CLOUDRUN_URL/api/hello")
if [ "$k8s_code" != "200" ] || [ "$cr_code" != "200" ]; then
  echo "expected both backends to be healthy before the load test, got k8s=$k8s_code cloudrun=$cr_code" >&2
  exit 1
fi

echo "== starting edge =="
$EDGE_BIN > "$EDGE_LOG" 2>&1 &
EDGE_PID=$!
for i in $(seq 1 10); do
  if curl -s -o /dev/null "http://$ADMIN/targets/nope" && curl -s -o /dev/null "http://$PROXY/"; then
    break
  fi
  if [ "$i" -eq 10 ]; then
    echo "edge never came up" >&2
    cat "$EDGE_LOG" >&2
    exit 1
  fi
  sleep 1
done

echo "== running the real load test: 50 req/sec, 10s/phase, 1% -> 10% -> 50% -> 100% toward cloud run =="
set +e
NBO_LOADTEST_PROXY_URL="http://$PROXY" \
NBO_LOADTEST_HOST="$TEST_HOST" \
NBO_LOADTEST_ADMIN_URL="http://$ADMIN" \
NBO_LOADTEST_K8S_URL="$K8S_URL" \
NBO_LOADTEST_CLOUDRUN_URL="$CLOUDRUN_URL" NBO_LOADTEST_CLOUDRUN_INSECURE="$([ "$SECOND" = "cloudrun" ] || echo 1)" \
$LOADTEST_BIN
loadtest_code=$?
set -e

if [ "$loadtest_code" -ne 0 ]; then
  echo "load test failed — see its output above" >&2
  exit 1
fi

echo "== all checks passed =="
