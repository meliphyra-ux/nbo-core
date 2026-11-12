#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Real, end-to-end verification for Slice 4's "crons" item: drives the
# real control-plane HTTP API (not `nbo deploy` directly — that path
# never touches @nbo/controlplane's own Orchestrator, so it would
# never generate a cron signing secret, bake it, or register/run
# crons at all) to deploy a real Next.js app with a real cron entry
# on both Kubernetes and Cloud Run, then waits for the real Scheduler
# loop (running inside @nbo/controlplane's own main.ts, 30s ticks) to
# actually fire a signed request at the deployed app and observes the
# result through an ordinary HTTP GET — no log-scraping, no internal
# access.
#
# TS rewrite: this script originally built and ran cmd/nbo and
# cmd/control-plane (Go binaries) — both are now retired in favor of
# @nbo/cli and @nbo/controlplane's own dist/main.js, built here the
# same dependency-inclusive way scripts/verify-ts-cli.sh established
# (sub-project 8's own C1 finding: a stale dist/ anywhere in the
# dependency graph is silently used as-is, so every workspace
# dependency gets rebuilt, not just the leaf package).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NBO_GCP_PROJECT:?export NBO_GCP_PROJECT first}"
: "${NBO_GCP_REGION:?export NBO_GCP_REGION first}"
: "${NBO_AR_REPO:?export NBO_AR_REPO first}"

NBO_BIN="node packages/cli/dist/main.js"
CP_BIN="node packages/controlplane/dist/main.js"
CP_DB="$(mktemp -d)/control-plane.db"
CP_ADDR="127.0.0.1:18081"
CP_PID=""
K8S_APP=""
CLOUDRUN_APP=""
PATCH_SCRIPT="$(mktemp --suffix=.js)"
APP_NAME_SCRIPT="$(mktemp --suffix=.js)"

cleanup() {
  echo "== tearing down =="
  if [ -n "$CP_PID" ]; then
    kill "$CP_PID" 2>/dev/null || true
  fi
  if [ -n "$K8S_APP" ]; then
    kubectl delete deployment "$K8S_APP" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete service "$K8S_APP" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete ingress "$K8S_APP" --ignore-not-found >/dev/null 2>&1 || true
  fi
  if [ -n "$CLOUDRUN_APP" ]; then
    gcloud run services delete "$CLOUDRUN_APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
  fi
  rm -f "$PATCH_SCRIPT" "$APP_NAME_SCRIPT"
  rm -rf "$(dirname "$CP_DB")"
}
trap cleanup EXIT

# patch-manifest-crons.js <manifest-path>: appends one cron entry
# targeting the "ssr" function's own /api/cron-ping route — the Next
# adapter has no native cron concept (nothing in Next.js maps to one),
# so this is the one place a cron gets declared for this fixture.
# Takes the path as a real argv entry, not interpolated into a -e
# string — a bash-expanded path embedded in a node -e string is
# misread by node's own non-MSYS-aware path handling, a real bug this
# session already found and fixed the same way in
# scripts/verify-slice4-env.sh's own MUTATE_SCRIPT.
cat > "$PATCH_SCRIPT" <<'EOF'
const fs = require("fs");
const [, , path] = process.argv;
const m = JSON.parse(fs.readFileSync(path, "utf8"));
m.crons = [
  {
    id: "ping",
    schedule: "* * * * *",
    target: { function: "ssr", path: "/api/cron-ping", method: "POST" },
    overlap: "skip",
    timeoutSec: 30,
  },
];
// This fixture's own ISR/image capabilities (from earlier,
// unfinished real-E2E work) aren't yet supported/emulated by either
// cloud adapter — unrelated to crons, which this test doesn't
// exercise, so strip them here rather than block on a separate,
// pre-existing gap.
if (m.requires && Array.isArray(m.requires.capabilities)) {
  m.requires.capabilities = m.requires.capabilities.filter(
    (c) => !["images.optimize", "prerender.isr", "prerender.onDemand"].includes(c)
  );
}
fs.writeFileSync(path, JSON.stringify(m));
EOF

# deploy-app-name.js <projectId> <envName>: mirrors
# packages/controlplane/src/deploy.ts's own deployAppName exactly —
# computed here instead of guessed with a bash substring, so a future
# id-format change can't silently desync this script's own cleanup
# target from the real one the control plane deployed.
cat > "$APP_NAME_SCRIPT" <<'EOF'
const [, , projectId, envName] = process.argv;
let suffix = projectId;
const idx = suffix.lastIndexOf("_");
if (idx !== -1) suffix = suffix.slice(idx + 1);
if (suffix.length > 8) suffix = suffix.slice(0, 8);
console.log(`p${suffix}-${envName}`);
EOF

echo "== building @nbo/cli and @nbo/controlplane (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build
pnpm --filter "@nbo/controlplane..." build

