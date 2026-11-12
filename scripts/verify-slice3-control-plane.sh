#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail
cd "$(dirname "$0")/.."

APP="ctlplane-next-app"
ADDR="localhost:8081"
DB="$(mktemp -u).db"
CP_PID=""
REAL_APP="" # set once the deploy response's url reveals deployAppName's real, project-scoped resource name

cleanup() {
  echo "== tearing down =="
  if [ -n "$CP_PID" ]; then
    kill "$CP_PID" 2>/dev/null || true
  fi
  if [ -n "$REAL_APP" ]; then
    kubectl delete deployment "$REAL_APP" "$REAL_APP-fn-ssr" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete service "$REAL_APP" "$REAL_APP-fn-ssr" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete ingress "$REAL_APP" --ignore-not-found >/dev/null 2>&1 || true
  fi
  rm -f "$DB"
}
trap cleanup EXIT

# extract_field FIELD JSON — pulls a top-level "field":"value" string out
# of a JSON object without a jq dependency (not available on this
# machine; every other verify script in this project avoids new deps
# too).
extract_field() {
  echo "$2" | grep -o "\"$1\":\"[^\"]*\"" | head -1 | sed -E "s/\"$1\":\"//;s/\"\$//"
}

echo "== building @nbo/cli and @nbo/controlplane (dependency-inclusive) =="
pnpm --filter "@nbo/cli..." build
pnpm --filter "@nbo/controlplane..." build
NBO_BIN="node packages/cli/dist/main.js"
CP_BIN="node packages/controlplane/dist/main.js"

echo "== building next-app =="
rm -rf fixtures/next-app/.next fixtures/next-app/.nbo
(cd fixtures/next-app && pnpm build)

echo "== starting control-plane =="
NBO_CONTROL_PLANE_DB="$DB" NBO_CONTROL_PLANE_ADDR="127.0.0.1:8081" $CP_BIN > control-plane.log 2>&1 &
CP_PID=$!
for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://$ADDR/projects"; then
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "control-plane never came up" >&2
    cat control-plane.log >&2
    exit 1
  fi
  sleep 1
done

echo "== creating a project =="
project_json=$(curl -s -X POST "http://$ADDR/projects" -d '{"name":"acme"}')
project_id=$(extract_field id "$project_json")
if [ -z "$project_id" ]; then
  echo "expected a project id, got: $project_json" >&2
  exit 1
fi

echo "== creating an environment =="
env_json=$(curl -s -X POST "http://$ADDR/projects/$project_id/environments" \
  -d "{\"name\":\"$APP\",\"target\":\"kubernetes\",\"config\":{}}")
env_id=$(extract_field id "$env_json")
if [ -z "$env_id" ]; then
  echo "expected an environment id, got: $env_json" >&2
  exit 1
fi

echo "== triggering a deployment through the HTTP API =="
# pwd -W (Git Bash only, no-op elsewhere) gives a Windows-style path
# (C:/Users/...) the control-plane process — a native Node.js program
# on Windows — can actually resolve; pwd's own POSIX-style /c/Users/...
# isn't a path Node's fs module understands on Windows.
nbo_dir="$(pwd -W 2>/dev/null || pwd)/fixtures/next-app/.nbo"
deploy_json=$(curl -s -X POST "http://$ADDR/environments/$env_id/deployments" \
  -d "{\"nboDir\":\"$nbo_dir\"}")
status=$(extract_field status "$deploy_json")
url=$(extract_field url "$deploy_json")
echo "$deploy_json"
if [ "$status" != "succeeded" ]; then
  echo "expected a succeeded deployment, got status=$status" >&2
  exit 1
fi
if [ -z "$url" ]; then
  echo "expected a non-empty url" >&2
  exit 1
fi
# deployAppName combines a short project-id suffix with the environment
# name, so the real Kubernetes resource name isn't just $APP — recover
# it from the host portion of the returned URL for cleanup.
REAL_APP=$(echo "$url" | sed -E 's#https?://##; s#\.127\.0\.0\.1\.sslip\.io.*##')

echo "== waiting for ingress/cert-manager to settle =="
sleep 5

echo "== conformance against the deployed app =="
code=$(curl -sk -o /dev/null -w '%{http_code}' "$url/api/hello")
if [ "$code" != "200" ]; then
  echo "expected 200 from $url/api/hello, got $code" >&2
  exit 1
fi

echo "== listing deployments shows exactly one, succeeded =="
list_json=$(curl -s "http://$ADDR/environments/$env_id/deployments")
count=$(echo "$list_json" | grep -o '"id":"dep_' | wc -l)
if [ "$count" -ne 1 ]; then
  echo "expected exactly 1 deployment, got $count: $list_json" >&2
  exit 1
fi

echo "== all checks passed =="
