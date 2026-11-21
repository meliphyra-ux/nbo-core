// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Small helpers a build uses: its stage, paths and short error text.
import type { Store } from "../store/store.js";
import type { Stage } from "../stages/stages.js";

// stageOf is the stage a build or cloud row belongs to; Production when
// the id is "" (rows made outside the store's own methods).
export function stageOf(store: Store, projectId: string, stageId: string): Stage {
  return stageId ? store.getStage(stageId) : store.productionStage(projectId);
}

export function sepFor(path: string): string {
  return path.includes("\\") ? "\\" : "/";
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
