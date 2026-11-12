// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { bucketIndex, bucketValue, metricValue, mergeBuckets, quantile } from "../insights/histogram.js";

describe("bucketIndex", () => {
  it("puts zero and negative values in bucket 0", () => {
    expect(bucketIndex("LCP", 0)).toBe(0);
    expect(bucketIndex("LCP", -5)).toBe(0);
    expect(bucketIndex("CLS", 0)).toBe(0);
  });

  it("is 1 + floor(ln v / ln 1.05) for timing metrics", () => {
    expect(bucketIndex("LCP", 1000)).toBe(1 + Math.floor(Math.log(1000) / Math.log(1.05)));
    expect(bucketIndex("LCP", 1000)).toBe(142);
    expect(bucketIndex("TTFB", 1)).toBe(1);
  });

  it("clamps values below 1 to bucket 1", () => {
    expect(bucketIndex("INP", 0.5)).toBe(1);
  });

  it("scales CLS by 1000 first", () => {
    expect(bucketIndex("CLS", 0.1)).toBe(1 + Math.floor(Math.log(100) / Math.log(1.05)));
  });
});

describe("bucketValue / metricValue", () => {
  it("is 0 for bucket 0 and the log-space midpoint otherwise", () => {
    expect(bucketValue(0)).toBe(0);
    expect(bucketValue(142)).toBeCloseTo(1.05 ** 141.5, 6);
  });

  it("is within 5% of any value in the bucket", () => {
    for (const v of [3, 47, 180, 950, 2600, 4100, 60_000]) {
      expect(Math.abs(metricValue("LCP", bucketIndex("LCP", v)) - v) / v).toBeLessThan(0.05);
    }
    expect(Math.abs(metricValue("CLS", bucketIndex("CLS", 0.27)) - 0.27) / 0.27).toBeLessThan(0.05);
  });
});

describe("mergeBuckets / quantile", () => {
  it("merges counts by index", () => {
    const into: Record<string, number> = { "1": 2, "5": 1 };
    mergeBuckets(into, { "5": 3, "9": 1 });
    expect(into).toEqual({ "1": 2, "5": 4, "9": 1 });
  });

  it("p75 is within 5% of the true p75", () => {
    const values = Array.from({ length: 1000 }, (_, i) => 100 + i * 7);
    const buckets: Record<string, number> = {};
    for (const v of values) mergeBuckets(buckets, { [String(bucketIndex("LCP", v))]: 1 });
    const truth = values[Math.ceil(0.75 * values.length) - 1]!;
    const p75 = bucketValue(quantile(buckets, 0.75)!);
    expect(Math.abs(p75 - truth) / truth).toBeLessThan(0.05);
  });

  it("is undefined for an empty histogram", () => {
    expect(quantile({}, 0.75)).toBeUndefined();
  });
});
