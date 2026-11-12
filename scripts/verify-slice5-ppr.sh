#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail
cd "$(dirname "$0")/.."

# NBO_SKIP_CLOUDRUN=1 runs local serve and Kubernetes only: no GCP
# variables needed, nothing created or deleted in Google Cloud.
SKIP_CLOUDRUN="${NBO_SKIP_CLOUDRUN:-}"
# NBO_SKIP_KUBERNETES=1 skips the kind deploy: no images built or loaded.
SKIP_KUBERNETES="${NBO_SKIP_KUBERNETES:-}"
if [ "$SKIP_CLOUDRUN" != "1" ]; then
  : "${NBO_GCP_PROJECT:?export NBO_GCP_PROJECT first, or set NBO_SKIP_CLOUDRUN=1}"
  : "${NBO_GCP_REGION:?export NBO_GCP_REGION first, or set NBO_SKIP_CLOUDRUN=1}"
  : "${NBO_AR_REPO:?export NBO_AR_REPO first, or set NBO_SKIP_CLOUDRUN=1}"
fi

APP="ppr-app"
NBO_BIN="node packages/cli/dist/main.js"
BYPASS_TOKEN="nbo-slice5-ppr-test-token"
SERVE_PID=""
CACHE_PID=""
HOST_PID=""

cleanup() {
  echo "== tearing down =="
  if [ -n "$SERVE_PID" ]; then
    kill "$SERVE_PID" 2>/dev/null || true
  fi
  if [ -n "$CACHE_PID" ]; then
    kill "$CACHE_PID" 2>/dev/null || true
  fi
  if [ -n "$HOST_PID" ]; then
    kill "$HOST_PID" 2>/dev/null || true
  fi
  if [ "$SKIP_KUBERNETES" != "1" ]; then
    kubectl delete deployment "$APP" "$APP-fn-ssr" "$APP-fn-middleware" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete service "$APP" "$APP-fn-ssr" "$APP-fn-middleware" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete ingress "$APP" --ignore-not-found >/dev/null 2>&1 || true
  fi
  if [ "$SKIP_CLOUDRUN" != "1" ]; then
    gcloud run services delete "$APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
    gcloud run services delete "$APP-fn-ssr" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
    gcloud run services delete "$APP-fn-middleware" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
  fi
}
trap cleanup EXIT

source "$(dirname "$0")/lib-ppr-checks.sh"

echo "== building @nbo/cli (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build
pnpm --filter "@nbo/isrcache" build

echo "== building ppr-app (cacheComponents, a real PARTIALLY_STATIC route) =="
command -v powershell >/dev/null 2>&1 && powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'ppr-app' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
rm -rf fixtures/ppr-app/.next fixtures/ppr-app/.nbo
(cd fixtures/ppr-app && pnpm build)

echo "== conformance: nbo serve (local, with a real cache service) =="
NBO_ISRCACHE_ADDR=127.0.0.1:4110 node packages/isrcache/dist/main.js > /dev/null 2>&1 &
CACHE_PID=$!
SERVE_LOG="$(mktemp)"
NBO_ISRCACHE_URL=http://127.0.0.1:4110 NBO_PRERENDER_BYPASS="$BYPASS_TOKEN" $NBO_BIN serve fixtures/ppr-app/.nbo --port 4109 > "$SERVE_LOG" 2>&1 &
SERVE_PID=$!
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:4109/" || echo 000)
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
$NBO_BIN conformance fixtures/conformance/slice5-ppr http://localhost:4109
echo "== real check: the GET response is one well-formed, resumed document (local) =="
check_resumed_document "http://localhost:4109"
echo "== real check: the shell arrives before the hole (local) =="
check_shell_streams "http://localhost:4109"
echo "== real check: a client-side navigation gets the hole (local) =="
check_client_navigation "http://localhost:4109"
echo "== real check: a server action runs once and changes the page (local) =="
check_server_action "http://localhost:4109"
echo "== real check: an rsc request leaves the cached page alone (local, real cache) =="
check_rsc_leaves_html_alone "http://localhost:4109"
echo "== real check: a hole-less page with a lifetime revalidates (local, real cache) =="
check_lifetime "http://localhost:4109"
echo "== real check: draft mode gets a whole, uncached document (local) =="
check_draft "http://localhost:4109"
echo "== real check: a tampered resume, on real Next =="
check_tampered_resume

kill "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""
kill "$CACHE_PID" 2>/dev/null || true
CACHE_PID=""
rm -f "$SERVE_LOG"

if [ "$SKIP_KUBERNETES" = "1" ]; then
  echo "== kubernetes skipped (NBO_SKIP_KUBERNETES=1) =="
else
  echo "== deploying to kubernetes =="
  $NBO_BIN deploy fixtures/ppr-app/.nbo --app "$APP" --target kubernetes
  K8S_URL="https://$APP.127.0.0.1.sslip.io"
  sleep 5
  echo "== conformance: kubernetes =="
  $NBO_BIN conformance fixtures/conformance/slice5-ppr "$K8S_URL" --insecure
  echo "== real check: the GET response is one well-formed, resumed document (kubernetes) =="
  check_resumed_document "$K8S_URL" --insecure
  echo "== real check: the shell arrives before the hole (kubernetes) =="
  check_shell_streams "$K8S_URL" --insecure
  echo "== real check: a client-side navigation gets the hole (kubernetes) =="
  check_client_navigation "$K8S_URL" --insecure
  echo "== real check: a server action runs once and changes the page (kubernetes) =="
  check_server_action "$K8S_URL" --insecure
fi

if [ "$SKIP_CLOUDRUN" = "1" ]; then
  echo "== cloud run skipped (NBO_SKIP_CLOUDRUN=1) =="
else
  echo "== deploying to cloud run =="
  $NBO_BIN deploy fixtures/ppr-app/.nbo --app "$APP" --target cloudrun
  CLOUDRUN_URL=$(gcloud run services describe "$APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --format='value(status.url)')
  echo "== conformance: cloud run =="
  $NBO_BIN conformance fixtures/conformance/slice5-ppr "$CLOUDRUN_URL"
  echo "== real check: the GET response is one well-formed, resumed document (cloud run) =="
  check_resumed_document "$CLOUDRUN_URL"
  echo "== real check: the shell arrives before the hole (cloud run) =="
  check_shell_streams "$CLOUDRUN_URL"
  echo "== real check: a client-side navigation gets the hole (cloud run) =="
  check_client_navigation "$CLOUDRUN_URL"
  echo "== real check: a server action runs once and changes the page (cloud run) =="
  check_server_action "$CLOUDRUN_URL"
fi

echo "== all checks passed =="
