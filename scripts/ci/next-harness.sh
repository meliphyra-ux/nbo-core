#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# next-harness.sh <serve|kubernetes|cloudrun>: runs the Next.js fixtures'
# conformance suites and real-behaviour checks against one target, the same
# way in CI and at a terminal.
#
#   next-app: suites slice2 and slice4-middleware, the streaming timing check,
#             and (kubernetes, cloudrun) a redeploy that must say "already live".
#   ppr-app:  suite slice5-ppr and the resumed-document, shell-streams,
#             client-navigation and server-action checks; on serve also the
#             cache-backed checks, with a real local @nbo/isrcache.
#
# Ends with `== harness <target>: all checks passed (<n> suites, <m> checks) ==`.
#
# Environment:
#   NBO_CI_APP_PREFIX   cloudrun app-name prefix, must start with ci- (default ci-local-)
#   NBO_GCP_PROJECT, NBO_GCP_REGION, NBO_AR_REPO   required on cloudrun
#   NBO_HARNESS_CONTEXT kubernetes only: a kube context the harness may use. Without
#                       it the harness runs only on the CI cluster (context kind-nbo-ci,
#                       or kind-${NBO_KIND_CLUSTER:-nbo-local} inside the CI job: NBO_CI_DIND=1 and CI=true or GITLAB_CI=true), because
#                       its cleanup deletes next-app and ppr-app in that cluster.
#   NBO_KIND_CLUSTER    kubernetes only: the kind cluster nbo deploy loads images into
#                       (kind load --name). The context must be kind-<that name>; when
#                       unset the harness sets it from the context.
#   NBO_HARNESS_ROLLOUT_TIMEOUT  kubernetes: kubectl rollout status timeout (default 180s)
#   NBO_HARNESS_READY_TRIES, NBO_HARNESS_READY_INTERVAL  kubernetes: HTTP readiness
#                       probes through the ingress after each deploy (default 90, 2 s apart)
# Test hooks: NBO_BIN, NBO_FIXTURES_DIR, NBO_CONFORMANCE_ROOT, NBO_HARNESS_SKIP_BUILD,
#   NBO_CLEANUP_SCRIPT.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

TARGET="${1:-}"
case "$TARGET" in
  serve | kubernetes | cloudrun) ;;
  *)
    echo "usage: next-harness.sh <serve|kubernetes|cloudrun>" >&2
    exit 2
    ;;
esac

NBO_BIN="${NBO_BIN:-node $ROOT/packages/cli/dist/main.js}"
FIXTURES_DIR="${NBO_FIXTURES_DIR:-$ROOT/fixtures}"
CONF_ROOT="${NBO_CONFORMANCE_ROOT:-$ROOT/fixtures/conformance}"
ROLLOUT_TIMEOUT="${NBO_HARNESS_ROLLOUT_TIMEOUT:-180s}"
READY_TRIES="${NBO_HARNESS_READY_TRIES:-90}"
READY_INTERVAL="${NBO_HARNESS_READY_INTERVAL:-2}"
CLEANUP_SCRIPT="${NBO_CLEANUP_SCRIPT:-$ROOT/scripts/ci/cloudrun-cleanup.sh}"

NEXT_SUITES="slice2 slice4-middleware"
PPR_SUITES="slice5-ppr"

# -- validation, before anything is built or created ------------------------
PREFIX=""
if [ "$TARGET" = "cloudrun" ]; then
  for v in NBO_GCP_PROJECT NBO_GCP_REGION NBO_AR_REPO; do
    if [ -z "${!v:-}" ]; then
      echo "next-harness.sh cloudrun: $v is not set" >&2
      exit 1
    fi
  done
  PREFIX="${NBO_CI_APP_PREFIX:-ci-local-}"
  case "$PREFIX" in
    ci-*) ;;
    *)
      echo "next-harness.sh cloudrun: NBO_CI_APP_PREFIX prefix must start with ci- (got '$PREFIX')" >&2
      exit 1
      ;;
  esac
  export NBO_CI_APP_PREFIX="$PREFIX"
