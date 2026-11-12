#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NBO_GCP_PROJECT:?export NBO_GCP_PROJECT first}"
: "${NBO_GCP_REGION:?export NBO_GCP_REGION first}"
: "${NBO_AR_REPO:?export NBO_AR_REPO first}"

APP="edge-next-app"
TEST_HOST="edge-test.local"
ADMIN="localhost:9444"
PROXY="localhost:9443"
EDGE_PID=""
EDGE_LOG="$(mktemp)"

cleanup() {
  echo "== tearing down =="
  if [ -n "$EDGE_PID" ]; then
    kill "$EDGE_PID" 2>/dev/null || true
  fi
  kubectl delete deployment "$APP" "$APP-fn-ssr" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete service "$APP" "$APP-fn-ssr" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete ingress "$APP" --ignore-not-found >/dev/null 2>&1 || true
  gcloud run services delete "$APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
  gcloud run services delete "$APP-fn-ssr" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
  rm -f "$EDGE_LOG"
}
trap cleanup EXIT

echo "== building @nbo/cli and @nbo/edge (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build
pnpm --filter "@nbo/edge..." build
NBO_BIN="node packages/cli/dist/main.js"
EDGE_BIN="${NBO_EDGE_BIN:-node packages/edge/dist/main.js}"

echo "== building next-app =="
rm -rf fixtures/next-app/.next fixtures/next-app/.nbo
(cd fixtures/next-app && pnpm build)

echo "== deploying to kubernetes =="
$NBO_BIN deploy fixtures/next-app/.nbo --app "$APP" --target kubernetes
K8S_URL="https://$APP.127.0.0.1.sslip.io"
sleep 5 # ingress/cert-manager settle, same as every other verify-slice*.sh

echo "== deploying to cloud run =="
$NBO_BIN deploy fixtures/next-app/.nbo --app "$APP" --target cloudrun
CLOUDRUN_URL=$(gcloud run services describe "$APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --format='value(status.url)')

echo "== confirming both backends are independently healthy =="
k8s_code=$(curl -sk -o /dev/null -w '%{http_code}' "$K8S_URL/api/hello")
cr_code=$(curl -sk -o /dev/null -w '%{http_code}' "$CLOUDRUN_URL/api/hello")
if [ "$k8s_code" != "200" ] || [ "$cr_code" != "200" ]; then
  echo "expected both backends to be healthy before the shift, got k8s=$k8s_code cloudrun=$cr_code" >&2
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

set_weights() {
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://$ADMIN/targets/$TEST_HOST" -d \
    "{\"backends\":[{\"url\":\"$K8S_URL\",\"weight\":$1,\"insecureSkipVerify\":true},{\"url\":\"$CLOUDRUN_URL\",\"weight\":$2}]}")
  if [ "$code" != "204" ]; then
    echo "expected 204 setting weights k8s=$1 cloudrun=$2, got $code — a silently-rejected PUT would leave the previous split in place" >&2
    exit 1
  fi
}

# send_requests N — fires N requests and prints "failures k8s_hits cloudrun_hits",
# using the edge layer's own X-Nbo-Edge-Backend response header to prove
# which backend actually served each one, not just that some backend did.
send_requests() {
  local n="$1" failures=0 k8s_hits=0 cr_hits=0
  for i in $(seq 1 "$n"); do
    headers=$(curl -s -D - -o /dev/null --max-time 15 -H "Host: $TEST_HOST" "http://$PROXY/api/hello")
    code=$(echo "$headers" | head -1 | tr -d '\r' | awk '{print $2}')
    backend=$(echo "$headers" | grep -i '^X-Nbo-Edge-Backend:' | sed -E 's/^[^:]+: *//' | tr -d '\r')
    if [ "$code" != "200" ]; then
      failures=$((failures + 1))
      echo "  request $i: got $code" >&2
    fi
    case "$backend" in
    "$K8S_URL") k8s_hits=$((k8s_hits + 1)) ;;
    "$CLOUDRUN_URL") cr_hits=$((cr_hits + 1)) ;;
    esac
  done
  echo "$failures $k8s_hits $cr_hits"
}

echo "== walking the shift 1% -> 10% -> 50% -> 100% toward cloud run (Slice 3's own done-when gate) =="
total_failures=0
for split in "99 1" "90 10" "50 50" "0 100"; do
  k8s_weight=$(echo "$split" | cut -d' ' -f1)
  cr_weight=$(echo "$split" | cut -d' ' -f2)
  echo "-- weights: kubernetes=$k8s_weight cloudrun=$cr_weight --"
  set_weights "$k8s_weight" "$cr_weight"
  read -r failures k8s_hits cr_hits <<<"$(send_requests 10)"
  echo "  k8s_hits=$k8s_hits cloudrun_hits=$cr_hits"
  total_failures=$((total_failures + failures))
  # At the far ends of the shift, prove the split is actually honored,
  # not just that some backend answered: a fully-drained side must get
  # zero hits, a near-full side must get (almost) all of them.
  if [ "$k8s_weight" = "0" ] && [ "$k8s_hits" -ne 0 ]; then
    echo "expected kubernetes to be fully drained at weight 0, got $k8s_hits hits" >&2
    exit 1
  fi
  if [ "$cr_weight" = "0" ] && [ "$cr_hits" -ne 0 ]; then
    echo "expected cloud run to be fully drained at weight 0, got $cr_hits hits" >&2
    exit 1
  fi
  if [ "$k8s_weight" = "99" ] && [ "$k8s_hits" -lt 9 ]; then
    echo "expected at least 9/10 requests to kubernetes at a 99% weight, got $k8s_hits" >&2
    exit 1
  fi
done

if [ "$total_failures" -ne 0 ]; then
  echo "expected zero failed requests across the whole shift, got $total_failures" >&2
  exit 1
fi

echo "== all checks passed =="
