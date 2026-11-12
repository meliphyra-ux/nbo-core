#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Real, end-to-end verification for Slice 4's "Git integration and a
# build runner" item: drives the real control-plane HTTP API to
# configure a project's git settings, then simulates a real GitHub
# webhook delivery (a correctly HMAC-signed push payload — this
# script knows the shared secret, since it's the one who configured
# it, the same way a real GitHub webhook configuration page would)
# against a real local git repo. No GitHub account needed: git itself
# doesn't care where a repo lives, and the webhook's own signature
# verification is the only thing standing between "a request claiming
# to be GitHub" and "a request GitHub actually sent" — simulating it
# correctly proves the real verification code path, not a stand-in
# for it.
set -euo pipefail
cd "$(dirname "$0")/.."

CP_BIN="node packages/controlplane/dist/main.js"
CP_DB="$(mktemp -d)/control-plane.db"
CP_ADDR="127.0.0.1:18082"
CP_PID=""
K8S_APP=""
GIT_REPO_DIR=""
SIGN_SCRIPT="$(mktemp --suffix=.js)"

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
  rm -f "$SIGN_SCRIPT"
  rm -rf "$(dirname "$CP_DB")" "$GIT_REPO_DIR"
}
trap cleanup EXIT

# sign-payload.js <secret> <payload-file>: prints a real
# X-Hub-Signature-256 value for the exact bytes in payload-file — a
# separate file, not a bash variable interpolated into a -e string,
# so the signed bytes are exactly the bytes curl later sends with
# --data-binary (no shell-quoting discrepancy between the two).
cat > "$SIGN_SCRIPT" <<'EOF'
const { createHmac } = require("crypto");
const fs = require("fs");
const [, , secret, payloadFile] = process.argv;
const body = fs.readFileSync(payloadFile);
console.log(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
EOF

echo "== building a real local git fixture repo (no GitHub needed) =="
GIT_REPO_DIR="$(mktemp -d)"
git -C "$GIT_REPO_DIR" init -q -b main
git -C "$GIT_REPO_DIR" config user.email "verify@example.com"
git -C "$GIT_REPO_DIR" config user.name "verify"
echo "<h1>git-integration-e2e</h1>" > "$GIT_REPO_DIR/index.html"
echo '{"name":"fixture"}' > "$GIT_REPO_DIR/package.json"
git -C "$GIT_REPO_DIR" add .
git -C "$GIT_REPO_DIR" commit -q -m "initial"
REVISION="$(git -C "$GIT_REPO_DIR" rev-parse HEAD)"
echo "fixture repo at $GIT_REPO_DIR, HEAD $REVISION"

echo "== building @nbo/controlplane (dependency-inclusive) =="
pnpm --filter "@nbo/controlplane..." build

echo "== starting @nbo/controlplane =="
NBO_CONTROL_PLANE_DB="$CP_DB" NBO_CONTROL_PLANE_ADDR="$CP_ADDR" $CP_BIN &
CP_PID=$!
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://$CP_ADDR/projects"; then break; fi
  sleep 1
done

echo "== project, production environment, git config =="
proj=$(curl -s -X POST "http://$CP_ADDR/projects" -d '{"name":"git-verify"}')
proj_id=$(node -p "JSON.parse(process.argv[1]).id" "$proj")
env=$(curl -s -X POST "http://$CP_ADDR/projects/$proj_id/environments" -d '{"name":"production","target":"kubernetes"}')
env_id=$(node -p "JSON.parse(process.argv[1]).id" "$env")
K8S_APP=$(node -p "'p' + process.argv[1].slice(process.argv[1].lastIndexOf('_') + 1, process.argv[1].lastIndexOf('_') + 9) + '-production'" "$proj_id")

git_config=$(node -p "JSON.stringify({repo: process.argv[1], productionBranch: 'main', framework: 'static', buildCommand: 'mkdir dist && copy index.html dist\\\\index.html', outputDir: 'dist'})" "$GIT_REPO_DIR")
git_config_res=$(curl -s -X PUT "http://$CP_ADDR/projects/$proj_id/git" --data-binary "$git_config")
webhook_secret=$(node -p "JSON.parse(process.argv[1]).webhookSecret" "$git_config_res")
echo "git config stored, webhook secret captured"

echo "== simulating a real GitHub push webhook delivery =="
PAYLOAD_FILE="$(mktemp)"
node -p "JSON.stringify({ref: 'refs/heads/main', after: process.argv[1]})" "$REVISION" > "$PAYLOAD_FILE"
signature=$(node "$SIGN_SCRIPT" "$webhook_secret" "$PAYLOAD_FILE")
webhook_res=$(curl -s -w '\n%{http_code}' -X POST "http://$CP_ADDR/projects/$proj_id/webhooks/github" \
  -H "x-hub-signature-256: $signature" -H "x-github-event: push" -H "content-type: application/json" --data-binary "@$PAYLOAD_FILE")
webhook_status=$(echo "$webhook_res" | tail -1)
if [ "$webhook_status" != "202" ]; then
  echo "expected the webhook delivery to return 202, got $webhook_status: $webhook_res" >&2
  exit 1
fi
echo "webhook accepted (202), build running in the background"

echo "== polling for the build to succeed =="
build_status=""
for i in $(seq 1 60); do
  builds=$(curl -s "http://$CP_ADDR/projects/$proj_id/builds")
  build_status=$(node -p "JSON.parse(process.argv[1])[0]?.status ?? 'pending'" "$builds")
  if [ "$build_status" = "succeeded" ] || [ "$build_status" = "failed" ]; then break; fi
  sleep 2
done
if [ "$build_status" != "succeeded" ]; then
  echo "expected the build to succeed, got: $builds" >&2
  exit 1
fi
echo "build succeeded for real: $builds"

echo "== waiting for ingress/cert-manager to settle =="
sleep 5

echo "== confirming the deployed app serves the fixture's own real content =="
curl -skf "https://${K8S_APP}.127.0.0.1.sslip.io/" | grep -qF "git-integration-e2e" || {
  echo "expected the deployed page to contain the fixture's own marker text" >&2
  exit 1
}

echo "== all checks passed =="
