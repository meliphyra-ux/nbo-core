// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// listPublicFiles walks publicDir and returns {pathname, filePath} for
// every file in it. Next's own AdapterOutputs type has no field for
// public/ at all — STATIC_FILE only covers /_next/static and automatic
// static optimization — so an adapter that wants to serve public/'s raw
// passthrough assets (favicon.ico, robots.txt, images, ...) has to read
// that directory itself. The convention (public/x/y.ext -> /x/y.ext) is
// Next's own, stable across versions.
export function listPublicFiles(publicDir) {
  if (!existsSync(publicDir)) return [];
  const out = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const pathname = "/" + relative(publicDir, full).split(sep).join("/");
        out.push({ pathname, filePath: full });
      }
    }
  }
  walk(publicDir);
  return out;
}
