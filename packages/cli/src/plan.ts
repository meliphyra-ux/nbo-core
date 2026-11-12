// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { loadFromDir, evaluate, planToString } from "@nbo/planner";
import { capabilities as k8sCapabilities } from "@nbo/adapter-k8s";

// adapterRegistry deliberately only registers "kubernetes" — Go's own
// cmd/nbo/plan.go never registered "cloudrun" either; ported as
// today's real behavior, not silently fixed as a side effect of
// porting.
const adapterRegistry: Record<string, typeof k8sCapabilities> = {
  kubernetes: k8sCapabilities,
};

// parsePlanArgs — port of parsePlanArgs (plan.go lines 15-26).
export function parsePlanArgs(args: string[]): { dir: string; target: string } {
  if (args.length === 0) return { dir: "", target: "" };
  const dir = args[0]!;
  let target = "";
  for (let i = 1; i < args.length - 1; i++) {
    if (args[i] === "--target") target = args[i + 1]!;
  }
  return { dir, target };
}

// runPlan — port of runPlan (plan.go lines 28-57).
export async function runPlan(args: string[]): Promise<number> {
  const { dir, target } = parsePlanArgs(args);
  if (dir === "" || target === "") {
    console.error("usage: nbo plan <dir> --target <name>");
    return 1;
  }

  const adapter = adapterRegistry[target];
  if (!adapter) {
    console.error(`unknown target ${JSON.stringify(target)} (known: kubernetes)`);
    return 1;
  }

  let manifest, functions;
  try {
    ({ manifest, functions } = await loadFromDir(dir));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const p = evaluate(manifest, functions, adapter);
  console.log(planToString(p));
  return p.ok ? 0 : 1;
}