fi

# kubernetes: the cleanup below deletes the fixtures' deployments, so refuse any
# cluster that is not the CI one. Every kubectl call passes --context explicitly.
KCTX=""
if [ "$TARGET" = "kubernetes" ]; then
  KCTX="$(kubectl config current-context 2>/dev/null || true)"
  if [ -z "$KCTX" ]; then
    echo "next-harness.sh kubernetes: no current kube context" >&2
    exit 1
  fi
  allowed=0
  [ "$KCTX" = "kind-nbo-ci" ] && allowed=1
  if [ "${NBO_CI_DIND:-}" = "1" ] && { [ "${CI:-}" = "true" ] || [ "${GITLAB_CI:-}" = "true" ]; } && [ "$KCTX" = "kind-${NBO_KIND_CLUSTER:-nbo-local}" ]; then
    allowed=1
  fi
  [ -n "${NBO_HARNESS_CONTEXT:-}" ] && [ "$KCTX" = "$NBO_HARNESS_CONTEXT" ] && allowed=1
  if [ "$allowed" -ne 1 ]; then
    echo "next-harness.sh kubernetes: refusing to run against kube context $KCTX: it is not the CI cluster (kind-nbo-ci). Set NBO_HARNESS_CONTEXT=$KCTX to use it on purpose." >&2
    exit 1
  fi
  # nbo deploy puts images into a kind cluster with `kind load --name
  # $NBO_KIND_CLUSTER` (default nbo-local). That must be the cluster this
  # context talks to, or the images land in another cluster (a developer's
  # nbo-local) while the pods here can't pull them.
  case "$KCTX" in
    kind-?*) ;;
    *)
      echo "next-harness.sh kubernetes: refusing kube context $KCTX: it is not a kind cluster (kind-<name>), and nbo deploy loads its images with kind load" >&2
      exit 1
      ;;
  esac
  CTX_CLUSTER="${KCTX#kind-}"
  if [ -n "${NBO_KIND_CLUSTER:-}" ] && [ "$NBO_KIND_CLUSTER" != "$CTX_CLUSTER" ]; then
    echo "next-harness.sh kubernetes: refusing: kind load would target cluster $NBO_KIND_CLUSTER (NBO_KIND_CLUSTER), not $CTX_CLUSTER (context $KCTX)" >&2
    exit 1
  fi
  export NBO_KIND_CLUSTER="$CTX_CLUSTER"
  # Pin the run to that one context: nbo deploy and the cleanup read this
  # one-context kubeconfig, so nothing can switch to another cluster mid-run.
  PINNED_KUBECONFIG="$(mktemp)"
  if ! kubectl config view --minify --flatten --context "$KCTX" >"$PINNED_KUBECONFIG"; then
    echo "next-harness.sh kubernetes: could not write a kubeconfig for context $KCTX" >&2
    rm -f "$PINNED_KUBECONFIG"
    exit 1
  fi
  export KUBECONFIG="$PINNED_KUBECONFIG"
fi

# A suite directory without transcripts would make `nbo conformance` print
# "ok (0 transcripts passed)", so refuse it up front.
for suite in $NEXT_SUITES $PPR_SUITES; do
  dir="$CONF_ROOT/$suite"
  count=$(find "$dir" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l)
  if [ "$count" -eq 0 ]; then
    echo "no transcripts in $dir" >&2
    exit 1
  fi
done

# -- state, cleanup ---------------------------------------------------------
BYPASS_TOKEN="nbo-harness-ppr-token"
HOST_PID=""
SERVE_PID=""
CACHE_PID=""
SUITES=0
CHECKS=0
DEPLOYED_APPS=""
LOG_FILES=""
PINNED_KUBECONFIG="${PINNED_KUBECONFIG:-}"

# shellcheck source=../lib-ppr-checks.sh
source "$ROOT/scripts/lib-ppr-checks.sh"

