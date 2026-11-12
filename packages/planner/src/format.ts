// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Plan } from "./planner.js";

// planToString renders a readable plan report — port of Plan.String()
// (planner.go lines 211-251).
export function planToString(p: Plan): string {
  const lines: string[] = [`plan for adapter "${p.adapter}":`];

  for (const r of p.resolutions) {
    let line = `  [${r.outcome}] ${r.capability} (${r.scope})`;
    if (r.detail) line += ` — ${r.detail}`;
    lines.push(line);
  }

  for (const lc of p.limitChecks) {
    const status = lc.ok ? "ok" : "FAIL";
    const limitStr = lc.limit !== undefined ? `${lc.limit}` : "no limit";
    lines.push(`  [${status}] ${lc.function}: ${lc.resource} ${lc.requested} <= ${limitStr}`);
  }

  for (const e of p.extensions) {
    if (e.known) {
      lines.push(`  [ok] extension ${e.id}`);
    } else if (e.critical) {
      lines.push(`  [FAIL] unknown critical extension ${e.id}`);
    } else {
      lines.push(`  [warning] unknown extension ${e.id}, ignored`);
    }
  }

  if (p.envDigestCheck) {
    lines.push(`  ${p.envDigestCheck}`);
  }

  for (const n of p.notes ?? []) {
    lines.push(`  [note] ${n}`);
  }

  lines.push(p.ok ? "PLAN OK" : "PLAN FAILED");
  return `${lines.join("\n")}\n`;
}
