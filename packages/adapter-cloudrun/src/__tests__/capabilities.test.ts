// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { evaluate } from "@nbo/planner";
import type { Manifest, Function as NboFunction } from "@nbo/spec";
import { capabilities } from "../capabilities.js";

describe("capabilities", () => {
  it("declares the real Cloud Run limits", () => {
    const l = capabilities.limits;
    expect(l?.maxMemoryMB).toBe(32768);
    expect(l?.maxDurationSec).toBe(3600);
    expect(l?.maxRequestBodyMB).toBe(32);
  });

  it("fails a function over the duration limit", () => {
    const m: Manifest = {
      build: { id: "b1", createdAt: new Date(), framework: { name: "next" } },
      digests: {},
      functions: ["ssr"],
      requires: { capabilities: [], extensions: [] },
      specVersion: "1.0",
    };
    const fns: Record<string, NboFunction> = { ssr: { resources: { maxDurationSec: 4000 } } as NboFunction };
    const p = evaluate(m, fns, capabilities);
    expect(p.ok).toBe(false);
    const lc = p.limitChecks[0]!;
    expect(lc.function).toBe("ssr");
    expect(lc.resource).toBe("maxDurationSec");
    expect(lc.requested).toBe(4000);
    expect(lc.limit).toBe(3600);
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

  it("declares fn.streaming native", () => {
    expect(capabilities.native?.["fn.streaming"]).toBe(true);
  });

  // Real gap found running Slice 4's next/image verify script for
  // real — see adapter-k8s's own identical capabilities.test.ts for
  // the full explanation; images.optimize/prerender.isr/
  // prerender.onDemand are Cloud Run capabilities too, by the exact
  // same reasoning (images.optimize needs nothing cloud-specific,
  // prerender.isr/onDemand are emulated via the same real,
  // separately deployed cache service, same on every cloud).
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
      requires: {
        capabilities: ["fn.streaming", "images.optimize", "prerender.isr", "prerender.onDemand"],
        extensions: [],
      },
      specVersion: "1.0",
    };
    const fns: Record<string, NboFunction> = { ssr: { name: "ssr" } as NboFunction };
    const p = evaluate(m, fns, capabilities);
    expect(p.ok).toBe(true);
  });
});
