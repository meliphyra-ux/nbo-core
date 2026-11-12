#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Checks rollout skew handling on the local kind cluster: build B is deployed over build A with
# --carry-from, so A's hashed file (which B does not have) keeps answering from B's pod, and every
# response carries x-nbo-deployment-id equal to B's content id.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=skew
# pwd -W gives a C:/... path on Git Bash, which node and docker accept.
WORK="$(cd "${TMPDIR:-/tmp}" && { pwd -W 2>/dev/null || pwd; })/nbo-skew"
HOST="$APP.127.0.0.1.sslip.io"

cleanup() {
  echo "== cleaning up =="
  kubectl delete deployment,service,ingress,secret "$APP" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete secret "$APP-tls" "$APP-env" --ignore-not-found >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== bootstrapping local cluster (idempotent if already up) =="
./scripts/bootstrap-local-k8s.sh

echo "== building @nbo/cli (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build
NBO_BIN="node packages/cli/dist/main.js"

if [ ! -d fixtures/react-spa/dist ]; then
  echo "== building react-spa =="
  (cd fixtures/react-spa && pnpm build)
fi

echo "== preparing build A and build B under $WORK =="
rm -rf "$WORK"
mkdir -p "$WORK"
cp -r fixtures/react-spa/dist "$WORK/a"
cp -r fixtures/react-spa/dist "$WORK/b"

old_asset=$(cd "$WORK/a/assets" && ls ./*.js | head -1 | sed 's|^\./||')
new_asset="${old_asset%.js}-skew.js"
mv "$WORK/b/assets/$old_asset" "$WORK/b/assets/$new_asset"
sed -i "s|$old_asset|$new_asset|g" "$WORK/b/index.html"
echo "A serves /assets/$old_asset, B serves /assets/$new_asset"

for v in a b; do
  pnpm --filter @nbo/producer-static exec tsx src/cli.ts "$WORK/$v" --out "$WORK/$v/.nbo" --spa
done

echo "== deploying A =="
outA=$($NBO_BIN deploy "$WORK/a/.nbo" --app "$APP")
echo "$outA"

echo "== deploying B over A with --carry-from =="
outB=$($NBO_BIN deploy "$WORK/b/.nbo" --app "$APP" --carry-from "$WORK/a/.nbo")
echo "$outB"
if echo "$outB" | grep -q "already live"; then
  echo "expected B to actually deploy" >&2
  exit 1
fi
idB=$(echo "$outB" | sed -n 's/.*content id \(sha256:[0-9a-f]*\).*/\1/p' | head -1)
if [ -z "$idB" ]; then
  echo "could not read B's content id from the deploy output" >&2
  exit 1
fi

echo "== waiting for ingress/cert-manager to settle =="
sleep 5

fail=0
check() { # description, condition result (0 = ok)
  if [ "$2" -eq 0 ]; then echo "OK   $1"; else echo "FAIL $1" >&2; fail=1; fi
}

echo "== A's file (not in B) answers from the carry =="
hdrA=$(curl -sk -D - -o /dev/null "https://$HOST/assets/$old_asset" | tr -d '\r')
echo "$hdrA"
echo "$hdrA" | head -1 | grep -q " 200" && r=0 || r=1; check "A's file answers 200" $r
echo "$hdrA" | grep -qi '^x-nbo-carried-from:' && r=0 || r=1; check "A's file has x-nbo-carried-from" $r
echo "$hdrA" | grep -i '^cache-control:' | grep -qi immutable && r=0 || r=1; check "A's file is immutable" $r

echo "== B's own file answers without the carry header =="
hdrB=$(curl -sk -D - -o /dev/null "https://$HOST/assets/$new_asset" | tr -d '\r')
echo "$hdrB"
echo "$hdrB" | head -1 | grep -q " 200" && r=0 || r=1; check "B's file answers 200" $r
if echo "$hdrB" | grep -qi '^x-nbo-carried-from:'; then r=1; else r=0; fi
check "B's file has no x-nbo-carried-from" $r

echo "== the deployment id header equals B's content id =="
got=$(curl -sk -D - -o /dev/null "https://$HOST/" | tr -d '\r' | sed -n 's/^[Xx]-[Nn]bo-[Dd]eployment-[Ii]d: *//p')
echo "header: $got  expected: $idB"
[ "$got" = "$idB" ] && r=0 || r=1; check "x-nbo-deployment-id on / is B's content id" $r

if [ "$fail" -ne 0 ]; then
  echo "== skew checks FAILED ==" >&2
  exit 1
fi
echo "== all skew checks passed =="
