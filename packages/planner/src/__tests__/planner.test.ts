// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import type { Manifest, Function as NboFunction } from "@nbo/spec";
import { sha256Hex } from "@nbo/digest";
import { evaluate, evaluateWithTargetEnv, type AdapterCapabilities } from "../planner.js";
import { planToString } from "../format.js";

function manifest(partial: Partial<Manifest> = {}): Manifest {
  return {
    build: { id: "b1", createdAt: new Date(), framework: { name: "static" } },
    digests: {},
    functions: [],
    requires: { capabilities: [], extensions: [] },
    specVersion: "1.0",
    ...partial,
  };
}

describe("evaluate", () => {
  it("resolves a native capability as Native", () => {
    const m = manifest({ requires: { capabilities: ["fn.streaming"], extensions: [] } });
    const adapter: AdapterCapabilities = { name: "kubernetes", native: { "fn.streaming": true } };
    const p = evaluate(m, {}, adapter);
    expect(p.ok).toBe(true);
    expect(p.resolutions).toHaveLength(1);
    expect(p.resolutions[0]!.outcome).toBe("native");
  });

  it("fails and names an unsupported capability", () => {
    const m = manifest({ requires: { capabilities: ["prerender.isr"], extensions: [] } });
    const p = evaluate(m, {}, { name: "kubernetes" });
    expect(p.ok).toBe(false);
    const r = p.resolutions[0]!;
    expect(r.outcome).toBe("unsupported");
    expect(r.capability).toBe("prerender.isr");
    expect(r.scope).toBe("build");
    expect(planToString(p)).toContain("prerender.isr");
  });

  it("keeps the plan OK for an emulated capability, naming the service", () => {
    const m = manifest({ requires: { capabilities: ["prerender.isr"], extensions: [] } });
    const adapter: AdapterCapabilities = { name: "cloudrun", emulated: { "prerender.isr": "platform-cache" } };
    const p = evaluate(m, {}, adapter);
    expect(p.ok).toBe(true);
    expect(p.resolutions[0]!.outcome).toBe("emulated");
    expect(p.resolutions[0]!.detail).toBe("platform-cache");
  });

  // Final review I4: an emulation the adapter can't deliver yet is still
  // planned (so ISR builds deploy), with the adapter's note in the output.
  it("carries an adapter's note for a resolved capability into the plan and its report", () => {
    const m = manifest({ requires: { capabilities: ["images.optimize", "prerender.isr"], extensions: [] } });
    const adapter: AdapterCapabilities = {
      name: "kubernetes",
      native: { "images.optimize": true },
      emulated: { "prerender.isr": "platform-cache" },
      notes: { "prerender.isr": "served uncached today" },
    };
    const p = evaluate(m, {}, adapter);
    expect(p.ok).toBe(true);
    expect(p.notes).toEqual(["prerender.isr: served uncached today"]);
    expect(planToString(p)).toContain("  [note] prerender.isr: served uncached today\nPLAN OK");
  });

  it("has no notes when the adapter declares none", () => {
    const m = manifest({ requires: { capabilities: ["prerender.isr"], extensions: [] } });
    const p = evaluate(m, {}, { name: "cloudrun", emulated: { "prerender.isr": "platform-cache" } });
    expect(p.notes).toEqual([]);
    expect(planToString(p)).not.toContain("[note]");
  });

  it("names the function for a function-scoped capability", () => {
    const m = manifest({ functions: ["ssr"] });
    const fns: Record<string, NboFunction> = { ssr: { requires: ["fn.waitUntil"] } as NboFunction };
    const p = evaluate(m, fns, { name: "kubernetes" });
    expect(p.ok).toBe(false);
    expect(p.resolutions[0]!.scope).toBe("ssr");
  });

  it("passes a resource within its adapter's declared limit", () => {
    const m = manifest({ functions: ["ssr"] });
    const fns: Record<string, NboFunction> = { ssr: { resources: { maxDurationSec: 60 } } as NboFunction };
    const adapter: AdapterCapabilities = { name: "lambda", limits: { maxDurationSec: 900 } };
    const p = evaluate(m, fns, adapter);
    expect(p.ok).toBe(true);
  });

  it("fails and names everything for a resource exceeding its limit", () => {
    const m = manifest({ functions: ["ssr"] });
    const fns: Record<string, NboFunction> = { ssr: { resources: { maxDurationSec: 600 } } as NboFunction };
    const adapter: AdapterCapabilities = { name: "lambda", limits: { maxDurationSec: 300 } };
    const p = evaluate(m, fns, adapter);
    expect(p.ok).toBe(false);
    const lc = p.limitChecks[0]!;
    expect(lc.function).toBe("ssr");
    expect(lc.resource).toBe("maxDurationSec");
    expect(lc.requested).toBe(600);
    expect(lc.limit).toBe(300);
    expect(lc.ok).toBe(false);
    const out = planToString(p);
    for (const want of ["ssr", "maxDurationSec", "600", "300"]) {
      expect(out).toContain(want);
    }
  });

  it("treats no declared limit as no ceiling", () => {
    const m = manifest({ functions: ["ssr"] });
    const fns: Record<string, NboFunction> = { ssr: { resources: { memoryMb: 999999 } } as NboFunction };
    const p = evaluate(m, fns, { name: "kubernetes" });
    expect(p.ok).toBe(true);
  });

  it("fails the plan for an unknown critical extension", () => {
    const m = manifest({ requires: { capabilities: [], extensions: [{ id: "x-nbo-not-a-real-extension", version: "1", critical: true }] } });
    const p = evaluate(m, {}, { name: "kubernetes" });
    expect(p.ok).toBe(false);
    expect(p.extensions[0]!.ok).toBe(false);
  });

  it("resolves x-nbo-ppr as a known critical extension", () => {
    const m = manifest({ requires: { capabilities: [], extensions: [{ id: "x-nbo-ppr", version: "1", critical: true }] } });
    const p = evaluate(m, {}, { name: "kubernetes" });
    expect(p.ok).toBe(true);
    expect(p.extensions[0]).toEqual({ id: "x-nbo-ppr", critical: true, known: true, ok: true });
  });

  it("only warns, not fails, for an unknown non-critical extension", () => {
    const m = manifest({ requires: { capabilities: [], extensions: [{ id: "x-acme-analytics", version: "2", critical: false }] } });
    const p = evaluate(m, {}, { name: "kubernetes" });
    expect(p.ok).toBe(true);
    expect(p.extensions[0]!.known).toBe(false);
    expect(p.extensions[0]!.ok).toBe(true);
  });

  it("plans an empty build OK with no special casing", () => {
    const p = evaluate(manifest(), {}, { name: "kubernetes" });
    expect(p.ok).toBe(true);
    expect(p.resolutions).toHaveLength(0);
    expect(p.limitChecks).toHaveLength(0);
    expect(p.extensions).toHaveLength(0);
  });

  it("throws when a listed function has no matching data", () => {
    const m = manifest({ functions: ["ssr"] });
    expect(() => evaluate(m, {}, { name: "kubernetes" })).toThrow();
  });

  it("does not resolve an inherited Object.prototype member (toString) as a native capability", () => {
    const m = manifest({ requires: { capabilities: ["toString"], extensions: [] } });
    // A real adapter's own native map is always a real object (e.g.
    // { "fn.streaming": true }), never undefined — this is the shape
    // every actual adapter uses, not an artificial edge case.
    const adapter: AdapterCapabilities = { name: "kubernetes", native: {} };
    const p = evaluate(m, {}, adapter);
    expect(p.ok).toBe(false);
    expect(p.resolutions[0]!.outcome).toBe("unsupported");
  });

  it("throws for a listed function named constructor, not resolving it via Object.prototype.constructor", () => {
    const m = manifest({ functions: ["constructor"] });
    expect(() => evaluate(m, {}, { name: "kubernetes" })).toThrow();
  });
});

