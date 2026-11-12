#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== bootstrapping local cluster (idempotent if already up) =="
./scripts/bootstrap-local-k8s.sh

echo "== building @nbo/cli (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build
NBO_BIN="node packages/cli/dist/main.js"

echo "== building react-spa =="
(cd fixtures/react-spa && pnpm build)

echo "== producing static-site =="
rm -rf fixtures/static-site/.nbo
pnpm --filter @nbo/producer-static exec tsx src/cli.ts \
  ../../fixtures/static-site --out ../../fixtures/static-site/.nbo

echo "== producing react-spa =="
rm -rf fixtures/react-spa/.nbo
pnpm --filter @nbo/producer-static exec tsx src/cli.ts \
  ../../fixtures/react-spa/dist --out ../../fixtures/react-spa/.nbo --spa

echo "== deploying static-site (first time: must actually deploy) =="
out1=$($NBO_BIN deploy fixtures/static-site/.nbo --app static-site)
echo "$out1"
if echo "$out1" | grep -q "already live"; then
  echo "expected the FIRST deploy of static-site to actually deploy, not no-op" >&2
  exit 1
fi

echo "== deploying react-spa (first time: must actually deploy) =="
out2=$($NBO_BIN deploy fixtures/react-spa/.nbo --app react-spa)
echo "$out2"
if echo "$out2" | grep -q "already live"; then
  echo "expected the FIRST deploy of react-spa to actually deploy, not no-op" >&2
  exit 1
fi

echo "== waiting for ingress/cert-manager to settle =="
sleep 5

echo "== curling static-site over HTTPS =="
curl -skf "https://static-site.127.0.0.1.sslip.io/" > /dev/null
curl -skf "https://static-site.127.0.0.1.sslip.io/blog/hello" > /dev/null

echo "== curling react-spa over HTTPS, including the deep-link fallback =="
curl -skf "https://react-spa.127.0.0.1.sslip.io/" > /dev/null
curl -skf "https://react-spa.127.0.0.1.sslip.io/about" > /dev/null
curl -skf "https://react-spa.127.0.0.1.sslip.io/settings/profile" > /dev/null
status=$(curl -sk -o /dev/null -w '%{http_code}' "https://react-spa.127.0.0.1.sslip.io/assets/does-not-exist.js")
if [ "$status" != "404" ]; then
  echo "expected 404 for a missing hashed asset, got $status" >&2
  exit 1
fi

echo "== confirming immutable cache headers survive the real deploy =="
real_asset=$(ls fixtures/react-spa/dist/assets/*.js | head -1 | xargs basename)
cache_header=$(curl -sk -D - -o /dev/null "https://react-spa.127.0.0.1.sslip.io/assets/$real_asset" | grep -i '^cache-control:' | tr -d '\r')
echo "$cache_header"
case "$cache_header" in
  *immutable*) ;;
  *) echo "expected an immutable Cache-Control header for a hashed asset, got: $cache_header" >&2; exit 1 ;;
esac

echo "== idempotency: redeploying the exact same content must not touch the cluster =="
rv_before=$(kubectl get deployment static-site -o jsonpath='{.metadata.resourceVersion}')
out3=$($NBO_BIN deploy fixtures/static-site/.nbo --app static-site)
echo "$out3"
if ! echo "$out3" | grep -q "already live"; then
  echo "expected the SECOND deploy of the same content to report already-live" >&2
  exit 1
fi
rv_after=$(kubectl get deployment static-site -o jsonpath='{.metadata.resourceVersion}')
if [ "$rv_before" != "$rv_after" ]; then
  echo "expected resourceVersion to be unchanged on a no-op redeploy, was $rv_before now $rv_after" >&2
  exit 1
fi

echo "== a genuinely different build must actually redeploy =="
echo "<!-- forced content change -->" >> fixtures/static-site/index.html
rm -rf fixtures/static-site/.nbo
pnpm --filter @nbo/producer-static exec tsx src/cli.ts \
  ../../fixtures/static-site --out ../../fixtures/static-site/.nbo
git checkout -- fixtures/static-site/index.html
out4=$($NBO_BIN deploy fixtures/static-site/.nbo --app static-site)
echo "$out4"
if echo "$out4" | grep -q "already live"; then
  echo "expected a genuinely different build to actually redeploy, not no-op" >&2
  exit 1
fi
rv_final=$(kubectl get deployment static-site -o jsonpath='{.metadata.resourceVersion}')
if [ "$rv_before" = "$rv_final" ]; then
  echo "expected resourceVersion to change after a real content change" >&2
  exit 1
fi

echo "== all checks passed =="
