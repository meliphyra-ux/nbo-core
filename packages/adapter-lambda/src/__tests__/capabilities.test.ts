// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { evaluate } from "@nbo/planner";
import type { Manifest, Function as NboFunction } from "@nbo/spec";
import { capabilities } from "../capabilities.js";

const manifest = (caps: string[], functions: string[] = []): Manifest => ({
  build: { id: "b1", createdAt: new Date(), framework: { name: "next" } },
  digests: {},
  functions,
  requires: { capabilities: caps, extensions: [] },
  specVersion: "1.0",
});

describe("capabilities", () => {
  it("is lambda with Lambda's limits", () => {
    expect(capabilities.name).toBe("lambda");
    expect(capabilities.limits).toEqual({ maxMemoryMB: 10240, maxDurationSec: 900, maxRequestBodyMB: 6 });
  });

  it("fails a function over 900 s", () => {
    const fns = { ssr: { resources: { maxDurationSec: 901 } } as NboFunction };
    const p = evaluate(manifest([], ["ssr"]), fns, capabilities);
    expect(p.ok).toBe(false);
    expect(p.limitChecks[0]).toMatchObject({ resource: "maxDurationSec", requested: 901, limit: 900 });
  });

  it("plans streaming and images natively, and an ISR build with a served-uncached note", () => {
    const p = evaluate(
      manifest(["fn.streaming", "images.optimize", "prerender.isr", "prerender.onDemand"]),
      {},
      capabilities,
    );
    expect(p.ok).toBe(true);
    expect(p.notes.join("\n")).toMatch(/uncached/);
  });
});
