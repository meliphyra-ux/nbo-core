# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich

# Shared PPR checks (resumed document, streaming shell, client navigation,
# server actions, cache behaviour, draft mode, tampered resume), run against a
# deployment of fixtures/ppr-app. Sourced by scripts/verify-slice5-ppr.sh and
# scripts/ci/next-harness.sh. The caller sets BYPASS_TOKEN (the value given to
# nbo serve as NBO_PRERENDER_BYPASS) and HOST_PID (empty), and runs from the
# repo root. Each check exits the calling shell on failure.

# check_resumed_document proves the dynamic hole actually resumes into
# one well-formed document -- the conformance transcripts only check
# individual substrings; this additionally rules out the exact failure
# mode found reviewing this feature (the "resume" accidentally coming
# back as a second, complete, duplicate document instead of a
# continuation fragment, which a naive substring check alone would not
# catch): expects the ppr-static shell marker, the real ppr-dynamic
# content, a single real closing </html>, and no second <!DOCTYPE
# (which would mean two documents got concatenated instead of one).
check_resumed_document() {
  local url="$1"
  shift
  local body
  body=$(curl -s "$url/" "$@")
  if [[ "$body" != *"ppr-static"* ]]; then
    echo "$url/: expected body to contain ppr-static, got: $body" >&2
    exit 1
  fi
  if [[ "$body" != *"ppr-dynamic"* ]]; then
    echo "$url/: expected body to contain ppr-dynamic (the resumed dynamic hole), got: $body" >&2
    exit 1
  fi
  if [[ "$body" != *"</html>"* ]]; then
    echo "$url/: expected a real closing </html> (the resume response's own continuation script didn't complete the document), got: $body" >&2
    exit 1
  fi
  local doctype_count
  doctype_count=$(grep -o "<!DOCTYPE" <<<"$body" | wc -l)
  if [ "$doctype_count" -ne 1 ]; then
    echo "$url/: expected exactly one <!DOCTYPE (got $doctype_count) -- the resume response came back as a second full document instead of a continuation fragment" >&2
    exit 1
  fi
}

# check_shell_streams proves the shell doesn't wait for the hole: /visitor's
# hole sleeps a second, so its first byte must arrive well before its last.
# Anything buffering the response, here or in front of it, closes that gap.
check_shell_streams() {
  local url="$1"
  shift
  local timing
  timing=$(curl -s -o /dev/null -w '%{time_starttransfer} %{time_total}' "$url/visitor" "$@")
  if ! awk -v t="$timing" 'BEGIN { split(t, a, " "); exit !(a[2] - a[1] >= 0.5) }'; then
    echo "$url/visitor: expected the shell at least 0.5s before the end of the response, got first byte/total: $timing" >&2
    exit 1
  fi
  echo "first byte/total: $timing"
}

# check_client_navigation proves a <Link> to a PPR page gets the hole: the
# RSC answer has to hold the real content, rendered for this visitor, and
# stream. Next's answer to a plain GET here is also text/x-component, with
# the hole left out, so the content type alone proves nothing. A static
# prefetch is the opposite: it must not hold anyone's render.
check_client_navigation() {
  local url="$1"
  shift
  local links
  links=$(curl -s "$url/nav" "$@")
  if [[ "$links" != *'href="/visitor"'* ]]; then
    echo "$url/nav: expected a link to /visitor, got: $links" >&2
    exit 1
  fi
  local content_type
  content_type=$(curl -s -o /dev/null -w '%{content_type}' -H 'rsc: 1' "$url/visitor?_rsc=verify" "$@")
  if [[ "$content_type" != *"text/x-component"* ]]; then
    echo "$url/visitor with an rsc header: expected text/x-component, got: $content_type" >&2
    exit 1
  fi
  local body
  body=$(curl -s -H 'rsc: 1' -H 'cookie: ppr-visitor=alice' "$url/visitor?_rsc=verify" "$@")
  if [[ "$body" != *"visitor:alice"* ]]; then
    echo "$url/visitor with an rsc header: expected the hole's real content (visitor:alice), got: $body" >&2
    exit 1
  fi
  local timing
  timing=$(curl -s -o /dev/null -w '%{time_starttransfer} %{time_total}' -H 'rsc: 1' "$url/visitor?_rsc=verify" "$@")
  if ! awk -v t="$timing" 'BEGIN { split(t, a, " "); exit !(a[2] - a[1] >= 0.5) }'; then
    echo "$url/visitor with an rsc header: expected it to stream, got first byte/total: $timing" >&2
    exit 1
  fi
  echo "rsc first byte/total: $timing"
  body=$(curl -s -H 'rsc: 1' -H 'next-router-prefetch: 1' -H 'cookie: ppr-visitor=alice' "$url/visitor?_rsc=verify" "$@")
  if [[ "$body" == *"visitor:alice"* ]]; then
    echo "$url/visitor as a static prefetch: expected no visitor's render, got: $body" >&2
    exit 1
  fi
}