stop_serve() {
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null || true
  [ -n "$CACHE_PID" ] && kill "$CACHE_PID" 2>/dev/null || true
  SERVE_PID=""
  CACHE_PID=""
}

cleanup() {
  local code=$?
  stop_serve
  [ -n "$HOST_PID" ] && kill "$HOST_PID" 2>/dev/null || true
  # shellcheck disable=SC2086
  [ -n "$LOG_FILES" ] && rm -f $LOG_FILES
  [ -n "$PINNED_KUBECONFIG" ] && rm -f "$PINNED_KUBECONFIG"
  if [ "$TARGET" = "kubernetes" ] && [ -n "$DEPLOYED_APPS" ]; then
    local app
    for app in $DEPLOYED_APPS; do
      kubectl --context "$KCTX" delete deployment "$app" "$app-fn-ssr" "$app-fn-middleware" --ignore-not-found >/dev/null 2>&1 || true
      kubectl --context "$KCTX" delete service "$app" "$app-fn-ssr" "$app-fn-middleware" --ignore-not-found >/dev/null 2>&1 || true
      kubectl --context "$KCTX" delete ingress "$app" --ignore-not-found >/dev/null 2>&1 || true
    done
  fi
  if [ "$TARGET" = "cloudrun" ]; then
    echo "== cleaning up Cloud Run resources with prefix $PREFIX =="
    if ! "$CLEANUP_SCRIPT" --prefix "$PREFIX"; then
      echo "cloud run cleanup failed for prefix $PREFIX: resources may be left behind" >&2
      [ "$code" -eq 0 ] && code=1
    fi
  fi
  exit "$code"
}
trap cleanup EXIT

# -- helpers ----------------------------------------------------------------
run_suite() {
  local suite="$1" url="$2"
  shift 2
  echo "== conformance $suite: $url =="
  $NBO_BIN conformance "$CONF_ROOT/$suite" "$url" "$@"
  SUITES=$((SUITES + 1))
}

# run_check <description> <command...>: counts one passed check.
run_check() {
  local what="$1"
  shift
  echo "== check: $what =="
  "$@"
  CHECKS=$((CHECKS + 1))
}

check_stream_timing() {
  local url="$1"
  shift
  local start elapsed_ms
  start=$(date +%s%N)
  curl -s -o /dev/null "$@" "$url/api/stream"
  elapsed_ms=$(((($(date +%s%N)) - start) / 1000000))
  echo "elapsed: ${elapsed_ms}ms"
  if [ "$elapsed_ms" -lt 200 ]; then
    echo "$url/api/stream: expected >= 200ms (its chunks are 100ms apart), got ${elapsed_ms}ms, buffering may have reappeared" >&2
    exit 1
  fi
}

# check_redeploy_noop: deploying the same .nbo again must not touch the target.
check_redeploy_noop() {
  local dir="$1" app="$2" out
  out=$($NBO_BIN deploy "$dir" --app "$app" --target "$TARGET")
  echo "$out"
  if ! grep -q "already live" <<<"$out"; then
    echo "expected the second deploy of $app to print \"already live\", got: $out" >&2
    exit 1
  fi
}

# check_function_private: a function service must reject an anonymous request.
check_function_private() {
  local service="$1" fn_url status
  fn_url=$(gcloud run services describe "$service" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --format='value(status.url)')
  status=$(curl -s -o /dev/null -w '%{http_code}' "$fn_url/")
  if [ "$status" != "401" ] && [ "$status" != "403" ]; then
    echo "$service: expected an anonymous request to be rejected (401/403), got $status" >&2
    exit 1
  fi
}

# wait_cloudrun_ready: one spaced probe (not the conformance suite), because
# Cloud Run's IAM propagation can take over a minute and hammering a service
# that is cold-starting makes it worse (see verify-slice3-cloudrun.sh).
wait_cloudrun_ready() {
  local url="$1" attempt=0 max=12 status
  while true; do
    status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" || true)
    [ "$status" = "200" ] && return 0
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$max" ]; then
      echo "$url never became ready after $max probes: last probe got $status" >&2
      exit 1
    fi
    echo "not ready yet (probe $attempt/$max, got $status), waiting 15s..."
    sleep 15
  done
}

