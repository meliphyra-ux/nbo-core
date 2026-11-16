// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

interface CronEntry {
  id?: string;
  schedule?: unknown;
  target?: { function?: string };
}

// The five fields of a schedule with their ranges, in order, as
// packages/controlplane/src/deploys/cron.ts reads them.
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "weekday", min: 0, max: 6 },
] as const;

// scheduleProblem returns why schedule isn't in the 1.0 grammar, or
// undefined when it is: five space-separated fields, each "*", "*/N"
// (N >= 1), or a comma list of plain integers within the field's range.
// No ranges, names or other cron extensions. Stricter than the
// control-plane's parser only on junk no producer writes ("+5", "1e1").
export function scheduleProblem(schedule: string): string | undefined {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return `must have exactly 5 fields, has ${fields.length}`;
  for (let i = 0; i < 5; i++) {
    const raw = fields[i]!;
    const { name, min, max } = FIELDS[i]!;
    if (raw === "*") continue;
    if (raw.startsWith("*/")) {
      const step = raw.slice(2);
      if (!/^\d+$/.test(step) || Number(step) < 1)
        return `${name} field "${raw}": the step must be a whole number of at least 1`;
      continue;
    }
    for (const part of raw.split(",")) {
      if (!/^\d+$/.test(part)) return `${name} field "${raw}": use *, */N or a comma list of numbers`;
      const n = Number(part);
      if (n < min || n > max) return `${name} field "${raw}": ${n} is out of range ${min}-${max}`;
    }
  }
  return undefined;
}

// checkCrons flags a schedule outside the grammar, a cron whose
// target.function isn't declared in the manifest's own functions
// array, and a duplicate cron id.
export function checkCrons(manifestDoc: unknown): Error[] {
  const errs: Error[] = [];
  const manifest = manifestDoc as { functions?: unknown[]; crons?: CronEntry[] } | null;
  const crons = manifest?.crons;
  if (!Array.isArray(crons)) return errs;

  const functionNames = new Set<string>();
  const declaredFunctions = Array.isArray(manifest?.functions) ? manifest.functions : [];
  for (const name of declaredFunctions) {
    if (typeof name === "string") functionNames.add(name);
  }

  const seenIDs = new Set<string>();
  for (const cron of crons) {
    if (!cron) continue;
    const id = cron.id ?? "";
    if (seenIDs.has(id)) {
      errs.push(new Error(`manifest.json: crons: duplicate cron id "${id}"`));
    }
    seenIDs.add(id);

    if (typeof cron.schedule === "string") {
      const problem = scheduleProblem(cron.schedule);
      if (problem) errs.push(new Error(`manifest.json: crons: cron "${id}": schedule "${cron.schedule}" ${problem}`));
    }

    const fn = cron.target?.function ?? "";
    if (!functionNames.has(fn)) {
      errs.push(
        new Error(`manifest.json: crons: cron "${id}": targets function "${fn}", which is not declared in functions`),
      );
    }
  }
  return errs;
}
