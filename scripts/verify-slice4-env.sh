#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Real, end-to-end verification for Slice 4's "env, secrets and
# bindings" item. Deliberately avoids starting nbo serve or doing a
# real Next.js build immediately followed by it — the exact
# transition point that killed this session's own ISR and next/image
# verify scripts with an unexplained, silent process kill three times
# in a row. Part 1/3 use fixtures/static-site (fast, no Next.js build
# at all) for the secret-scanner and deploy-time-env-resolution
# proofs; Part 2 proves inlinedEnvDigest from a real Next.js build but
# never runs nbo serve against the result — the digest is a static
# property of manifest.json, observable without a running server.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NBO_GCP_PROJECT:?export NBO_GCP_PROJECT first}"
: "${NBO_GCP_REGION:?export NBO_GCP_REGION first}"
: "${NBO_AR_REPO:?export NBO_AR_REPO first}"

APP="env-verify-app"
MUTATE_SCRIPT="$(mktemp --suffix=.js)"
DIGEST_SCRIPT="$(mktemp --suffix=.js)"

cleanup() {
  echo "== tearing down =="
  kubectl delete deployment "$APP" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete service "$APP" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete ingress "$APP" --ignore-not-found >/dev/null 2>&1 || true
  gcloud run services delete "$APP" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --quiet 2>/dev/null || true
  rm -f "$MUTATE_SCRIPT" "$DIGEST_SCRIPT"
}
trap cleanup EXIT

# mutate-manifest.js <manifest-path> <mode>: mode "plant-secret" sets
# build.id to a fake AWS-style key; mode "require-test-var" adds
# env.required. Takes the path as a real argv entry (not interpolated
# into a -e script string), the same way the real nbo binary calls
# below already do — a bash-expanded MSYS-style temp path embedded
# inside a node -e string is read by node's own (non-MSYS-aware) path
# handling as a bare drive-root path, not the real location, a real
# bug found running this exact thing locally before trusting it.
cat > "$MUTATE_SCRIPT" <<'EOF'
const fs = require("fs");
const [, , path, mode] = process.argv;
const m = JSON.parse(fs.readFileSync(path, "utf8"));
if (mode === "plant-secret") {
  m.build.id = "AKIAABCDEFGHIJKLMNOP";
} else if (mode === "require-test-var") {
  m.env = { required: ["NBO_ENV_VERIFY_TEST_VAR"] };
}
fs.writeFileSync(path, JSON.stringify(m));
EOF

cat > "$DIGEST_SCRIPT" <<'EOF'
const crypto = require("crypto");
const name = process.argv[2];
const value = process.argv[3];
console.log("sha256:" + crypto.createHash("sha256").update(`${name}=${value}`).digest("hex"));
EOF

echo "== building @nbo/cli (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build
NBO_BIN="node packages/cli/dist/main.js"

# ---------------------------------------------------------------------
# Part 1: the secret scanner, for real, against a real fixture.
# ---------------------------------------------------------------------
echo "== part 1: secret scanner =="
SECRET_DIR="$(mktemp -d)/nbo"
cp -r fixtures/static-site/.nbo "$SECRET_DIR"

if $NBO_BIN validate "$SECRET_DIR" >/dev/null 2>&1; then
  echo "clean build passes nbo validate: ok"
else
  echo "expected the clean, unmodified fixture to pass nbo validate" >&2
  exit 1
fi

node "$MUTATE_SCRIPT" "$SECRET_DIR/manifest.json" plant-secret
if $NBO_BIN validate "$SECRET_DIR" >/dev/null 2>&1; then
  echo "expected nbo validate to fail on a planted AWS-style key" >&2
  exit 1
fi
echo "planted secret fails nbo validate: ok"
rm -rf "$(dirname "$SECRET_DIR")"

# ---------------------------------------------------------------------
# Part 2: inlinedEnvDigest from a real Next.js build — no nbo serve.
# ---------------------------------------------------------------------
echo "== part 2: inlinedEnvDigest from a real Next.js build =="
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'next-app' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
rm -rf fixtures/next-app/.next fixtures/next-app/.nbo
(cd fixtures/next-app && NEXT_PUBLIC_VERIFY_VAR="hello-from-verify" pnpm build)

got_digest=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).env.inlinedEnvDigest" "$(pwd)/fixtures/next-app/.nbo/manifest.json")
expected_digest=$(node "$DIGEST_SCRIPT" "NEXT_PUBLIC_VERIFY_VAR" "hello-from-verify")
if [ "$got_digest" != "$expected_digest" ]; then
  echo "expected inlinedEnvDigest $expected_digest, got $got_digest" >&2
  exit 1
fi
echo "real build's inlinedEnvDigest matches the real inlined value: ok"
$NBO_BIN validate fixtures/next-app/.nbo

# ---------------------------------------------------------------------
# Part 3: env.required deploy-time resolution, for real, on Kubernetes.
# ---------------------------------------------------------------------
echo "== part 3: env.required deploy-time resolution =="
ENV_DIR="$(mktemp -d)/nbo"
cp -r fixtures/static-site/.nbo "$ENV_DIR"
node "$MUTATE_SCRIPT" "$ENV_DIR/manifest.json" require-test-var

unset NBO_ENV_VERIFY_TEST_VAR
if $NBO_BIN deploy "$ENV_DIR" --app "$APP" --target kubernetes >/dev/null 2>&1; then
  echo "expected the deploy to fail with NBO_ENV_VERIFY_TEST_VAR unset" >&2
  exit 1
fi
if kubectl get deployment "$APP" >/dev/null 2>&1; then
  echo "expected no deployment to have been created when the required var was missing" >&2
  exit 1
fi
echo "deploy fails cleanly before touching kubernetes when a required var is missing: ok"

# check_baked_env_json: reads /env.json out of the local image
# nbo-app-<app>:<id> (built fresh by whichever deploy just ran) and
# confirms it contains want. The app image is FROM scratch (no shell,
# no cat) — kubectl exec/cp both need a binary inside the container
# that doesn't exist, the same reason packages/adapter-k8s's own image.test.ts's own
# real tests read a baked file via `docker create` + `docker cp`
# against the image's own filesystem layers directly, never exec.
check_baked_env_json() {
  local want="$1"
  local image_tag container_id copied baked
  image_tag=$(docker images --filter "reference=nbo-app-$APP" --format '{{.Repository}}:{{.Tag}}' | head -1)
  container_id=$(docker create "$image_tag")
  copied="$(mktemp)"
  docker cp "$container_id:/env.json" "$copied"
  docker rm -f "$container_id" >/dev/null
  baked=$(cat "$copied")
  rm -f "$copied"
  if ! echo "$baked" | grep -q "$want"; then
    echo "expected the deployed app's own baked /env.json to contain $want, got: $baked" >&2
    exit 1
  fi
}

export NBO_ENV_VERIFY_TEST_VAR="real-resolved-value"
$NBO_BIN deploy "$ENV_DIR" --app "$APP" --target kubernetes
check_baked_env_json "real-resolved-value"
echo "resolved value reaches the deployed app's own baked /env.json (kubernetes): ok"

echo "== part 3b: the same check, for real, on cloud run =="
$NBO_BIN deploy "$ENV_DIR" --app "$APP" --target cloudrun
check_baked_env_json "real-resolved-value"
echo "resolved value reaches the deployed app's own baked /env.json (cloud run): ok"

rm -rf "$(dirname "$ENV_DIR")"

echo "== all checks passed =="
