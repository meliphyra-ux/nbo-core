#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# verify-lambda.sh: the first real run of NBO on AWS Lambda, for a person with
# an AWS account. Claude never runs it.
#
# COST: this deploys to YOUR AWS account. Three small projects (one app Lambda
# each, plus one Lambda per Next.js function), their images in the ECR
# repository nbo and a few hundred requests. Expect cents, mostly ECR storage
# for the time the images exist. The script deletes the projects at the end,
# also when a step fails. Check the Lambda and ECR consoles afterwards anyway.
#
# Before running it:
#   - the packages built (pnpm build) and Docker running;
#   - a dev-mode control-plane running on this machine
#     (NBO_CONTROL_PLANE_ADDR, default 127.0.0.1:8081), connected to AWS with
#     `nbo-server connect aws`, the nbo-boundary policy created first (manual:
#     docs/production.md, "Connect AWS (Lambda)");
#   - the aws CLI signed in to the SAME account (any profile that may read
#     Lambda functions and IAM roles); the script reads the region from NBO.
#
# What it does, for fixtures/static-site, fixtures/react-spa and
# fixtures/next-app:
#   build the fixture's .nbo/ here -> POST /projects/setup with one Lambda cloud
#   (the build command copies that .nbo/ into the clone) -> wait for the build ->
#   nbo conformance against the function URL -> build again and check that no
#   Lambda changed (LastModified) -> DELETE /projects/{id}?resources=true ->
#   check that the project's Lambdas and roles are gone.
#
# Optional:
#   NBO_LAMBDA_REPO_URL  any public https repository with a main branch; only
#                        cloned, never built (default octocat/Spoon-Knife)
#   NBO_LAMBDA_ONLY      one of static-site, react-spa, next-app
set -euo pipefail
cd "$(dirname "$0")/.."
# pwd -W: a Windows path on Git Bash, which node understands without conversion.
ROOT="$(pwd -W 2>/dev/null || pwd)"

ADDR="${NBO_CONTROL_PLANE_ADDR:-127.0.0.1:8081}"
CP="http://$ADDR"
REPO="${NBO_LAMBDA_REPO_URL:-https://github.com/octocat/Spoon-Knife}"
ONLY="${NBO_LAMBDA_ONLY:-}"
NBO_BIN="node packages/cli/dist/main.js"

STEP="start"
fail() {
  echo "verify-lambda: FAILED at step: $STEP${1:+: $1}" >&2
  exit 1
}

PROJECTS=()
cleanup() {
  local code=$? id
  for id in "${PROJECTS[@]+"${PROJECTS[@]}"}"; do
    [ -n "$id" ] || continue
    echo "== cleanup: deleting project $id and its Lambdas =="
    curl -s -o /dev/null -X DELETE "$CP/projects/$id?resources=true" || echo "warning: could not delete project $id: delete it yourself" >&2
  done
  exit "$code"
}
trap cleanup EXIT

# json <expression over j>: reads JSON on stdin and prints the expression.
json() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=('"$1"');process.stdout.write(v===undefined||v===null?"":typeof v==="string"?v:JSON.stringify(v))})'
}

# api METHOD PATH [BODY]: sets BODY and CODE. Loopback without a token, as nbo-server does.
api() {
  local out
  if [ -n "${3:-}" ]; then
    out="$(curl -s -w '\n%{http_code}' -X "$1" -H 'Content-Type: application/json' --data-binary "$3" "$CP$2")"
  else
    out="$(curl -s -w '\n%{http_code}' -X "$1" "$CP$2")"
  fi
  CODE="$(printf '%s' "$out" | tail -n 1)"
  BODY="$(printf '%s' "$out" | sed '$d')"
}

STEP="preconditions"
for f in packages/cli/dist/main.js packages/controlplane/dist/main.js; do
  [ -f "$f" ] || fail "$f is missing: run pnpm build first"
done
command -v aws >/dev/null || fail "the aws CLI is not installed"
docker info >/dev/null 2>&1 || fail "Docker is not running"
curl -sf -o /dev/null "$CP/healthz" || fail "no control-plane answers at $CP: start one in dev mode"
api GET /system/connections
[ "$CODE" = "200" ] || fail "GET /system/connections: HTTP $CODE: $BODY"
REGION="$(printf '%s' "$BODY" | json 'j.aws ? j.aws.region : ""')"
ACCOUNT="$(printf '%s' "$BODY" | json 'j.aws ? j.aws.accountId : ""')"
[ -n "$REGION" ] || fail "NBO is not connected to AWS: run nbo-server connect aws first"
mine="$(aws sts get-caller-identity --query Account --output text | tr -d '\r')" || fail "the aws CLI is not signed in"
[ "$mine" = "$ACCOUNT" ] || fail "NBO is connected to AWS account $ACCOUNT, the aws CLI is signed in to $mine"
echo "AWS account $ACCOUNT, region $REGION"
AWS=(aws --region "$REGION")

# lambdas_of APP: "name<TAB>LastModified" lines of the app's Lambdas, sorted.
lambdas_of() {
  "${AWS[@]}" lambda list-functions --output text \
    --query "Functions[?FunctionName=='$1' || starts_with(FunctionName, '$1-fn-')].[FunctionName,LastModified]" | tr -d '\r' | sort
}
roles_of() {
  aws iam list-roles --path-prefix /nbo/ --output text \
    --query "Roles[?RoleName=='$1' || starts_with(RoleName, '$1-fn-')].RoleName" | tr -d '\r'
}

STEP="build the fixtures"
echo "== building the packages the fixtures need =="
pnpm --filter "@nbo/cli..." --filter "@nbo/next-adapter..." build
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
if want static-site; then
  echo "== producing static-site =="
  rm -rf fixtures/static-site/.nbo
  pnpm --filter @nbo/producer-static exec tsx src/cli.ts ../../fixtures/static-site --out ../../fixtures/static-site/.nbo
