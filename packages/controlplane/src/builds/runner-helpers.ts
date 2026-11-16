// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Small helpers a build uses: its stage, finding a misplaced .nbo/, paths and short error text.
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "../store/store.js";
import type { Stage } from "../stages/stages.js";

// stageOf is the stage a build or cloud row belongs to; Production when
// the id is "" (rows made outside the store's own methods).
export function stageOf(store: Store, projectId: string, stageId: string): Stage {
  return stageId ? store.getStage(stageId) : store.productionStage(projectId);
}

// findNestedNbo looks up to two folders down for a .nbo/ the build
// produced somewhere other than the Root Directory; returns its folder,
// relative and with forward slashes, or null.
export async function findNestedNbo(dir: string, depth = 2, prefix = ""): Promise<string | null> {
  if (depth === 0) return null;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git" || e.name === ".nbo") continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (await exists(join(dir, e.name, ".nbo"))) return rel;
  }
  for (const e of entries) {
    if (
      !e.isDirectory() ||
      e.name === "node_modules" ||
      e.name === ".git" ||
      e.name === ".nbo" ||
      e.name.startsWith(".")
    )
      continue;
    const found = await findNestedNbo(join(dir, e.name), depth - 1, prefix ? `${prefix}/${e.name}` : e.name);
    if (found) return found;
  }
  return null;
}

export function sepFor(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// firstLine keeps a build's error summary short; the full command
// output is already in the build log.
export function firstLine(msg: string): string {
  const line = msg.split(/\r?\n/)[0] ?? msg;
  return line.replace(/:$/, "");
}
