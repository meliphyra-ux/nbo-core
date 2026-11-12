// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readdirSync, lstatSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface ClassifiedFile {
  urlPath: string;
  sourceFilePath: string;
}

// Directories with this name are NBO output, never build input. Skipping
// them unconditionally keeps a previous run's output (e.g. `--out
// <buildDir>/.nbo`) from being ingested as static content, which would make
// every rebuild produce a different content id.
const NBO_OUTPUT_DIR_NAME = ".nbo";

function walk(dir: string, root: string, exclude: Set<string>, out: ClassifiedFile[]): void {
  // Sort so the walk order never depends on the filesystem's readdir order.
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      throw new Error(`symlinks are not allowed in a build directory: ${full}`);
    }
    if (st.isDirectory()) {
      if (name === NBO_OUTPUT_DIR_NAME || exclude.has(resolve(full))) continue;
      walk(full, root, exclude, out);
      continue;
    }
    const rel = relative(root, full).split(sep).join("/");
    let urlPath: string;
    if (rel === "index.html") {
      urlPath = "/";
    } else if (rel.endsWith("/index.html")) {
      urlPath = "/" + rel.slice(0, -"/index.html".length);
    } else if (rel.endsWith(".html")) {
      urlPath = "/" + rel.slice(0, -".html".length);
    } else {
      urlPath = "/" + rel;
    }
    // Paths are UTF-8 NFC: the same logical name must give the same key
    // whether the filesystem handed it to us composed or decomposed.
    out.push({ urlPath: urlPath.normalize("NFC"), sourceFilePath: full });
  }
}

/**
 * Walks `buildDir` and maps every regular file to its URL path.
 *
 * Directories named `.nbo` are always skipped. `exclude` lists further
 * absolute directory paths to skip (e.g. a custom `--out` directory that
 * lives inside `buildDir`). Symlinks fail the build.
 */
export function classifyBuildDir(buildDir: string, exclude: string[] = []): ClassifiedFile[] {
  const out: ClassifiedFile[] = [];
  walk(buildDir, buildDir, new Set(exclude.map((p) => resolve(p))), out);
  return out;
}
