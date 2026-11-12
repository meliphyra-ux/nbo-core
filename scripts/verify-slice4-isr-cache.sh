#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Deploys the ISR cache service once, to Cloud Run — the only way a
# Kubernetes pod and a Cloud Run app can both reach one, genuinely
# shared instance (deployed separately, like the edge and the
# control-plane). This is the slow, one-time part of the real Slice 4 ISR
# verification — split out from verify-slice4-isr-local.sh and
# verify-slice4-isr-cloud.sh so a failure in either of those doesn't
# force a redeploy of this one too. The cache service is left RUNNING
# when this script exits (its URL saved to /tmp/nbo-isr-cache-url.txt)
# — tear it down explicitly with verify-slice4-isr-teardown.sh when
# you're done with the whole verification, not after every attempt.
#
# TS rewrite: originally built cmd/isrcache (a Go binary, GOOS=linux
# GOARCH=amd64, docker-built via scripts/isrcache.Dockerfile) — now
# @nbo/isrcache's own dist/main.js, built here the same dependency-
# inclusive way scripts/verify-ts-cli.sh established. @nbo/isrcache
# is pure in-memory JS with no native dependencies at all (confirmed
# directly: store.ts has no sqlite, no native addon — just
# @nbo/nodehost), so a plain pnpm deploy needs none of the hoisted-
# linker/cross-platform-flag machinery @nbo/cli's own prepareCliDeployDir
# needed for ajv/sharp/re2; used anyway for consistency, not because
# it's strictly required here.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NBO_GCP_PROJECT:?export NBO_GCP_PROJECT first}"
: "${NBO_GCP_REGION:?export NBO_GCP_REGION first}"
: "${NBO_AR_REPO:?export NBO_AR_REPO first}"

CACHE_SERVICE="isr-cache-service"
URL_FILE="/tmp/nbo-isr-cache-url.txt"
DEPLOY_DIR=""
BUILD_CTX=""

cleanup() {
  rm -rf "$DEPLOY_DIR" "$BUILD_CTX"
}
trap cleanup EXIT

echo "== building @nbo/isrcache (dependency-inclusive) =="
pnpm --filter "@nbo/isrcache..." build

echo "== deploying a self-contained @nbo/isrcache artifact =="
DEPLOY_DIR="$(mktemp -d)"
pnpm --filter @nbo/isrcache deploy --prod --os=linux --cpu=x64 --libc=glibc --config.node-linker=hoisted "$DEPLOY_DIR"

echo "== building and pushing the cache service image =="
BUILD_CTX="$(mktemp -d)"
cp -rL "$DEPLOY_DIR"/* "$BUILD_CTX/"
cat > "$BUILD_CTX/Dockerfile" <<'EOF'
FROM node:24-slim
COPY . /app
WORKDIR /app
ENTRYPOINT ["node", "dist/main.js"]
EOF
LOCAL_TAG="nbo-isrcache:latest"
REMOTE_TAG="$NBO_AR_REPO/nbo-isrcache:$(date -u +%Y%m%d%H%M%S)"
docker build -t "$LOCAL_TAG" "$BUILD_CTX"
docker tag "$LOCAL_TAG" "$REMOTE_TAG"
docker push "$REMOTE_TAG"

echo "== deploying to Cloud Run =="
# Public: neither the Kubernetes-hosted app instance nor the Cloud-Run-
# hosted one carries a GCP identity suitable for both directions (a k8s
# pod has none at all), so this instance's own API stays unauthenticated
# — acceptable for this throwaway, explicitly-torn-down verification
# instance; @nbo/isrcache's own "no auth yet" scope cut already
# anticipated this, same as @nbo/edge/@nbo/controlplane's.
gcloud run deploy "$CACHE_SERVICE" --image="$REMOTE_TAG" \
  --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" \
  --allow-unauthenticated --quiet >/dev/null
CACHE_URL=$(gcloud run services describe "$CACHE_SERVICE" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --format='value(status.url)')

echo "== settling (Cloud Run cold start) =="
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$CACHE_URL/entries/nope" || echo 000)
  if [ "$code" == "404" ]; then
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "cache service never settled (last status $code)" >&2
    exit 1
  fi
  sleep 1
done

echo "$CACHE_URL" > "$URL_FILE"
echo "== cache service live at $CACHE_URL (saved to $URL_FILE) =="
echo "== next: scripts/verify-slice4-isr-local.sh, then scripts/verify-slice4-isr-cloud.sh =="
