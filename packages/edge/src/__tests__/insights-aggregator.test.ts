// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createAggregator, type Sample } from "../insights/aggregator.js";
import { bucketIndex } from "../insights/histogram.js";

const T0 = Date.parse("2026-11-03T10:15:42.123Z");

function sample(over: Partial<Sample> = {}): Sample {
  return {
    host: "app.test",
    environmentId: "env_a",
    contentId: "sha256:abc",
    route: "/",
    metric: "LCP",
    device: "mobile",
    value: 1000,
    ...over,
  };
}

describe("createAggregator", () => {
  it("folds samples with the same key into one histogram per minute", () => {
    let now = T0;
    const agg = createAggregator({ now: () => now });
    agg.add(sample({ value: 1000 }));
    agg.add(sample({ value: 1000 }));
    agg.add(sample({ value: 2000 }));
    agg.add(sample({ device: "desktop" }));

    const { batches } = agg.drain();
    expect(batches).toHaveLength(2);
    const mobile = batches.find((b) => b.device === "mobile")!;
    expect(mobile).toEqual({
      host: "app.test",
      environmentId: "env_a",
      contentId: "sha256:abc",
      route: "/",
      metric: "LCP",
      device: "mobile",
      minute: "2026-11-03T10:15:00.000Z",
      buckets: { [String(bucketIndex("LCP", 1000))]: 2, [String(bucketIndex("LCP", 2000))]: 1 },
      count: 3,
    });

    now += 60_000;
    agg.add(sample());
    expect(agg.drain().batches[0]!.minute).toBe("2026-11-03T10:16:00.000Z");
  });

  it("drain clears what it returned", () => {
    const agg = createAggregator({ now: () => T0 });
    agg.add(sample());
    expect(agg.drain().batches).toHaveLength(1);
    expect(agg.drain().batches).toHaveLength(0);
  });

  it("counts routes beyond 100 per host per minute under (other)", () => {
    let now = T0;
    const agg = createAggregator({ now: () => now });
    for (let i = 0; i < 105; i++) agg.add(sample({ route: `/p${i}` }));
    agg.add(sample({ route: "/p3" }));
    agg.add(sample({ host: "other.test", route: "/p104" }));

    const batches = agg.drain().batches;
    const forApp = batches.filter((b) => b.host === "app.test");
    expect(new Set(forApp.map((b) => b.route)).size).toBe(101);
    expect(forApp.find((b) => b.route === "(other)")!.count).toBe(5);
    expect(forApp.find((b) => b.route === "/p3")!.count).toBe(2);
    expect(batches.find((b) => b.host === "other.test")!.route).toBe("/p104");

    now += 60_000;
    agg.add(sample({ route: "/p104" }));
    expect(agg.drain().batches[0]!.route).toBe("/p104");
  });

  it("drops beacons beyond 1000 per host per second and counts them", () => {
    let now = T0;
    const agg = createAggregator({ now: () => now });
    const offer = (s: ReturnType<typeof sample>) => {
      if (agg.admit(s.host)) agg.add(s);
    };
    for (let i = 0; i < 1005; i++) offer(sample());
    offer(sample({ host: "other.test" }));
    expect(agg.stats().dropped).toBe(5);
    now += 1000;
    offer(sample());

    const batches = agg.drain().batches;
    expect(batches.find((b) => b.host === "app.test")!.count).toBe(1001);
    expect(batches.find((b) => b.host === "other.test")!.count).toBe(1);
  });

  it("limits distinct content ids per environment per minute", () => {
    const agg = createAggregator({ now: () => T0 });
    for (let i = 0; i < 8; i++) agg.add(sample({ contentId: `sha256:${i}` }));
    const ids = new Set(agg.drain().batches.map((b) => b.contentId));
    expect(ids.size).toBe(6);
    expect(ids.has("")).toBe(true);
  });
});

describe("createAggregator memory bound", () => {
  it("holds at most maxKeys histograms when nothing drains, dropping the oldest", () => {
    const agg = createAggregator({ now: () => T0, maxKeys: 3 });
    for (const route of ["/a", "/b", "/c", "/d", "/e"]) agg.add(sample({ route }));
    expect(agg.stats().dropped).toBe(2);
    const { batches } = agg.drain();
    expect(batches.map((b) => b.route)).toEqual(["/c", "/d", "/e"]);
    // Samples for a key already held still count.
    agg.add(sample({ route: "/x" }));
    agg.add(sample({ route: "/x" }));
    expect(agg.drain().batches[0]!.count).toBe(2);
  });
});
