// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@nbo/validate";
import { contentId } from "@nbo/digest";

// runContentId prints the content id (sha256 of the canonical manifest
// minus its build block) of a validated .nbo dir, and nothing else on
// stdout, so scripts can capture it.
export async function runContentId(args: string[]): Promise<number> {
  if (args.length < 1) {
    console.error("usage: nbo content-id <dir>");
    return 1;
  }
  const dir = args[0]!;
  const errs = validate(dir);
  if (errs.length > 0) {
    for (const e of errs) console.error(e.message);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
  console.log(contentId(manifest));
  return 0;
}
