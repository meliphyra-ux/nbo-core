#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail
cd "$(dirname "$0")/.."

# Real end-to-end verification of the new TS `nbo` CLI (packages/cli)
# against the local kind cluster — this sub-project's own closing
# proof that the TS binaries actually replace the Go ones for real
# traffic, matching this rewrite's own precedent of ending in a real
# infrastructure check (scripts/verify-slice1.sh is this script's own
# style reference). Deliberately the simplest fixture (static-site: no
# SSR function, no image resize, no ISR) — it isolates this specific
# sub-project's own real change (the Node-base-image Dockerfile, the
# new @nbo/cli binary) from every other sub-project's already
# separately verified behavior. This script does NOT itself prove the
# outbound-HTTPS/CA-certificate fact — @nbo/adapter-k8s's own
# image.test.ts "includes CA certificates for outbound HTTPS" test
# (against a real build) is what proves that; this fixture has no
# remote fetch to exercise it.

APP="ts-cli-verify"
NBO_DIR="fixtures/static-site/.nbo-ts-cli-verify"
# A real scratch copy of the fixture, not the committed source tree —
# final-review finding I5: mutating fixtures/static-site/index.html
# in place and relying on `git checkout --` to undo it leaves the
# fixture dirty (and discards any real uncommitted edit to that file)
# if the script dies between the two.
SCRATCH_SITE="$(mktemp -d)"

cleanup() {
  rm -rf "$NBO_DIR" "$SCRATCH_SITE"
}
trap cleanup EXIT

echo "== bootstrapping local cluster (idempotent if already up) =="
./scripts/bootstrap-local-k8s.sh

echo "== building @nbo/cli and its own dependencies =="
# Final-review finding C1: "pnpm --filter @nbo/cli build" alone does
# NOT rebuild @nbo/cli's own workspace dependencies — a stale dist/
# anywhere in that graph (confirmed directly: @nbo/deploy's and
# @nbo/adapter-k8s's own dist/ were stale here, from before this
# sub-project's own Dockerfile-swap commit, the first time this
# script ran) is silently deployed as-is. prepareCliDeployDir
# (packages/deploy/src/kubernetes-target.ts) now rebuilds this same
# graph itself before every real `pnpm deploy`, so this step is
# defense in depth, not the only fix.
pnpm --filter "@nbo/cli..." build

echo "== producing static-site's own .nbo build (from a scratch copy of the fixture) =="
cp -r fixtures/static-site/. "$SCRATCH_SITE/"
rm -rf "$SCRATCH_SITE/.nbo-ts-cli-verify"
pnpm --filter @nbo/producer-static exec tsx src/cli.ts \
  "$SCRATCH_SITE" --out "../../$NBO_DIR"

echo "== deploying static-site with the new TS nbo CLI (first time: must actually deploy) =="
out1=$(node packages/cli/dist/main.js deploy "$NBO_DIR" --app "$APP")
echo "$out1"
if echo "$out1" | grep -q "already live"; then
  echo "expected the FIRST deploy of $APP to actually deploy, not no-op" >&2
  exit 1
fi

echo "== waiting for ingress/cert-manager to settle =="
sleep 5

echo "== confirming the deployed pod is actually running the new Node-based image, not a stale Go one =="
# Final-review finding C1: the only way to be sure this real deploy
# used the Node-based appDockerfile (not a `FROM scratch` image built
# from stale compiled output, which happened the first time this
# script ran) is to inspect the real, live image.
image_ref=$(kubectl get deployment "$APP" -o jsonpath='{.spec.template.spec.containers[0].image}')
entrypoint=$(docker image inspect "$image_ref" --format '{{json .Config.Entrypoint}}')
echo "image $image_ref entrypoint: $entrypoint"
case "$entrypoint" in
  *'"node"'*) ;;
  *) echo "expected the deployed image's ENTRYPOINT to run node, got: $entrypoint" >&2; exit 1 ;;
esac

echo "== curling the index page over HTTPS =="
curl -skf "https://$APP.127.0.0.1.sslip.io/" > /dev/null

echo "== confirming the right content-type and cache policy on a static (unhashed) asset =="
headers=$(curl -sk -D - -o /dev/null "https://$APP.127.0.0.1.sslip.io/_assets/app.css")
echo "$headers"
echo "$headers" | grep -iq '^content-type: *text/css' || {
  echo "expected a text/css content-type for /_assets/app.css" >&2
  exit 1
}
echo "$headers" | grep -iq 'must-revalidate' || {
  echo "expected a revalidate cache policy (max-age=0, must-revalidate) for an unhashed static file" >&2
  exit 1
}

echo "== idempotency: redeploying the exact same content must not touch the cluster =="
rv_before=$(kubectl get deployment "$APP" -o jsonpath='{.metadata.resourceVersion}')
out2=$(node packages/cli/dist/main.js deploy "$NBO_DIR" --app "$APP")
echo "$out2"
if ! echo "$out2" | grep -q "already live"; then
  echo "expected the SECOND deploy of the same content to report already-live" >&2
  exit 1
fi
rv_after=$(kubectl get deployment "$APP" -o jsonpath='{.metadata.resourceVersion}')
if [ "$rv_before" != "$rv_after" ]; then
  echo "expected resourceVersion to be unchanged on a no-op redeploy, was $rv_before now $rv_after" >&2
  exit 1
fi

echo "== a genuinely different build must actually redeploy, and serve the new content =="
marker="forced-content-change-$(date +%s)"
echo "<!-- $marker -->" >> "$SCRATCH_SITE/index.html"
rm -rf "$NBO_DIR"
pnpm --filter @nbo/producer-static exec tsx src/cli.ts \
  "$SCRATCH_SITE" --out "../../$NBO_DIR"
out3=$(node packages/cli/dist/main.js deploy "$NBO_DIR" --app "$APP")
echo "$out3"
if echo "$out3" | grep -q "already live"; then
  echo "expected a genuinely different build to actually redeploy, not no-op" >&2
  exit 1
fi
rv_final=$(kubectl get deployment "$APP" -o jsonpath='{.metadata.resourceVersion}')
if [ "$rv_before" = "$rv_final" ]; then
  echo "expected resourceVersion to change after a real content change" >&2
  exit 1
fi

echo "== waiting for the redeploy's own rollout to settle =="
sleep 5
# Final-review finding I5: a resourceVersion change alone doesn't
# prove the NEW content is actually being served — curl for the
# marker itself, against the real live endpoint.
curl -skf "https://$APP.127.0.0.1.sslip.io/" | grep -qF "$marker" || {
  echo "expected the redeployed index page to contain the new marker comment" >&2
  exit 1
}

echo "== all checks passed =="
