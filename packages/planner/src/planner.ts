// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { sha256Hex } from "@nbo/digest";
import type { Manifest, Function as NboFunction, Resources } from "@nbo/spec";

export type Outcome = "native" | "emulated" | "unsupported";

export interface Limits {
  maxMemoryMB?: number;
  maxDurationSec?: number;
  maxRequestBodyMB?: number;
}

// AdapterCapabilities is what one provider adapter publishes about
// itself: never a cloud name, account id or region — those stay out
// of .nbo/ and out of this type too. name is the adapter's own id
// (e.g. "kubernetes"), the same string a later control plane uses as
// a per-environment target.
export interface AdapterCapabilities {
  name: string;
  native?: Record<string, boolean>;
  emulated?: Record<string, string>;
  // notes, by capability id: what the adapter can't deliver yet for a
  // capability it still plans (native or emulated), shown in the plan.
  notes?: Record<string, string>;
  limits?: Limits;
}

export interface Resolution {
  capability: string;
  scope: string; // "build", or a function name
  outcome: Outcome;
  detail?: string; // emulated service name, or why it's unsupported
}

export interface LimitCheck {
  function: string;
  resource: string; // "memoryMb" | "maxDurationSec" | "maxRequestBodyMb"
  requested: number;
  limit?: number; // undefined: adapter imposes no ceiling
  ok: boolean;
}

export interface ExtensionResolution {
  id: string;
  critical: boolean;
  known: boolean;
  ok: boolean; // false only when critical && !known
}

export interface Plan {
  adapter: string;
  resolutions: Resolution[];
  limitChecks: LimitCheck[];
  extensions: ExtensionResolution[];
  // envDigestCheck is empty when no target environment was supplied
  // (evaluate) — the check is skipped entirely, not "passed" by
  // default. Set by evaluateWithTargetEnv to a human-readable
  // ok/FAIL line naming the inlined vars either way.
  envDigestCheck: string;
  // notes are "<capability>: <adapter note>" lines, one per capability
  // that resolved and has a note; they never fail the plan.
  notes: string[];
  ok: boolean;
}

// knownExtensions is the planner's own fixed vocabulary of extension
// ids it recognizes, independent of any adapter — x-nbo-ppr's serving
// behavior lives in @nbo/serve (shared by every adapter), not in any
// one adapter's own capabilities, so there is nothing per-adapter to
// declare.
const knownExtensions: Record<string, boolean> = { "x-nbo-ppr": true };

function resolveCapability(adapter: AdapterCapabilities, capability: string, scope: string): Resolution {
  // Object.hasOwn guards every lookup below — adapter.native/.emulated
  // are plain object literals (e.g. { "fn.streaming": true }), so an
  // ordinary bracket lookup for a capability id like "toString" or
  // "constructor" would resolve to an inherited Object.prototype
  // member instead of correctly falling through to "unsupported".
  if (adapter.native && Object.hasOwn(adapter.native, capability) && adapter.native[capability]) {
    return { capability, scope, outcome: "native" };
  }
  if (adapter.emulated && Object.hasOwn(adapter.emulated, capability)) {
    const svc = adapter.emulated[capability];
    return { capability, scope, outcome: "emulated", detail: svc };
  }
  return {
    capability,
    scope,
    outcome: "unsupported",
    detail: `${adapter.name} does not support ${capability} and no emulation is declared`,
  };
}

function checkLimits(fnName: string, res: Resources, limits: Limits): LimitCheck[] {
  const out: LimitCheck[] = [];
  const add = (resource: string, requested: number | undefined, limit: number | undefined) => {
    if (requested === undefined) return;
    const lc: LimitCheck = { function: fnName, resource, requested, ok: true };
    if (limit !== undefined) {
      lc.limit = limit;
      lc.ok = requested <= limit;
    }
    out.push(lc);
  };
  add("memoryMb", res.memoryMb, limits.maxMemoryMB);
  add("maxDurationSec", res.maxDurationSec, limits.maxDurationSec);
  add("maxRequestBodyMb", res.maxRequestBodyMb, limits.maxRequestBodyMB);
  return out;
}

