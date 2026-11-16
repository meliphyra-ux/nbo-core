// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { ErrInvalidEnvVar } from "../store/errors.js";

// waitingForValues is the note on a build NBO can't run because it keeps no
// variable values and nobody sent them (a push, a poll).
export const waitingForValues =
  "Waiting for variable values: this NBO doesn't store them. Deploy with values in POST /projects/{id}/builds or from Terraform (nbo_deployment).";

// SuppliedValues holds the variable values a deploy request brought, when
// NBO keeps no values ("Don't store variable values"): in memory only,
// keyed by the job (build, promote) or transfer id they belong to. The
// runner takes them as its job starts; whoever ends a job without running
// it (superseded, cancelled) drops them. A restart loses them all.
export interface SuppliedValues {
  put(jobId: string, values: Record<string, string>): void;
  // take returns the job's values and forgets them.
  take(jobId: string): Record<string, string> | undefined;
  drop(jobId: string): void;
  size(): number;
  // values: every value held now (the link's reply filter redacts them).
  values(): string[];
}

export function createSuppliedValues(): SuppliedValues {
  const byJob = new Map<string, Record<string, string>>();
  return {
    put(jobId, values) {
      byJob.set(jobId, { ...values });
    },
    take(jobId) {
      const v = byJob.get(jobId);
      byJob.delete(jobId);
      return v;
    },
    drop(jobId) {
      byJob.delete(jobId);
    },
    size() {
      return byJob.size;
    },
    values() {
      return [...byJob.values()].flatMap((m) => Object.values(m));
    },
  };
}

// parseSuppliedValues reads a request body's `values` field: undefined when
// absent, else a map of names to string values. Error texts name fields,
// never a value.
export function parseSuppliedValues(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new ErrInvalidEnvVar("values must be an object of variable names to string values");
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(raw)) {
    if (typeof v !== "string") throw new ErrInvalidEnvVar(`the value of ${name} must be a string`);
    out[name] = v;
  }
  return out;
}