echo "== building fixtures/next-app =="
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'next-app' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
rm -rf fixtures/next-app/.next fixtures/next-app/.nbo
(cd fixtures/next-app && pnpm build)

node "$PATCH_SCRIPT" "$(pwd)/fixtures/next-app/.nbo/manifest.json"
$NBO_BIN validate fixtures/next-app/.nbo
echo "patched manifest (with a real cron entry) passes nbo validate: ok"

NBO_DIR_WIN="$(cygpath -w "$(pwd)/fixtures/next-app/.nbo")"

echo "== starting @nbo/controlplane =="
NBO_CONTROL_PLANE_DB="$CP_DB" NBO_CONTROL_PLANE_ADDR="$CP_ADDR" $CP_BIN &
CP_PID=$!
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://$CP_ADDR/projects"; then break; fi
  sleep 1
done

# wait_for_cron_hit <url>: polls GET <url>/api/cron-ping for up to 150s
# (the scheduler ticks every 30s and the cron's own schedule is
# "every minute" — both granularities fit comfortably inside that
# window) for hits >= 1 — the only observable proof that Tick really
# found the due cron, signed a request, and the deployed function
# verified that signature for real.
wait_for_cron_hit() {
  local url="$1"; shift
  local insecure_flag=""
  if [[ "$url" == *sslip.io* ]]; then insecure_flag="-k"; fi
  for i in $(seq 1 30); do
    local body
    body=$(curl -s $insecure_flag --max-time 5 "$url/api/cron-ping" || true)
    if echo "$body" | grep -q '"hits":[1-9]'; then
      echo "cron fired and the function verified its signature: ok ($body)"
      return 0
    fi
    sleep 5
  done
  echo "expected at least 1 verified cron hit at $url/api/cron-ping within the timeout, last body: $body" >&2
  return 1
}

# ---------------------------------------------------------------------
# Kubernetes
# ---------------------------------------------------------------------
echo "== kubernetes: project, environment, deploy =="
proj=$(curl -s -X POST "http://$CP_ADDR/projects" -d '{"name":"cron-verify-k8s"}')
proj_id=$(node -p "JSON.parse(process.argv[1]).id" "$proj")
env=$(curl -s -X POST "http://$CP_ADDR/projects/$proj_id/environments" -d '{"name":"production","target":"kubernetes"}')
env_id=$(node -p "JSON.parse(process.argv[1]).id" "$env")

dep=$(curl -s -X POST "http://$CP_ADDR/environments/$env_id/deployments" \
  --data-binary "$(node -p "JSON.stringify({nboDir: process.argv[1]})" "$NBO_DIR_WIN")")
dep_status=$(node -p "JSON.parse(process.argv[1]).status" "$dep")
dep_url=$(node -p "JSON.parse(process.argv[1]).url" "$dep")
K8S_APP=$(node "$APP_NAME_SCRIPT" "$proj_id" "production")
if [ "$dep_status" != "succeeded" ]; then
  echo "expected a succeeded kubernetes deployment, got: $dep" >&2
  exit 1
fi
echo "real control-plane deploy succeeded (kubernetes): $dep_url"
wait_for_cron_hit "$dep_url"

# ---------------------------------------------------------------------
# Cloud Run
# ---------------------------------------------------------------------
echo "== cloud run: project, environment, deploy =="
proj2=$(curl -s -X POST "http://$CP_ADDR/projects" -d '{"name":"cron-verify-cr"}')
proj2_id=$(node -p "JSON.parse(process.argv[1]).id" "$proj2")
cr_config=$(node -p "JSON.stringify({project: process.argv[1], region: process.argv[2], arRepo: process.argv[3]})" \
  "$NBO_GCP_PROJECT" "$NBO_GCP_REGION" "$NBO_AR_REPO")
env2=$(curl -s -X POST "http://$CP_ADDR/projects/$proj2_id/environments" \
  --data-binary "$(node -p "JSON.stringify({name: 'production', target: 'cloudrun', config: JSON.parse(process.argv[1])})" "$cr_config")")
env2_id=$(node -p "JSON.parse(process.argv[1]).id" "$env2")

dep2=$(curl -s -X POST "http://$CP_ADDR/environments/$env2_id/deployments" \
  --data-binary "$(node -p "JSON.stringify({nboDir: process.argv[1]})" "$NBO_DIR_WIN")")
dep2_status=$(node -p "JSON.parse(process.argv[1]).status" "$dep2")
dep2_url=$(node -p "JSON.parse(process.argv[1]).url" "$dep2")
CLOUDRUN_APP=$(node "$APP_NAME_SCRIPT" "$proj2_id" "production")
if [ "$dep2_status" != "succeeded" ]; then
  echo "expected a succeeded cloud run deployment, got: $dep2" >&2
  exit 1
fi
echo "real control-plane deploy succeeded (cloud run): $dep2_url"
wait_for_cron_hit "$dep2_url"

echo "== all checks passed =="
