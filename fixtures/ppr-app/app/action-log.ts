// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// How many times each action call ran, by the name it was given, so
// scripts/verify-slice5-ppr.sh can prove a call ran once. On globalThis
// because pages and route handlers are separate bundles.
const holder = globalThis as unknown as { pprActionRuns?: Map<string, number> };
const runs = (holder.pprActionRuns ??= new Map<string, number>());

export function recordRun(name: string): void {
  runs.set(name, (runs.get(name) ?? 0) + 1);
}

export function runsOf(name: string): number {
  return runs.get(name) ?? 0;
}