fi
if want react-spa; then
  echo "== building and producing react-spa =="
  (cd fixtures/react-spa && pnpm build)
  rm -rf fixtures/react-spa/.nbo
  pnpm --filter @nbo/producer-static exec tsx src/cli.ts ../../fixtures/react-spa/dist --out ../../fixtures/react-spa/.nbo --spa
fi
if want next-app; then
  echo "== building next-app =="
  rm -rf fixtures/next-app/.next fixtures/next-app/.nbo
  (cd fixtures/next-app && pnpm build)
fi

# wait_build PROJECT_ID N: waits for the project's Nth build to succeed.
wait_build() {
  local status="" deadline=$(($(date +%s) + 1200)) id
  while [ "$(date +%s)" -lt "$deadline" ]; do
    api GET "/projects/$1/builds"
    [ "$CODE" = "200" ] || fail "GET builds: HTTP $CODE: $BODY"
    status="$(printf '%s' "$BODY" | json "j.length >= $2 ? j[j.length-1].status : \"\"")"
    case "$status" in
      succeeded) return 0 ;;
      failed | skipped)
        id="$(printf '%s' "$BODY" | json 'j[j.length-1].id')"
        api GET "/builds/$id"
        fail "the build $status: $(printf '%s' "$BODY" | json '(j.error||"")+"\n"+String(j.log||"").split("\n").slice(-30).join("\n")')"
        ;;
    esac
    sleep 10
  done
  fail "no successful build within 20 minutes (last status \"$status\")"
}

# run_fixture NAME CONFORMANCE_DIRS...
run_fixture() {
  local fixture="$1" project="lambda-$1" id app url before after
  shift
  STEP="$fixture: setup"
  echo "== $fixture: POST /projects/setup (AWS Lambda) =="
  # framework "nextjs" for all three: the runner then takes the .nbo/ the build
  # command leaves, here the one built above, so the clone's own code never runs.
  local body
  body="$(NAME="$project" REPO="$REPO" SRC="$ROOT/fixtures/$fixture/.nbo" node -e '
const e = process.env;
const copy = `node -e "require(\x27fs\x27).cpSync(process.argv[1], \x27.nbo\x27, { recursive: true })" "${e.SRC}"`;
process.stdout.write(JSON.stringify({ name: e.NAME, repo: e.REPO, productionBranch: "main", framework: "nextjs", buildCommand: copy, clouds: [{ target: "lambda" }] }));')"
  api POST /projects/setup "$body"
  [ "$CODE" = "201" ] || fail "HTTP $CODE: $BODY"
  id="$(printf '%s' "$BODY" | json 'j.project.id')"
  [ -n "$id" ] || fail "no project id in $BODY"
  PROJECTS+=("$id")
  app="$(ID="$id" node -e 'const s=process.env.ID;process.stdout.write("nbo-p"+s.slice(s.lastIndexOf("_")+1).slice(0,8)+"-lambda")')"
  echo "project $id, app Lambda $app"

  STEP="$fixture: first build and deploy"
  wait_build "$id" 1
  api GET "/projects/$id/summary"
  url="$(printf '%s' "$BODY" | json '(j.environments.find(e=>e.target==="lambda")||{}).latestDeployment?.url')"
  case "$url" in https://*.on.aws) ;; *) fail "expected a Lambda function URL, got \"$url\"" ;; esac
  echo "live at $url"

  STEP="$fixture: the function URL answers"
  local ok="" code=""
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$url/" || true)"
    [ "$code" = "200" ] && { ok=1; break; }
    sleep 5
  done
  [ -n "$ok" ] || fail "GET $url/ answered $code"

  STEP="$fixture: conformance"
  local dir
  for dir in "$@"; do
    echo "== nbo conformance $dir $url =="
    $NBO_BIN conformance "$dir" "$url" || fail "$dir"
  done
  if [ "$fixture" = "react-spa" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url/some/deep/link")"
    [ "$code" = "200" ] || fail "the SPA deep link answered $code"
  fi

  STEP="$fixture: no-op redeploy"
  before="$(lambdas_of "$app")"
  [ -n "$before" ] || fail "aws lists no Lambda named $app"
  echo "== build again: the same .nbo/ must change nothing on AWS =="
  api POST "/projects/$id/builds" '{}'
  case "$CODE" in 2*) ;; *) fail "POST builds: HTTP $CODE: $BODY" ;; esac
  wait_build "$id" 2
  after="$(lambdas_of "$app")"
  [ "$before" = "$after" ] || fail "a Lambda changed on a no-op redeploy:
before:
$before
after:
$after"
  echo "unchanged:"
  echo "$before"

  STEP="$fixture: teardown"
  echo "== DELETE /projects/$id?resources=true =="
  api DELETE "/projects/$id?resources=true"
  case "$CODE" in 2*) ;; *) fail "HTTP $CODE: $BODY" ;; esac
  PROJECTS=("${PROJECTS[@]/$id/}")
  [ -z "$(lambdas_of "$app")" ] || fail "Lambdas left: $(lambdas_of "$app")"
  [ -z "$(roles_of "$app")" ] || fail "roles left under /nbo/: $(roles_of "$app")"
  echo "$fixture: Lambdas and roles gone"
}

PLATFORM=packages/conformance/transcripts/platform
want static-site && run_fixture static-site "$PLATFORM"
want react-spa && run_fixture react-spa "$PLATFORM"
want next-app && run_fixture next-app fixtures/conformance/slice2 "$PLATFORM"

STEP="done"
echo "verify-lambda: PASS"
