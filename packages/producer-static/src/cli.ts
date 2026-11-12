#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich
import { produce } from "./produce.js";

// Re-exported for cli.test.ts, whose own existing test imports this from
// here — the real implementation now lives in produce.ts, which this file
// already depends on; keeping the import direction one-way.
export { isHashedAsset } from "./produce.js";

function parseArgs(argv: string[]) {
  const [buildDir, ...rest] = argv;
  if (!buildDir) {
    console.error("usage: nbo-producer-static <buildDir> --out <outDir> [--spa]");
    process.exit(1);
  }
  let outDir = ".nbo";
  let spa = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--out") outDir = rest[++i]!;
    else if (rest[i] === "--spa") spa = true;
  }
  return { buildDir, outDir, spa };
}

async function main() {
  const { buildDir, outDir, spa } = parseArgs(process.argv.slice(2));
  const { contentId } = await produce(buildDir, outDir, { spa });
  console.log(`wrote ${outDir} (content id ${contentId})`);
}

if (import.meta.main) main();
