// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { addCounts, bucketIndex, bucketValue, mergeHistograms, quantile, quantileCounts } from "../insights/histogram.js";
import * as edge from "@nbo/edge";

describe("insights histogram", () => {
  it("indexes values per the edge contract", () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(-3)).toBe(0);
    expect(bucketIndex(0.5)).toBe(1); // ln(0.5) < 0 → clamped to 1
    expect(bucketIndex(1)).toBe(1);
    expect(bucketIndex(1.05)).toBe(2);
    expect(bucketIndex(2500)).toBe(1 + Math.floor(Math.log(2500) / Math.log(1.05)));
  });

  it("representative value is the log-space midpoint, within 5% of the value", () => {
    expect(bucketValue(0)).toBe(0);
    expect(bucketValue(1)).toBeCloseTo(Math.pow(1.05, 0.5));
    for (const v of [3, 120, 2500, 4000, 60000]) {
      expect(Math.abs(bucketValue(bucketIndex(v)) - v) / v).toBeLessThan(0.05);
    }
  });

  it("merges histograms by summing counts", () => {
    expect(mergeHistograms({ "1": 2, "5": 1 }, { "5": 3, "9": 1 })).toEqual({ "1": 2, "5": 4, "9": 1 });
  });

  it("quantile walks the cumulative counts", () => {
    const h = { [bucketIndex(100)]: 3, [bucketIndex(1000)]: 1 };
    expect(quantile(h, 0.75)).toBeCloseTo(bucketValue(bucketIndex(100)));
    expect(quantile(h, 0.76)).toBeCloseTo(bucketValue(bucketIndex(1000)));
    expect(quantile({}, 0.75)).toBeNull();
    const acc = new Map<number, number>();
    addCounts(acc, h);
    addCounts(acc, { [bucketIndex(1000)]: 2 });
    expect(quantileCounts(acc, 0.75)).toBe(quantile(mergeHistograms(h, { [bucketIndex(1000)]: 2 }), 0.75));
    expect(quantileCounts(new Map(), 0.5)).toBeNull();
  });
});

describe("agreement with @nbo/edge's helpers", () => {
  const values = [-5, 0, 0.0001, 0.5, 1, 1.05, 3, 99.9, 100, 777, 2500, 4000, 12345.6, 120000];
  const clsValues = [0, 0.0001, 0.001, 0.05, 0.1, 0.25, 1.7, 10];
  it("bucket index and representative value match for timings and CLS", () => {
    for (const v of values) {
      expect(bucketIndex(v)).toBe(edge.bucketIndex("LCP", v));
      expect(bucketValue(bucketIndex(v))).toBe(edge.bucketValue(edge.bucketIndex("LCP", v)));
    }
    for (const v of clsValues) {
      expect(bucketIndex(v * 1000)).toBe(edge.bucketIndex("CLS", v));
      expect(bucketValue(bucketIndex(v * 1000)) / 1000).toBeCloseTo(edge.metricValue("CLS", edge.bucketIndex("CLS", v)), 12);
    }
  });

  it("quantiles and merges match", () => {
    const a = { "0": 2, "40": 3, "160": 5 };
    const b = { "40": 1, "200": 4 };
    expect(mergeHistograms(a, b)).toEqual(edge.mergeBuckets({ ...a }, b));
    for (const q of [0.1, 0.5, 0.75, 0.9, 1]) {
      expect(quantile(mergeHistograms(a, b), q)).toBe(edge.bucketValue(edge.quantile(mergeHistograms(a, b), q)!));
    }
  });
});
