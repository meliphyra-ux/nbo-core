// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { evaluate } from "@nbo/planner";
import type { Manifest, Function as NboFunction } from "@nbo/spec";
import { capabilities } from "../capabilities.js";

describe("capabilities", () => {
  it("declares fn.streaming and images.optimize native, nothing else", () => {
    expect(capabilities.native?.["fn.streaming"]).toBe(true);
    expect(capabilities.native?.["images.optimize"]).toBe(true);
    expect(Object.keys(capabilities.native ?? {})).toHaveLength(2);
  });

  it("plans an ISR build OK and has nothing to note: the deploy runs an ISR cache", () => {
    const m: Manifest = {
      build: { id: "b1", createdAt: new Date(), framework: { name: "next" } },
      digests: {},
      functions: [],
      requires: { capabilities: ["prerender.isr", "prerender.onDemand"], extensions: [] },
      specVersion: "1.0",
    };
    const p = evaluate(m, {}, capabilities);
    expect(p.ok).toBe(true);
    expect(p.notes).toEqual([]);
  });

  it("plans OK for a next-app-shaped build", () => {
    const m: Manifest = {
      build: { id: "b1", createdAt: new Date(), framework: { name: "next" } },
      digests: {},
      functions: ["ssr"],
      requires: { capabilities: ["fn.streaming"], extensions: [] },
      specVersion: "1.0",
    };
    const fns: Record<string, NboFunction> = { ssr: { name: "ssr" } as NboFunction };
    const p = evaluate(m, fns, capabilities);
    expect(p.ok).toBe(true);
  });

  it("fails for an out-of-scope capability", () => {
    const m: Manifest = {
      build: { id: "b1", createdAt: new Date(), framework: { name: "static" } },
      digests: {},
      functions: [],
      requires: { capabilities: ["fn.edge"], extensions: [] },
      specVersion: "1.0",
    };
    const p = evaluate(m, {}, capabilities);
    expect(p.ok).toBe(false);
  });

  // Real gap found running Slice 4's next/image verify script for
  // real: a build needing images.optimize/prerender.isr/
  // prerender.onDemand refused to plan at all — "no emulation is
  // declared" — despite both features being fully implemented
  // (@nbo/serve's own image.ts/prerender.ts) and real-cloud-verified
  // already. images.optimize is native: @nbo/serve's own bundled
  // sharp runs inside the same deployed container, no separate
  // service or extra wiring needed on any cloud. prerender.isr/
  // prerender.onDemand are emulated, naming the real, separately
  // deployed cache service (docs/nbo-spec.md's own "own cache tier,
  // the same on every cloud" design call) — matching
  // AdapterCapabilities.emulated's own established convention
  // (planner.test.ts: `{ "prerender.isr": "platform-cache" }`).
  it("declares images.optimize native", () => {
    expect(capabilities.native?.["images.optimize"]).toBe(true);
  });

  it("declares prerender.isr and prerender.onDemand emulated, naming the cache service", () => {
    expect(capabilities.emulated?.["prerender.isr"]).toBe("platform-cache");
    expect(capabilities.emulated?.["prerender.onDemand"]).toBe("platform-cache");
  });

  it("plans OK for a build needing images.optimize and prerender.isr/onDemand", () => {
    const m: Manifest = {
      build: { id: "b1", createdAt: new Date(), framework: { name: "next" } },
      digests: {},
      functions: ["ssr"],
      requires: { capabilities: ["fn.streaming", "images.optimize", "prerender.isr", "prerender.onDemand"], extensions: [] },
      specVersion: "1.0",
    };
    const fns: Record<string, NboFunction> = { ssr: { name: "ssr" } as NboFunction };
    const p = evaluate(m, fns, capabilities);
    expect(p.ok).toBe(true);
  });
});
