// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const state = { inFlight: new Map<string, number>(), max: new Map<string, number>(), fail: "" };

vi.mock("../run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../run.js")>()),
  run: vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd !== "kind") return "";
    const cluster = args[args.indexOf("--name") + 1]!;
    const n = (state.inFlight.get(cluster) ?? 0) + 1;
    state.inFlight.set(cluster, n);
    state.max.set(cluster, Math.max(state.max.get(cluster) ?? 0, n));
    await sleep(15);
    state.inFlight.set(cluster, state.inFlight.get(cluster)! - 1);
    if (args[2] === state.fail) throw new Error(`kind load failed for ${args[2]}`);
    return "";
  }),
}));

const { loadImageIntoKind } = await import("../image.js");

describe("loadImageIntoKind", () => {
  it("never runs two loads into the same cluster at once, but different clusters may overlap", async () => {
    state.max.clear();
    state.inFlight.clear();
    await Promise.all([
      loadImageIntoKind("a:1", "c1"),
      loadImageIntoKind("b:1", "c1"),
      loadImageIntoKind("c:1", "c1"),
      loadImageIntoKind("d:1", "c2"),
    ]);
    expect(state.max.get("c1")).toBe(1);
    expect(state.max.get("c2")).toBe(1);
  });

  it("a failed load rejects only its own caller and does not block the next one", async () => {
    state.fail = "bad:1";
    const results = await Promise.allSettled([loadImageIntoKind("bad:1", "c3"), loadImageIntoKind("good:1", "c3")]);
    state.fail = "";
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  });
});