# post_action calls a server action with the request real Chrome sends for
# these forms: next-action is the id from the built page, the router's tree
# comes along, and the fields come before "0", the root of the reply, because
# Next decodes the body as it streams. Prints the response with its headers.
post_action() {
  local url="$1" page="$2" id="$3" name="$4" origin="$5"
  shift 5
  local tree="%5B%22%22%2C%7B%22children%22%3A%5B%22$page%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C49312%5D%7D%2Cnull%2Cnull%2C49248%5D%7D%2Cnull%2Cnull%2C49232%5D"
  curl -s -i -X POST "$url/$page" -H "next-action: $id" -H "origin: $origin" -H "referer: $origin/$page" -H 'accept: text/x-component' -H "next-router-state-tree: $tree"     -F '_1_$ACTION_ID_'"$id=" -F "_1_name=$name" -F '0=["$K1"]' "$@"
}

# check_server_action runs a real action on a hole-less page and on a PPR
# page: the answer is a 200 with the cookie, the rerendered page and Next's
# revalidated flag, and the action ran once. An Origin that doesn't match the
# host is refused, so the check doesn't pass by turning Next's guard off.
check_server_action() {
  local url="$1"
  shift
  local page id name response runs
  for page in action-form action-ppr; do
    id=$(curl -s "$url/$page" "$@" | grep -o 'ACTION_ID_[0-9a-f]*' | sed -n '1s/ACTION_ID_//p')
    if [ -z "$id" ]; then
      echo "$url/$page: expected an action id in the built page" >&2
      exit 1
    fi
    name="verify-$page-$RANDOM$RANDOM"
    response=$(post_action "$url" "$page" "$id" "$name" "$url" "$@")
    if [[ "$response" != HTTP/*" 200"* ]]; then
      echo "$url/$page: expected the action to answer 200, got: $response" >&2
      exit 1
    fi
    if ! grep -qi "^set-cookie: ppr-action=$name" <<<"$response"; then
      echo "$url/$page: expected the action's Set-Cookie for $name, got: $response" >&2
      exit 1
    fi
    if ! grep -qi '^x-action-revalidated: 1' <<<"$response"; then
      echo "$url/$page: expected the action to report a revalidation, got: $response" >&2
      exit 1
    fi
    runs=$(curl -s "$url/action-runs?name=$name" "$@")
    if [ "$runs" != "runs:1" ]; then
      echo "$url/$page: expected the action to run once, got: $runs" >&2
      exit 1
    fi
    if [ "$page" == "action-ppr" ]; then
      if [[ "$response" != *"greeting:$name"* ]]; then
        echo "$url/$page: expected the action's answer to show the new cookie, got: $response" >&2
        exit 1
      fi
      response=$(curl -s -H "cookie: ppr-action=$name" "$url/$page" "$@")
      if [[ "$response" != *"greeting:$name"* ]]; then
        echo "$url/$page: expected the next document to show the new cookie, got: $response" >&2
        exit 1
      fi
    elif [[ "$response" != *"stamp:"* ]]; then
      echo "$url/$page: expected the action's answer to hold the rerendered page, got: $response" >&2
      exit 1
    fi

    name="verify-$page-$RANDOM$RANDOM"
    response=$(post_action "$url" "$page" "$id" "$name" "https://attacker.example" "$@")
    if [[ "$response" != HTTP/*" 500"* ]]; then
      echo "$url/$page: expected an action from another origin to be refused, got: $response" >&2
      exit 1
    fi
    runs=$(curl -s "$url/action-runs?name=$name" "$@")
    if [ "$runs" != "runs:0" ]; then
      echo "$url/$page: expected a refused action not to run, got: $runs" >&2
      exit 1
    fi
  done
}

# check_rsc_leaves_html_alone needs a cache service: an rsc request arriving
# first must store nothing a later visitor would get as the page, on a
# long-lived page and on one with a lifetime.
check_rsc_leaves_html_alone() {
  local url="$1"
  local page content_type
  for page in plain-static cache-life; do
    curl -s -o /dev/null -H 'rsc: 1' "$url/$page?_rsc=verify"
    sleep 1
    # Twice: the first can be the seed, the second is what the cache holds.
    curl -s -o /dev/null "$url/$page"
    sleep 1
    content_type=$(curl -s -o /dev/null -w '%{content_type}' "$url/$page")
    if [[ "$content_type" != *"text/html"* ]]; then
      echo "$url/$page after an rsc request: expected text/html, got: $content_type" >&2
      exit 1
    fi
    content_type=$(curl -s -o /dev/null -w '%{content_type}' -H 'rsc: 1' "$url/$page?_rsc=verify")
    if [[ "$content_type" != *"text/x-component"* ]]; then
      echo "$url/$page with an rsc header, after the page was cached: expected text/x-component, got: $content_type" >&2
      exit 1
    fi
  done
}

# check_lifetime needs a cache service: /cache-life has no hole and a
# 2-second cacheLife, so it must behave as ISR, not as a static page.
check_lifetime() {
  local url="$1"
  local first second
  first=$(curl -s "$url/cache-life" | grep -o 'rendered:[0-9]*' | head -1)
  sleep 3
  curl -s -o /dev/null "$url/cache-life" # stale: answered, regeneration starts
  sleep 1
  second=$(curl -s "$url/cache-life" | grep -o 'rendered:[0-9]*' | head -1)
  if [ -z "$first" ] || [ "$first" == "$second" ]; then
    echo "$url/cache-life: expected a new render after its 2-second lifetime, got '$first' then '$second'" >&2
    exit 1
  fi
}

# check_draft proves draft mode on a PPR route is one finished document that
# nothing may store, not the unfinished shell a plain GET gets from Next.
check_draft() {
  local url="$1"
  local response
  response=$(curl -s -i -H "cookie: __nbo_bypass=$BYPASS_TOKEN" "$url/draft-peek")
  if [[ "$response" != *"</html>"* || "$response" != *"draft:"* ]]; then
    echo "$url/draft-peek in draft mode: expected a whole document with the hole, got: $response" >&2
    exit 1
  fi
  if [[ "$response" != *"cache-control: private, no-store"* ]]; then
    echo "$url/draft-peek in draft mode: expected cache-control: private, no-store, got: $response" >&2
    exit 1
  fi
  # Next's own draft cookie reaches the hole, through the ordinary resume.
  local cookie
  cookie=$(curl -s -i "$url/draft-on" | tr -d '\r' | sed -n 's/^set-cookie: \(__prerender_bypass=[^;]*\).*/\1/ip')
  response=$(curl -s -H "cookie: $cookie" "$url/draft-peek")
  if [[ "$response" != *"draft:true"* ]]; then
    echo "$url/draft-peek with Next's draft cookie: expected draft:true, got: $response" >&2
    exit 1
  fi
}

# check_tampered_resume calls real Next with a bad postponedState, straight
# on the function: a resume nothing in NBO would send. Next doesn't refuse
# it. It logs, renders the hole as flight data only, and answers 200, and
# React renders that in the browser (docs/nbo-spec.md).
check_tampered_resume() {
  local port=4111
  (cd fixtures/ppr-app/.nbo/functions/ssr/bundle && PORT=$port exec node ../../../../../../packages/funcproxy/src/host.mjs .) > /dev/null 2>&1 &
  HOST_PID=$!
  local response=""
  for i in $(seq 1 20); do
    response=$(curl -s -i -X POST -H 'next-resume: 1' -H 'x-matched-path: /visitor' -H 'cookie: ppr-visitor=alice' --data-binary 'tampered' "http://127.0.0.1:$port/visitor" || true)
    if [ -n "$response" ]; then
      break
    fi
    sleep 1
  done
  kill "$HOST_PID" 2>/dev/null || true
  HOST_PID=""
  if [[ "$response" != "HTTP/1.1 200"* || "$response" != *"visitor:alice"* || "$response" != *"</html>"* || "$response" == *"<!DOCTYPE"* ]]; then
    echo "a tampered resume: expected a 200 continuation with the hole as flight data, got: $response" >&2
    exit 1
  fi
}