# wait_rollout <app>: kubectl rollout status for the app's Deployment and every
# function Deployment of it (<app>-fn-*), so no suite runs against a pod that
# is still starting.
wait_rollout() {
  local app="$1" d found=0
  for d in $(kubectl --context "$KCTX" get deployments -o name | tr -d '\r'); do
    case "${d#*/}" in
      "$app" | "$app"-fn-*) ;;
      *) continue ;;
    esac
    found=1
    if ! kubectl --context "$KCTX" rollout status "deployment/${d#*/}" "--timeout=$ROLLOUT_TIMEOUT"; then
      echo "deployment/${d#*/} did not finish rolling out within $ROLLOUT_TIMEOUT" >&2
      exit 1
    fi
  done
  if [ "$found" -eq 0 ]; then
    echo "no deployment named $app in context $KCTX after the deploy" >&2
    exit 1
  fi
  echo "rollout finished: $app"
}

# wait_ready <url> [curl args...]: polls until the URL answers 200 (through
# the ingress, so the ingress controller and the certificate are ready too).
wait_ready() {
  local url="$1" i code=000
  shift
  for i in $(seq 1 "$READY_TRIES"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" "$url" || true)
    code="${code:-000}"
    [ "$code" = "200" ] && return 0
    sleep "$READY_INTERVAL"
  done
  echo "$url never became ready after $READY_TRIES probes (last status $code)" >&2
  exit 1
}

wait_up() {
  local url="$1" log="$2" i code
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || echo 000)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  echo "$url never came up (last status $code)" >&2
  cat "$log" >&2
  exit 1
}

# -- build ------------------------------------------------------------------
if [ "${NBO_HARNESS_SKIP_BUILD:-}" != "1" ]; then
  echo "== building @nbo/cli, @nbo/next-adapter and @nbo/isrcache =="
  pnpm --filter "@nbo/cli..." build
  pnpm --filter "@nbo/next-adapter..." build
  pnpm --filter "@nbo/isrcache" build
  for name in next-app ppr-app; do
    echo "== building $name (keeping .next/cache) =="
    dir="$FIXTURES_DIR/$name"
    rm -rf "$dir/.nbo"
    if [ -d "$dir/.next" ]; then
      find "$dir/.next" -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} +
    fi
    pnpm --filter "$name" build
  done
fi
for name in next-app ppr-app; do
  if [ ! -d "$FIXTURES_DIR/$name/.nbo" ]; then
    echo "no .nbo output for $name at $FIXTURES_DIR/$name/.nbo" >&2
    exit 1
  fi
done

NEXT_NBO="$FIXTURES_DIR/next-app/.nbo"
PPR_NBO="$FIXTURES_DIR/ppr-app/.nbo"

# -- serve ------------------------------------------------------------------
if [ "$TARGET" = "serve" ]; then
  SERVE_LOG="$(mktemp)"
  LOG_FILES="$SERVE_LOG"

  echo "== next-app on nbo serve =="
  $NBO_BIN serve "$NEXT_NBO" --port 4100 >"$SERVE_LOG" 2>&1 &
  SERVE_PID=$!
  wait_up "http://localhost:4100/api/hello" "$SERVE_LOG"
  for suite in $NEXT_SUITES; do
    run_suite "$suite" "http://localhost:4100"
  done
  run_check "streaming timing (local)" check_stream_timing "http://localhost:4100"
  stop_serve

  echo "== ppr-app on nbo serve, with a real cache service =="
  NBO_ISRCACHE_ADDR=127.0.0.1:4110 node "$ROOT/packages/isrcache/dist/main.js" >/dev/null 2>&1 &
  CACHE_PID=$!
  NBO_ISRCACHE_URL=http://127.0.0.1:4110 NBO_PRERENDER_BYPASS="$BYPASS_TOKEN" \
    $NBO_BIN serve "$PPR_NBO" --port 4109 >"$SERVE_LOG" 2>&1 &
  SERVE_PID=$!
  wait_up "http://localhost:4109/" "$SERVE_LOG"
  U="http://localhost:4109"
  for suite in $PPR_SUITES; do
    run_suite "$suite" "$U"
  done
  run_check "one well-formed resumed document" check_resumed_document "$U"
  run_check "the shell arrives before the hole" check_shell_streams "$U"
  run_check "client-side navigation gets the hole" check_client_navigation "$U"
  run_check "server action runs once and changes the page" check_server_action "$U"
  run_check "an rsc request leaves the cached page alone" check_rsc_leaves_html_alone "$U"
  run_check "a hole-less page with a lifetime revalidates" check_lifetime "$U"
  run_check "draft mode gets a whole, uncached document" check_draft "$U"
  stop_serve
