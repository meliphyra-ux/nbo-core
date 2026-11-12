// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Log-bucket histograms for Speed Insights. Shared contract with the
// control-plane, which imports these helpers from @nbo/edge:
//
// - a value v (ms for timing metrics; CLS scaled ×1000 first) goes to
//   bucket 0 when v ≤ 0, else to 1 + floor(ln v / ln 1.05), at least 1;
// - bucket i ≥ 1 stands for 1.05^(i - 0.5), the midpoint in log space,
//   so any value read back from a bucket is within 5% of the original.

export const METRICS = ["LCP", "INP", "CLS", "FCP", "TTFB"] as const;
export type Metric = (typeof METRICS)[number];

export type Buckets = Record<string, number>;

const LN_FACTOR = Math.log(1.05);

function scale(metric: Metric): number {
  return metric === "CLS" ? 1000 : 1;
}

export function bucketIndex(metric: Metric, value: number): number {
  const v = value * scale(metric);
  if (!(v > 0)) return 0;
  return Math.max(1, 1 + Math.floor(Math.log(v) / LN_FACTOR));
}

// bucketValue is bucket i's representative value in scaled units (ms, or
// CLS × 1000).
export function bucketValue(index: number): number {
  return index <= 0 ? 0 : 1.05 ** (index - 0.5);
}

// metricValue is bucket i's representative value in the metric's own
// units (ms, or plain CLS).
export function metricValue(metric: Metric, index: number): number {
  return bucketValue(index) / scale(metric);
}

export function mergeBuckets(into: Buckets, from: Buckets): Buckets {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
  return into;
}

// quantile returns the bucket index holding the q-quantile (0 < q ≤ 1),
// or undefined for an empty histogram.
export function quantile(buckets: Buckets, q: number): number | undefined {
  const entries = Object.entries(buckets)
    .map(([k, n]) => [Number(k), n] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  for (const [, n] of entries) total += n;
  if (total === 0) return undefined;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (const [i, n] of entries) {
    seen += n;
    if (seen >= rank) return i;
  }
  return entries[entries.length - 1]![0];
}
