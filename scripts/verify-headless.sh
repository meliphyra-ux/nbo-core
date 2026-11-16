#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# verify-headless.sh [-- <command>...]: takes a fresh NBO core with no
# dashboard from an empty database to a live site on the local kind cluster,
# using only what a core user has: the edge and the control-plane in dev mode,
# `nbo-server` and `curl`.
#
#   status -> token create -> POST /projects/setup (with the token, local
#   Kubernetes) -> wait for the first build -> the site answers through the
#   edge -> PUT /projects/{id}/traffic keeps 100% and reads it back -> the
#   project and its cluster objects are deleted -> both processes stop.
#
# Needs: the packages built (`pnpm build`), the kind cluster
# (`scripts/bootstrap-local-k8s.sh`; the kube context must be kind-<cluster>)
# and NBO_HEADLESS_REPO_URL, a public static-site repository over https.
# Optional:
#   NBO_HEADLESS_BRANCH         branch to deploy (default main)
#   NBO_HEADLESS_BUILD_COMMAND  build command (default "npm install && npm run build")
#   NBO_HEADLESS_OUTPUT_DIR     what the build writes (default dist)
#   NBO_HEADLESS_EXPECT         text the home page must contain (default "<html", any case)
#   NBO_HEADLESS_CP_PORT, NBO_HEADLESS_EDGE_PORT, NBO_HEADLESS_EDGE_ADMIN_PORT
#                               ports (default 18091, 19443, 19444)
#
# A command after "--" runs once the site answers, against the same running
# core, with NBO_ENDPOINT and NBO_TOKEN exported (verify-export.sh runs the
# Terraform acceptance test this way). Exits non-zero on any failure, naming
# the step.
set -euo pipefail
cd "$(dirname "$0")/.."
# pwd -W: a Windows path on Git Bash, which node understands without conversion.
ROOT="$(pwd -W 2>/dev/null || pwd)"

AFTER=()
if [ "${1:-}" = "--" ]; then
  shift
  AFTER=("$@")
elif [ "$#" -gt 0 ]; then
  echo "usage: verify-headless.sh [-- <command>...]" >&2
  exit 2
fi

STEP="start"
fail() {
  echo "verify-headless: FAILED at step: $STEP${1:+: $1}" >&2
  exit 1
}

REPO="${NBO_HEADLESS_REPO_URL:-}"
[ -n "$REPO" ] || { STEP="settings"; fail "set NBO_HEADLESS_REPO_URL to a public static-site repository (https)"; }
BRANCH="${NBO_HEADLESS_BRANCH:-main}"
BUILD_COMMAND="${NBO_HEADLESS_BUILD_COMMAND:-npm install && npm run build}"
OUTPUT_DIR="${NBO_HEADLESS_OUTPUT_DIR:-dist}"
EXPECT="${NBO_HEADLESS_EXPECT:-}"
CP_PORT="${NBO_HEADLESS_CP_PORT:-18091}"
EDGE_PORT="${NBO_HEADLESS_EDGE_PORT:-19443}"
EDGE_ADMIN_PORT="${NBO_HEADLESS_EDGE_ADMIN_PORT:-19444}"
CLUSTER="${NBO_KIND_CLUSTER:-nbo-local}"
NAME="headless"

STEP="checks"
for f in packages/controlplane/dist/main.js packages/controlplane/dist/server-cli.js packages/edge/dist/main.js packages/cli/dist/main.js; do
  [ -f "$f" ] || fail "$f is missing: run pnpm build first"
done
context="$(kubectl config current-context 2>/dev/null || true)"
[ "$context" = "kind-$CLUSTER" ] || fail "the kube context is \"$context\", not kind-$CLUSTER: run scripts/bootstrap-local-k8s.sh"
kubectl get nodes >/dev/null 2>&1 || fail "the kind cluster $CLUSTER does not answer"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/nbo-headless.XXXXXX")"
WORK="$(cd "$WORK" && (pwd -W 2>/dev/null || pwd))"
EDGE_PID=""
CP_PID=""
PROJECT_ID=""

# Git Bash hands back the emulation layer's pid for a background job; the
# real node process can be its child. Stop both.
stop_pid() {
  local pid="$1" child
  [ -n "$pid" ] || return 0
  for child in $(ps -ef 2>/dev/null | awk -v p="$pid" '$3 == p { print $2 }'); do
    kill "$child" 2>/dev/null || true
  done
  kill "$pid" 2>/dev/null || true
}