fi

# -- kubernetes and cloudrun ------------------------------------------------
if [ "$TARGET" != "serve" ]; then
  if [ "$TARGET" = "kubernetes" ]; then
    NEXT_APP="next-app"
    PPR_APP="ppr-app"
    INSECURE="--insecure"
  else
    NEXT_APP="${PREFIX}next"
    PPR_APP="${PREFIX}ppr"
    INSECURE=""
  fi

  # deploy_app <app> <nbo dir> <probe path>: deploys, proves the redeploy is a
  # no-op, waits until the app answers, and sets APP_URL.
  deploy_app() {
    local app="$1" dir="$2" probe="$3"
    echo "== deploying $app to $TARGET =="
    DEPLOYED_APPS="$DEPLOYED_APPS $app"
    $NBO_BIN deploy "$dir" --app "$app" --target "$TARGET"
    run_check "redeploying the same output is a no-op ($app)" check_redeploy_noop "$dir" "$app"
    if [ "$TARGET" = "kubernetes" ]; then
      APP_URL="https://$app.127.0.0.1.sslip.io"
      wait_rollout "$app"
      wait_ready "$APP_URL$probe" --insecure
    else
      APP_URL=$(gcloud run services describe "$app" --project="$NBO_GCP_PROJECT" --region="$NBO_GCP_REGION" --format='value(status.url)')
      wait_cloudrun_ready "$APP_URL$probe"
    fi
  }

  deploy_app "$NEXT_APP" "$NEXT_NBO" "/api/hello"
  NEXT_URL="$APP_URL"
  for suite in $NEXT_SUITES; do
    # shellcheck disable=SC2086
    run_suite "$suite" "$NEXT_URL" $INSECURE
  done
  # shellcheck disable=SC2086
  run_check "streaming timing ($TARGET)" check_stream_timing "$NEXT_URL" $INSECURE
  if [ "$TARGET" = "cloudrun" ]; then
    run_check "next-app function service requires authentication" check_function_private "$NEXT_APP-fn-ssr"
  fi

  deploy_app "$PPR_APP" "$PPR_NBO" "/"
  PPR_URL="$APP_URL"
  for suite in $PPR_SUITES; do
    # shellcheck disable=SC2086
    run_suite "$suite" "$PPR_URL" $INSECURE
  done
  # shellcheck disable=SC2086
  run_check "one well-formed resumed document" check_resumed_document "$PPR_URL" $INSECURE
  # shellcheck disable=SC2086
  run_check "the shell arrives before the hole" check_shell_streams "$PPR_URL" $INSECURE
  # shellcheck disable=SC2086
  run_check "client-side navigation gets the hole" check_client_navigation "$PPR_URL" $INSECURE
  # shellcheck disable=SC2086
  run_check "server action runs once and changes the page" check_server_action "$PPR_URL" $INSECURE
  if [ "$TARGET" = "cloudrun" ]; then
    run_check "ppr-app function service requires authentication" check_function_private "$PPR_APP-fn-ssr"
  fi
fi

echo "== harness $TARGET: all checks passed ($SUITES suites, $CHECKS checks) =="
