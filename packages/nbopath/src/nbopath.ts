// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { join, relative, resolve } from "node:path";

// resolveStatic turns a static.index.json "file" value into a filesystem
// path under <nboDir>/static and reports whether that path still lives
// inside static/ once joined and resolved. A "file" value that climbs out
// of static/ (e.g. "../../etc/passwd", or a mix of / and \ separators)
// yields ok: false and must not be handed to the filesystem.
export function resolveStatic(nboDir: string, file: string): { ok: true; path: string } | { ok: false } {
  const staticDir = resolve(nboDir, "static");
  const full = resolve(join(staticDir, file));
  const rel = relative(staticDir, full);
  if (rel === ".." || rel.startsWith(".." + "/") || rel.startsWith(".." + "\\")) {
    return { ok: false };
  }
  return { ok: true, path: full };
}
