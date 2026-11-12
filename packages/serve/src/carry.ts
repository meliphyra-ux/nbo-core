// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The carry is the previous build's immutable files, baked next to the app so a
// visitor holding the old page can still fetch its hashed assets after a deploy.
export const CARRIED_FROM_HEADER = "x-nbo-carried-from";

export interface CarryIndex {
  version: 1;
  contentId: string;
  files: Record<string, { file: string; contentType: string }>;
}

// loadCarry reads <dir>/index.json. Any problem (missing, unparseable, wrong
// shape) logs once and returns null: a bad carry never stops the server.
export async function loadCarry(dir: string): Promise<{ dir: string; index: CarryIndex } | null> {
  try {
    const doc = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as Record<string, unknown>;
    if (doc === null || typeof doc !== "object" || doc.version !== 1) throw new Error("version must be 1");
    if (typeof doc.contentId !== "string") throw new Error("contentId must be a string");
    const files = doc.files;
    if (files === null || typeof files !== "object" || Array.isArray(files)) throw new Error("files must be an object");
    const checked: CarryIndex["files"] = Object.create(null) as CarryIndex["files"];
    for (const [path, entry] of Object.entries(files)) {
      const e = entry as { file?: unknown; contentType?: unknown } | null;
      if (e === null || typeof e !== "object" || typeof e.file !== "string" || typeof e.contentType !== "string") {
        throw new Error(`entry ${JSON.stringify(path)} needs string file and contentType`);
      }
      checked[path] = { file: e.file, contentType: e.contentType };
    }
    return { dir, index: { version: 1, contentId: doc.contentId, files: checked } };
  } catch (err) {
    console.error(`nbo: ignoring the carry directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