# MSYS_NO_PATHCONV: Git Bash on Windows would rewrite an API path such as
# /projects/x into a Windows file path before node sees it.
server() {
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*" NBO_CONTROL_PLANE_ADDR="127.0.0.1:$CP_PORT" node "$ROOT/packages/controlplane/dist/server-cli.js" "$@"
}

cleanup() {
  local code=$?
  if [ -n "$PROJECT_ID" ] && [ -n "$CP_PID" ]; then
    echo "== deleting the project and its cluster objects =="
    server api DELETE "/projects/$PROJECT_ID?resources=true" >/dev/null 2>&1 || echo "warning: could not delete project $PROJECT_ID" >&2
  fi
  stop_pid "$CP_PID"
  stop_pid "$EDGE_PID"
  if [ "$code" -ne 0 ]; then
    echo "--- control-plane log (tail) ---" >&2
    tail -n 40 "$WORK/cp.log" >&2 2>/dev/null || true
    echo "--- edge log (tail) ---" >&2
    tail -n 10 "$WORK/edge.log" >&2 2>/dev/null || true
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT

# json <expression over j>: reads JSON on stdin and prints the expression.
json() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=('"$1"');process.stdout.write(v===undefined||v===null?"":typeof v==="string"?v:JSON.stringify(v))})'
}

port_free() {
  ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/" 2>/dev/null
}

STEP="ports"
for p in "$CP_PORT" "$EDGE_PORT" "$EDGE_ADMIN_PORT"; do
  port_free "$p" || fail "port $p is already in use"
done

STEP="start the edge"
echo "== starting the edge (dev mode) on :$EDGE_PORT =="
NBO_EDGE_ADDR=":$EDGE_PORT" NBO_EDGE_ADMIN_ADDR="127.0.0.1:$EDGE_ADMIN_PORT" node packages/edge/dist/main.js >"$WORK/edge.log" 2>&1 &
EDGE_PID=$!

STEP="start the control-plane"
echo "== starting the control-plane (dev mode, fresh database in $WORK) =="
NBO_MODE=dev \
NBO_CONTROL_PLANE_DB="$WORK/control-plane.db" \
NBO_CONTROL_PLANE_ADDR="127.0.0.1:$CP_PORT" \
NBO_EDGE_ADMIN_URL="http://127.0.0.1:$EDGE_ADMIN_PORT" \
NBO_EDGE_PUBLIC_PORT="$EDGE_PORT" \
NBO_KIND_CLUSTER="$CLUSTER" \
  node packages/controlplane/dist/main.js >"$WORK/cp.log" 2>&1 &
CP_PID=$!

up=""
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$CP_PORT/healthz" && curl -s -o /dev/null "http://127.0.0.1:$EDGE_ADMIN_PORT/"; then up=1; break; fi
  sleep 1
done
[ -n "$up" ] || fail "the control-plane or the edge did not start within 60s"

STEP="nbo-server status"
echo "== nbo-server status =="
server status >"$WORK/status.json" 2>&1 || fail "$(cat "$WORK/status.json")"
ready="$(json 'j.preflight.docker.ready+"/"+j.preflight.kubernetes.ready' <"$WORK/status.json")"
[ "$ready" = "true/true" ] || fail "preflight docker/kubernetes ready is $ready: $(cat "$WORK/status.json")"
echo "status ok (docker and kubernetes ready)"

STEP="nbo-server token create"
echo "== nbo-server token create headless =="
server token create headless >"$WORK/token.txt" 2>&1 || fail "$(cat "$WORK/token.txt")"
TOKEN="$(sed -n 's/^Token (store it now, it is not shown again): //p' "$WORK/token.txt" | tr -d '\r')"
[ -n "$TOKEN" ] || fail "no token in the output"
echo "token created"

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary "$body" "http://127.0.0.1:$CP_PORT$path"
  else
    curl -s -w '\n%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$CP_PORT$path"
  fi
}
# split_answer <answer>: sets BODY and CODE.
split_answer() {
  CODE="$(printf '%s' "$1" | tail -n 1)"
  BODY="$(printf '%s' "$1" | sed '$d')"
}

