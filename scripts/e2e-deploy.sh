#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail

# Next's adapter test harness runs this with cwd set to an isolated temp
# app it generated. ADAPTER_DIR (set by whoever invokes run-tests.js) is
# this repo's root; NBO_BIN is a pre-built `nbo` binary's path (building
# it fresh on every deploy call would be wasteful — the harness calls this
# script once per test app).
ADAPTER_SRC="$ADAPTER_DIR/packages/next-adapter/src/adapter.js"
NBO_BIN="${NBO_BIN:-$ADAPTER_DIR/nbo-harness-bin}"
TSX_LOADER_DIR="$(find "$ADAPTER_DIR/node_modules/.pnpm" -maxdepth 1 -iname 'tsx@*' | head -1)/node_modules/tsx/dist"
TSX_LOADER="file:///$(cd "$TSX_LOADER_DIR" && pwd -W)/loader.mjs"

npm install >&2

export NODE_OPTIONS="--import $TSX_LOADER"
export NEXT_ADAPTER_PATH="$ADAPTER_SRC"
npm run build >&2

BUILD_ID="$(cat .next/BUILD_ID 2>/dev/null || echo unknown)"
PORT=$((20000 + RANDOM % 10000))
DEPLOYMENT_ID="nbo-local-$PORT"

{
  echo "BUILD_ID: $BUILD_ID"
  echo "DEPLOYMENT_ID: $DEPLOYMENT_ID"
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: 1"
} >> .adapter-build.log

"$NBO_BIN" serve .nbo --port "$PORT" > .adapter-server.log 2>&1 &
echo $! > .adapter-server.pid

# Wait for the server to actually accept connections before handing the
# URL back — the harness starts hitting it immediately.
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "http://127.0.0.1:$PORT"
