#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Deletes the ISR cache service (left running by
# verify-slice4-isr-cache.sh across however many local/cloud attempts
# it took) and any leftover app deployments — idempotent, safe to run
# even if verify-slice4-isr-cloud.sh's own exit trap already cleaned
# the app half up.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NBO_GCP_PROJECT:?export NBO_GCP_PROJECT first}"
: "${NBO_GCP_REGION:?export NBO_GCP_REGION first}"

APP="isr-next-app"
CACHE_SERVICE="isr-cache-service"

echo "== deleting the ISR cache service =="
gcloud run services delete "$CACHE_SERVICE" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true

echo "== deleting any leftover app deployments =="
kubectl delete deployment "$APP" "$APP-fn-ssr" "$APP-fn-middleware" --ignore-not-found >/dev/null 2>&1 || true
kubectl delete service "$APP" "$APP-fn-ssr" "$APP-fn-middleware" --ignore-not-found >/dev/null 2>&1 || true
kubectl delete ingress "$APP" --ignore-not-found >/dev/null 2>&1 || true
gcloud run services delete "$APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
gcloud run services delete "$APP-fn-ssr" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
gcloud run services delete "$APP-fn-middleware" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true

rm -f /tmp/nbo-isr-cache-url.txt
echo "== done =="
