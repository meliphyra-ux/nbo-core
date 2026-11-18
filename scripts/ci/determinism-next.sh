#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# determinism-next.sh [fixture...]: builds each Next.js fixture twice from the
# same commit, keeping .next/cache between the builds and pinning one
# server-actions key for the run, and checks both builds give the same content
# id. Each build must also pass
# `nbo validate --strict`. On a content id mismatch it applies the spec 1.0
# rule (nbo-diff.mjs --classify): a difference only in pages the app rendered
# at build time (prerender seeds, x-nbo-ppr.postponedState) passes and names
# those paths, as does a difference only in Next's draft-mode keys; any other
# difference fails, naming every differing path.
# Default fixtures: next-app ppr-app.
#
# NBO_BUILD_ID defaults to `git rev-parse HEAD`. NBO_FIXTURES_DIR (default
# fixtures/) and NBO_BIN (default the built CLI) exist for the tests.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

FIXTURES_DIR="${NBO_FIXTURES_DIR:-$ROOT/fixtures}"
NBO_BIN="${NBO_BIN:-node $ROOT/packages/cli/dist/main.js}"
if [ -z "${NBO_BUILD_ID:-}" ]; then
  NBO_BUILD_ID="$(git rev-parse HEAD)"
fi
export NBO_BUILD_ID

# Next keeps its keys in .next/cache only outside a container (is-docker); inside one, as on GitLab's runners, it
# makes a new server-actions encryption key on every build, and that key salts every server action id, so the
# server-reference manifests and action chunks of two builds would differ. Every build of this run gets the same
# random key instead: base64 of 32 bytes, the AES-256-GCM key Next imports. A caller's own key wins. Production
# cores should give each project a stable key of its own (docs/points-to-improve-or-fix.md). Next's draft-mode keys
# have no such setting; nbo-diff.mjs --classify allows them to differ.
if [ -z "${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:-}" ]; then
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')"
fi
export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY

if [ "$#" -gt 0 ]; then
  fixtures=("$@")
else
  fixtures=(next-app ppr-app)
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# content_id prints the sha256: id of a .nbo dir or fails naming the dir.
content_id() {
  local out id
  if ! out="$($NBO_BIN content-id "$1")"; then
    echo "nbo content-id failed for $1" >&2
    return 1
  fi
  id="$(printf '%s\n' "$out" | tr -d '\r' | tail -n 1)"
  case "$id" in
    sha256:?*) printf '%s\n' "$id" ;;
    *)
      echo "could not read a content id from $1" >&2
      return 1
      ;;
  esac
}

# build removes .nbo and everything in .next except .next/cache, builds, and
# validates the fresh output strictly. $2 is the build number, for messages.
build() {
  local name="$1" n="$2" dir="$FIXTURES_DIR/$1"
  rm -rf "$dir/.nbo"
  if [ -d "$dir/.next" ]; then
    find "$dir/.next" -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} +
  fi
  pnpm --filter "$name" build
  if [ ! -f "$dir/.nbo/manifest.json" ]; then
    echo "no .nbo output after building $name (expected $dir/.nbo/manifest.json)" >&2
    return 1
  fi
  if ! $NBO_BIN validate --strict "$dir/.nbo"; then
    echo "nbo validate --strict failed for $name (build $n)" >&2
    return 1
  fi
}

failed=0
for name in "${fixtures[@]}"; do
  dir="$FIXTURES_DIR/$name"
  first="$WORK/$name-first"

  # Builds 1 and 2 must start from the same .next/cache (the spec's rule), so a fresh checkout gets one warm-up
  # build first. Outside a container Next also keeps its draft-mode keys there; inside one it never does.
  if [ ! -d "$dir/.next/cache" ]; then
    echo "== $name: warm-up build (no .next/cache yet) =="
    build "$name" 0
  fi

  echo "== $name: build 1 (NBO_BUILD_ID=$NBO_BUILD_ID) =="
  build "$name" 1
  cp -r "$dir/.nbo" "$first"

  echo "== $name: build 2 =="
  build "$name" 2

  id1="$(content_id "$first")" || exit 1
  id2="$(content_id "$dir/.nbo")" || exit 1

  if [ "$id1" = "$id2" ]; then
    echo "deterministic: $name -> $id1"
  elif report="$(node "$ROOT/scripts/ci/nbo-diff.mjs" --classify "$first" "$dir/.nbo")"; then
    echo "deterministic apart from build-time renders: $name ($id1 vs $id2)"
    printf '%s\n' "$report" | tail -n +2
  else
    echo "NON-DETERMINISTIC BUILD for $name: $id1 (build 1) vs $id2 (build 2); differing paths:"
    printf '%s\n' "$report"
    failed=1
  fi
done

exit "$failed"
