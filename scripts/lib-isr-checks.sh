# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich

# Shared real ISR behavior checks (fresh cache hit, stale-serve-then-
# background-regenerate, draft mode never touching the cache, on-demand
# revalidation forcing a fresh render) against a running deployment of
# fixtures/next-app's own /isr-demo page (revalidate=2s).
#
# The conformance-transcript format (fixtures/conformance/slice4-isr/)
# can only assert a response against a fixed expected value — it can't
# express "equal to another live response" or "different from one" —
# so this part of the proof is bash-level curl + compare, the same kind
# of thing scripts/verify-slice3-edge.sh's own weighted-split check
# already is. Sourced by verify-slice4-isr-local.sh and
# verify-slice4-isr-cloud.sh rather than duplicated, since both need
# the identical checks against different base URLs.

rendered_at() {
  curl -s "$@" | grep -o 'data-testid="isr-rendered-at">[0-9]*' | grep -o '[0-9]*$'
}

# run_isr_checks base_url bypass_token [extra curl args...]
#
# extra curl args (e.g. -k for a self-signed cert) are forwarded to
# every curl call this makes. Leaves the final, on-demand-regenerated
# timestamp in $LAST_RENDERED_AT, for a caller that wants to cross-
# check it against a different deployment entirely (verify-slice4-isr-
# cloud.sh's own cross-cloud shared-cache proof).
run_isr_checks() {
  local base_url="$1" token="$2"
  shift 2
  local extra=("$@")

  echo "== real ISR check: fresh cache hit (two immediate requests, same body) =="
  local t1 t2
  t1=$(rendered_at "${extra[@]}" "$base_url/isr-demo")
  t2=$(rendered_at "${extra[@]}" "$base_url/isr-demo")
  if [ "$t1" != "$t2" ]; then
    echo "expected a fresh cache hit to return the same body twice, got $t1 then $t2" >&2
    exit 1
  fi

  echo "== real ISR check: stale-serve-then-background-regenerate =="
  sleep 3 # past revalidateSec=2
  local t3
  t3=$(rendered_at "${extra[@]}" "$base_url/isr-demo")
  if [ "$t3" != "$t1" ]; then
    echo "expected the stale hit to still serve the old body immediately, got $t3 (was $t1)" >&2
    exit 1
  fi
  # Poll rather than a fixed sleep: the background regeneration now does
  # a genuine fresh render (x-prerender-revalidate forces Next to bypass
  # its own internal incremental cache — see next-adapter's entry-shim.mjs)
  # plus a real network round trip to the remote cache service, so its
  # latency isn't a constant a fixed sleep can safely assume.
  local t4=""
  for i in $(seq 1 10); do
    t4=$(rendered_at "${extra[@]}" "$base_url/isr-demo")
    if [ "$t4" != "$t1" ]; then
      break
    fi
    sleep 1
  done
  if [ "$t4" == "$t1" ]; then
    echo "expected the background regeneration to have produced a new body by now, still got $t1" >&2
    exit 1
  fi

  echo "== real ISR check: draft mode never caches (two bypass requests, different bodies; a plain request is untouched by them) =="
  local d1 d2
  d1=$(rendered_at "${extra[@]}" -H "Cookie: __nbo_bypass=$token" "$base_url/isr-demo")
  d2=$(rendered_at "${extra[@]}" -H "Cookie: __nbo_bypass=$token" "$base_url/isr-demo")
  if [ "$d1" == "$d2" ]; then
    echo "expected two draft-mode requests to each render fresh (never cached), got the same body twice: $d1" >&2
    exit 1
  fi
  local t5
  t5=$(rendered_at "${extra[@]}" "$base_url/isr-demo")
  if [ "$t5" != "$t4" ]; then
    echo "expected the plain cached value to be untouched by draft-mode requests, got $t5 (was $t4)" >&2
    exit 1
  fi

  echo "== real ISR check: on-demand revalidation forces a fresh render =="
  local revalidate_code
  revalidate_code=$(curl -s "${extra[@]}" -o /dev/null -w '%{http_code}' -X POST "$base_url/_nbo/revalidate" \
    -H "Authorization: Bearer $token" -d '{"paths":["/isr-demo"]}')
  if [ "$revalidate_code" != "204" ]; then
    echo "expected POST /_nbo/revalidate to return 204, got $revalidate_code" >&2
    exit 1
  fi
  LAST_RENDERED_AT=$(rendered_at "${extra[@]}" "$base_url/isr-demo")
  if [ "$LAST_RENDERED_AT" == "$t4" ]; then
    echo "expected on-demand revalidation to force a brand-new render, still got $t4" >&2
    exit 1
  fi
}
