#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail

if [ -f ".adapter-server.pid" ]; then
  pid="$(cat .adapter-server.pid)"
  kill "$pid" 2>/dev/null || true
  rm -f .adapter-server.pid
fi