STEP="POST /projects/setup"
echo "== POST /projects/setup (token, local Kubernetes) =="
setup_body="$(NAME="$NAME" REPO="$REPO" BRANCH="$BRANCH" BUILD_COMMAND="$BUILD_COMMAND" OUTPUT_DIR="$OUTPUT_DIR" node -e '
const e = process.env;
process.stdout.write(JSON.stringify({ name: e.NAME, repo: e.REPO, productionBranch: e.BRANCH, framework: "static", buildCommand: e.BUILD_COMMAND, outputDir: e.OUTPUT_DIR, clouds: [{ target: "kubernetes" }] }));')"
split_answer "$(api POST /projects/setup "$setup_body")"
[ "$CODE" = "201" ] || fail "HTTP $CODE: $BODY"
PROJECT_ID="$(printf '%s' "$BODY" | json 'j.project.id')"
EDGE_HOST="$(printf '%s' "$BODY" | json 'j.project.edgeHost')"
[ -n "$PROJECT_ID" ] && [ -n "$EDGE_HOST" ] || fail "no project id or edge host in $BODY"
echo "project $PROJECT_ID, edge host $EDGE_HOST"

STEP="first build"
echo "== waiting for the first build (15 min max) =="
status=""
deadline=$(( $(date +%s) + 900 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  split_answer "$(api GET "/projects/$PROJECT_ID/builds")"
  [ "$CODE" = "200" ] || fail "GET builds: HTTP $CODE: $BODY"
  status="$(printf '%s' "$BODY" | json 'j.length ? j[j.length-1].status : ""')"
  case "$status" in
    succeeded) break ;;
    failed | skipped)
      build_id="$(printf '%s' "$BODY" | json 'j[j.length-1].id')"
      detail="$(api GET "/builds/$build_id" | sed '$d' | json '(j.error||"")+"\n"+String(j.log||"").split("\n").slice(-30).join("\n")')"
      fail "the build $status: $detail"
      ;;
  esac
  sleep 5
done
[ "$status" = "succeeded" ] || fail "no successful build within 15 minutes (last status \"$status\")"
echo "build succeeded"

STEP="the site answers through the edge"
echo "== curl the edge for $EDGE_HOST =="
ok=""
for _ in $(seq 1 60); do
  code="$(curl -s -o "$WORK/page.html" -w '%{http_code}' -H "Host: $EDGE_HOST" "http://127.0.0.1:$EDGE_PORT/" || true)"
  if [ "$code" = "200" ]; then
    if [ -n "$EXPECT" ]; then
      grep -qF -- "$EXPECT" "$WORK/page.html" && { ok=1; break; }
    else
      grep -qi -- "<html" "$WORK/page.html" && { ok=1; break; }
    fi
  fi
  sleep 2
done
[ -n "$ok" ] || fail "the edge did not answer 200 with ${EXPECT:-a page} for $EDGE_HOST (last HTTP $code)"
echo "the site answers 200 through the edge"

STEP="traffic"
echo "== nbo-server api PUT /projects/$PROJECT_ID/traffic (keep 100%) =="
server api GET "/projects/$PROJECT_ID/traffic" >"$WORK/traffic.json" 2>&1 || fail "GET traffic: $(cat "$WORK/traffic.json")"
ENV_ID="$(json 'j.environments.length===1?j.environments[0].id:""' <"$WORK/traffic.json")"
[ -n "$ENV_ID" ] || fail "expected one environment in $(cat "$WORK/traffic.json")"
printf '{"weights":{"%s":100}}' "$ENV_ID" >"$WORK/weights.json"
server api PUT "/projects/$PROJECT_ID/traffic" --body-file "$WORK/weights.json" >"$WORK/put.json" 2>&1 || fail "PUT traffic: $(cat "$WORK/put.json")"
server api GET "/projects/$PROJECT_ID/traffic" >"$WORK/traffic.json" 2>&1 || fail "GET traffic: $(cat "$WORK/traffic.json")"
weight="$(ENV_ID="$ENV_ID" json 'String((j.backends.find(b=>b.environmentId===process.env.ENV_ID)||{}).weight)+"/"+j.edgeInSync' <"$WORK/traffic.json")"
[ "$weight" = "100/true" ] || fail "read back weight/edgeInSync $weight, want 100/true"
echo "traffic: $ENV_ID at 100%, edge in sync"

if [ "${#AFTER[@]}" -gt 0 ]; then
  STEP="after: ${AFTER[*]}"
  echo "== running against this core: ${AFTER[*]} =="
  NBO_ENDPOINT="http://127.0.0.1:$CP_PORT" NBO_TOKEN="$TOKEN" "${AFTER[@]}" || fail "exit $?"
fi

STEP="done"
echo "verify-headless: PASS"
