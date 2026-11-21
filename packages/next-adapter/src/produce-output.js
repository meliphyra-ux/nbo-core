// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { produce } from "@nbo/producer-static";
import { produceLegacyNext } from "./legacy.js";

// produceOutput makes <appDir>/.nbo once the build command is done: from the static output folder, from
// Next.js 14/15's .next/ (legacy.js), or it checks the .nbo/ the Next.js adapter wrote. NBO's build runner calls it
// on its own host (no sandbox) or runs produce-cli.js inside the build's container, so the repository's files and
// code are only ever read there. Returns why there is no .nbo/, or undefined.
export async function produceOutput({ framework, appDir, root, outputDir, spa, rootDirectory, env, log, timed }) {
  const nboDir = join(appDir, ".nbo");
  const phase = timed ?? ((fn) => fn());
  if (framework === "static") {
    const rawDir = resolve(appDir, outputDir ?? "dist");
    // Defense in depth: the git-config PUT already rejects an outputDir escaping the clone; this check means
    // .git/ can never be published even if that validation is loosened.
    const rel = relative(root, rawDir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return `outputDir "${outputDir}" escapes the cloned repository`;
    }
    if (!existsSync(rawDir)) {
      return `expected the build command to create "${outputDir ?? "dist"}", but it does not exist`;
    }
    log(`Producing .nbo/ from ${outputDir ?? "dist"}${spa ? " (SPA fallback)" : ""}\n`);
    await phase(() => produce(rawDir, nboDir, { spa }));
  } else if (!existsSync(nboDir) && existsSync(join(appDir, ".next", "required-server-files.json"))) {
    log("No .nbo/ from the adapter: reading .next/ (Next.js 14 or 15)\n");
    await phase(() => produceLegacyNext(appDir, { root, env }));
  } else if (!existsSync(nboDir)) {
    // The adapter writes .nbo/ next to the Next.js app; if the build command cd'd into a subfolder, point at the
    // setting that fixes it.
    const found = await findNestedNbo(appDir);
    const hint = found
      ? ` — found ${found}/.nbo — set Root Directory to "${[rootDirectory, found].filter(Boolean).join("/")}" (and drop the cd from the build command)`
      : " (NBO sets NEXT_ADAPTER_PATH during the build; check that this is a Next.js 14+ app and its build ran next build)";
    return `expected the build command to produce ".nbo/" in ${rootDirectory || "the repository root"}, but it does not exist${hint}`;
  }
  return undefined;
}

// findNestedNbo looks up to two folders down for a .nbo/ the build produced somewhere other than the Root
// Directory; returns its folder, relative and with forward slashes, or null.
async function findNestedNbo(dir, depth = 2, prefix = "") {
  if (depth === 0) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const skip = (e) => !e.isDirectory() || e.name === "node_modules" || e.name === ".git" || e.name === ".nbo";
  for (const e of entries) {
    if (skip(e)) continue;
    if (existsSync(join(dir, e.name, ".nbo"))) return prefix ? `${prefix}/${e.name}` : e.name;
  }
  for (const e of entries) {
    if (skip(e) || e.name.startsWith(".")) continue;
    const found = await findNestedNbo(join(dir, e.name), depth - 1, prefix ? `${prefix}/${e.name}` : e.name);
    if (found) return found;
  }
  return null;
}
