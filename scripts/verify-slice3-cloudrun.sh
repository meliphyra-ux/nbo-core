#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NBO_GCP_PROJECT:?export NBO_GCP_PROJECT first}"
: "${NBO_GCP_REGION:?export NBO_GCP_REGION first}"
: "${NBO_AR_REPO:?export NBO_AR_REPO first}"

cleanup() {
  echo "== tearing down cloud run services =="
  gcloud run services delete next-app --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet || true
  gcloud run services delete next-app-fn-ssr --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet || true
}
trap cleanup EXIT

echo "== building @nbo/cli (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build
NBO_BIN="node packages/cli/dist/main.js"

echo "== building next-app =="
rm -rf fixtures/next-app/.next fixtures/next-app/.nbo
(cd fixtures/next-app && pnpm build)

echo "== deploying next-app to cloud run (first time: must actually deploy) =="
out1=$($NBO_BIN deploy fixtures/next-app/.nbo --app next-app --target cloudrun)
echo "$out1"
if echo "$out1" | grep -q "already live"; then
  echo "expected the FIRST deploy to actually deploy, not no-op" >&2
  exit 1
fi

url=$(gcloud run services describe next-app --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --format='value(status.url)')

echo "== conformance against the real cloud run service =="
# The function's roles/run.invoker grant (adapters/cloudrun.GrantInvoker,
# just applied by the deploy above) can take Cloud Run's own documented
# edge-propagation delay — observed for real against this project as
# well over a minute, not the few-seconds-to-tens-of-seconds Google's
# own docs suggest as typical — before every request stops getting
# rejected. funcproxy's own per-request retry is
# deliberately short (internal/funcproxy/cloudrun.go) because a longer
# one destabilizes a cold-starting instance's first request and
# cascades into "no available instance" 429s (see
# docs/points-to-improve-or-fix.md).
#
# An earlier version of this wait ran the full 3-request conformance
# suite every 5s until it passed — found for real to make things worse,
# not better: retrying that aggressively while the service was already
# in a "no available instance" cold-start spiral fed the spiral instead
# of waiting it out, extending the storm across the whole retry window
# instead of a transient blip. This probes with exactly one lightweight
# request, spaced well apart, and only runs the real (unretried)
# conformance suite once that single probe succeeds.
probe_attempt=0
probe_max_attempts=12
while true; do
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url/api/hello" || true)
  if [ "$status" = "200" ]; then
    break
  fi
  probe_attempt=$((probe_attempt + 1))
  if [ "$probe_attempt" -ge "$probe_max_attempts" ]; then
    echo "cloud run never became ready after ${probe_max_attempts} probes (~3min) — last probe got $status, see docs/points-to-improve-or-fix.md on IAM/edge propagation delay" >&2
    exit 1
  fi
  echo "not ready yet (probe $probe_attempt/$probe_max_attempts, got $status) — waiting 15s before the next single probe..."
  sleep 15
done

$NBO_BIN conformance fixtures/conformance/slice2 "$url"

echo "== streaming timing check: /api/stream must take measurably longer than an instant =="
start=$(date +%s%N)
curl -s -o /dev/null "$url/api/stream"
elapsed_ms=$(( ($(date +%s%N) - start) / 1000000 ))
echo "elapsed: ${elapsed_ms}ms"
if [ "$elapsed_ms" -lt 200 ]; then
  echo "expected /api/stream to take >= 200ms — buffering may have reappeared" >&2
  exit 1
fi

echo "== idempotency: redeploying the exact same content must not touch cloud run =="
out2=$($NBO_BIN deploy fixtures/next-app/.nbo --app next-app --target cloudrun)
echo "$out2"
if ! echo "$out2" | grep -q "already live"; then
  echo "expected the second deploy of the same content to be a no-op" >&2
  exit 1
fi

echo "== the function service must genuinely require authentication =="
fn_url=$(gcloud run services describe next-app-fn-ssr --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --format='value(status.url)')
status=$(curl -s -o /dev/null -w '%{http_code}' "$fn_url/")
if [ "$status" != "403" ] && [ "$status" != "401" ]; then
  echo "expected an unauthenticated request straight to the function service to be rejected (401/403), got $status — the public hole this plan exists to close is open" >&2
  exit 1
fi

echo "== all checks passed =="