// inlinedEnvDigest must compute the identical digest
// packages/next-adapter/src/env.js's own fromNextEnv does — sorted
// "name=value" lines, newline-joined, sha256 — the two sides
// reimplement the same algorithm independently (Go originally, this
// TS port now) rather than sharing code across that boundary; the
// format is kept deliberately simple so staying in sync is obviously
// easy to verify by inspection.
function inlinedEnvDigest(values: Record<string, string>): string {
  const names = Object.keys(values).sort();
  const input = names.map((name) => `${name}=${values[name]}`).join("\n");
  return `sha256:${sha256Hex(input)}`;
}

// evaluate is evaluateWithTargetEnv with no target environment
// supplied — the inlined-env digest check is skipped entirely (not
// "passed" by default), the right behavior for a standalone `nbo
// plan` inspection with no real deploy target's own environment to
// compare against.
export function evaluate(manifest: Manifest, functions: Record<string, NboFunction>, adapter: AdapterCapabilities): Plan {
  return evaluateWithTargetEnv(manifest, functions, adapter, undefined);
}

// evaluateWithTargetEnv additionally checks, when targetEnv is given
// and the manifest declares an env.inlinedEnvDigest, that targetEnv's
// own values for env.inlinedAtBuild's named vars hash the same way —
// "the planner refuses to promote the artifact into an environment
// whose values hash differently" (docs/nbo-spec.md).
export function evaluateWithTargetEnv(
  manifest: Manifest,
  functions: Record<string, NboFunction>,
  adapter: AdapterCapabilities,
  targetEnv: Record<string, string> | undefined,
): Plan {
  const p: Plan = { adapter: adapter.name, resolutions: [], limitChecks: [], extensions: [], envDigestCheck: "", notes: [], ok: true };

  if (targetEnv !== undefined && manifest.env?.inlinedEnvDigest !== undefined) {
    const observed: Record<string, string> = {};
    for (const name of manifest.env.inlinedAtBuild ?? []) {
      observed[name] = targetEnv[name] ?? "";
    }
    const got = inlinedEnvDigest(observed);
    if (got === manifest.env.inlinedEnvDigest) {
      p.envDigestCheck = `[ok] inlinedEnvDigest matches for ${JSON.stringify(manifest.env.inlinedAtBuild)}`;
    } else {
      p.envDigestCheck = `[FAIL] inlinedEnvDigest mismatch for ${JSON.stringify(manifest.env.inlinedAtBuild)}: build said ${manifest.env.inlinedEnvDigest}, target environment hashes to ${got}`;
      p.ok = false;
    }
  }

  for (const cap of manifest.requires.capabilities) {
    const r = resolveCapability(adapter, cap, "build");
    p.resolutions.push(r);
    if (r.outcome === "unsupported") p.ok = false;
  }

  for (const name of manifest.functions) {
    // Object.hasOwn — a function literally named "constructor" (or
    // any other Object.prototype member) must not resolve via the
    // prototype chain and silently skip the missing-data check below.
    if (!Object.hasOwn(functions, name)) {
      throw new Error(`planner: manifest lists function "${name}" but no Function data was provided`);
    }
    const fn = functions[name]!;
    for (const cap of fn.requires ?? []) {
      const r = resolveCapability(adapter, cap, name);
      p.resolutions.push(r);
      if (r.outcome === "unsupported") p.ok = false;
    }
    if (fn.resources) {
      for (const lc of checkLimits(name, fn.resources, adapter.limits ?? {})) {
        p.limitChecks.push(lc);
        if (!lc.ok) p.ok = false;
      }
    }
  }

  const noted = new Set<string>();
  for (const r of p.resolutions) {
    if (r.outcome === "unsupported" || noted.has(r.capability)) continue;
    const note = adapter.notes && Object.hasOwn(adapter.notes, r.capability) ? adapter.notes[r.capability] : undefined;
    if (note === undefined) continue;
    noted.add(r.capability);
    p.notes.push(`${r.capability}: ${note}`);
  }

  for (const ext of manifest.requires.extensions) {
    const known = Object.hasOwn(knownExtensions, ext.id) && knownExtensions[ext.id] === true;
    const er: ExtensionResolution = { id: ext.id, critical: ext.critical, known, ok: true };
    if (!known && ext.critical) {
      er.ok = false;
      p.ok = false;
    }
    p.extensions.push(er);
  }

  return p;
}
