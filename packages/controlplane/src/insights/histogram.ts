// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Log-bucket histograms for Speed Insights. These follow the edge ↔
// control-plane contract exactly (the edge keeps its own copy of the
// same definitions): factor 1.05, CLS scaled ×1000 before indexing.

// A histogram maps a bucket index (as a string, JSON-friendly) to a count.
export type Histogram = Record<string, number>;

const LOG_FACTOR = Math.log(1.05);

// bucketIndex: v ≤ 0 → 0; otherwise 1 + floor(ln v / ln 1.05), at least 1.
export function bucketIndex(v: number): number {
  if (!(v > 0)) return 0;
  return Math.max(1, 1 + Math.floor(Math.log(v) / LOG_FACTOR));
}

// bucketValue is a bucket's representative value: the midpoint in log
// space, 1.05^(i - 0.5); index 0 → 0.
export function bucketValue(i: number): number {
  return i <= 0 ? 0 : Math.pow(1.05, i - 0.5);
}

// mergeHistograms adds b's counts into a copy of a.
export function mergeHistograms(a: Histogram, b: Histogram): Histogram {
  const out: Histogram = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
}

export function histogramCount(h: Histogram): number {
  let n = 0;
  for (const c of Object.values(h)) n += c;
  return n;
}

// quantile returns the representative value of the bucket holding the
// q-th sample (nearest rank), or null for an empty histogram. Values are
// in bucket units (CLS still scaled ×1000).
export function quantile(h: Histogram, q: number): number | null {
  const entries = Object.entries(h)
    .map(([k, n]) => [Number(k), n] as const)
    .filter(([, n]) => n > 0)
    .sort((x, y) => x[0] - y[0]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total === 0) return null;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (const [i, n] of entries) {
    seen += n;
    if (seen >= rank) return bucketValue(i);
  }
  return bucketValue(entries[entries.length - 1]![0]);
}

// Counts is a histogram being accumulated in place (bucket index → count).
export type Counts = Map<number, number>;

// addCounts adds a stored histogram's buckets into acc.
export function addCounts(acc: Counts, h: Histogram): void {
  for (const k in h) {
    const i = Number(k);
    acc.set(i, (acc.get(i) ?? 0) + h[k]!);
  }
}

// quantileCounts is quantile over accumulated counts.
export function quantileCounts(acc: Counts, q: number): number | null {
  const entries = [...acc].filter(([, n]) => n > 0).sort((x, y) => x[0] - y[0]);
  let total = 0;
  for (const [, n] of entries) total += n;
  if (total === 0) return null;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (const [i, n] of entries) {
    seen += n;
    if (seen >= rank) return bucketValue(i);
  }
  return bucketValue(entries[entries.length - 1]![0]);
}