describe("evaluateWithTargetEnv", () => {
  it("passes when the target environment's values hash the same as the build's", () => {
    const digest = `sha256:${sha256Hex("NEXT_PUBLIC_API_BASE=https://api.example.com")}`;
    const m = manifest({ env: { inlinedAtBuild: ["NEXT_PUBLIC_API_BASE"], inlinedEnvDigest: digest } });
    const p = evaluateWithTargetEnv(m, {}, { name: "kubernetes" }, { NEXT_PUBLIC_API_BASE: "https://api.example.com" });
    expect(p.ok).toBe(true);
  });

  it("refuses promotion and names the mismatch when the target environment hashes differently", () => {
    const buildDigest = `sha256:${sha256Hex("NEXT_PUBLIC_API_BASE=https://staging.example.com")}`;
    const m = manifest({ env: { inlinedAtBuild: ["NEXT_PUBLIC_API_BASE"], inlinedEnvDigest: buildDigest } });
    const p = evaluateWithTargetEnv(m, {}, { name: "kubernetes" }, { NEXT_PUBLIC_API_BASE: "https://production.example.com" });
    expect(p.ok).toBe(false);
  });

  it("skips the digest check entirely when no target env is supplied", () => {
    const m = manifest({ env: { inlinedAtBuild: ["NEXT_PUBLIC_X"], inlinedEnvDigest: "sha256:anything" } });
    const p = evaluate(m, {}, { name: "kubernetes" });
    expect(p.ok).toBe(true);
  });
});
