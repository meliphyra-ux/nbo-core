// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { bucketIndex, type Buckets, type Metric } from "./histogram.js";

export type Device = "mobile" | "desktop";

// Sample is one validated beacon.
export interface Sample {
  host: string;
  environmentId: string;
  contentId: string;
  route: string;
  metric: Metric;
  device: Device;
  value: number;
}

// Batch is one histogram as GET /insights/drain returns it (the
// edge ↔ control-plane contract).
export interface Batch {
  host: string;
  environmentId: string;
  contentId: string;
  route: string;
  metric: Metric;
  device: Device;
  minute: string;
  buckets: Buckets;
  count: number;
}

export interface AggregatorStats {
  // dropped counts beacons refused by the per-host rate cap, plus histograms
  // evicted (oldest first) when the key cap is reached.
  dropped: number;
}

export interface Aggregator {
  // admit takes one beacon of a host against its per-second rate. It is
  // checked before the beacon's body is read, so a flood costs no
  // parsing; false means drop it (and it is counted as dropped).
  admit(host: string): boolean;
  // add counts an admitted, validated beacon.
  add(sample: Sample): void;
  // drain returns every histogram held and forgets them, in one
  // synchronous step, so no beacon is counted twice or lost in between.
  drain(): { batches: Batch[] };
  stats(): AggregatorStats;
}

export interface AggregatorOptions {
  now?: () => number;
  maxRoutesPerHostMinute?: number;
  maxBeaconsPerHostSecond?: number;
  maxContentIdsPerEnvironmentMinute?: number;
  // maxKeys bounds memory when nobody drains; past it the oldest histogram goes.
  maxKeys?: number;
}

export const OTHER_ROUTE = "(other)";

export function createAggregator(options: AggregatorOptions = {}): Aggregator {
  const now = options.now ?? Date.now;
  const maxRoutes = options.maxRoutesPerHostMinute ?? 100;
  const maxRate = options.maxBeaconsPerHostSecond ?? 1000;
  const maxContentIds = options.maxContentIdsPerEnvironmentMinute ?? 5;
  const maxKeys = options.maxKeys ?? 100_000;

  let batches = new Map<string, Batch>();
  // Admission state, kept across drains: limits are per minute, and a
  // drain in the middle of a minute must not reset them.
  let routesSeen = new Map<string, Set<string>>();
  let contentIdsSeen = new Map<string, Set<string>>();
  let limitsMinute = -1;
  const rate = new Map<string, { second: number; count: number }>();
  let dropped = 0;

  function admit(seen: Map<string, Set<string>>, key: string, value: string, max: number): boolean {
    let set = seen.get(key);
    if (!set) seen.set(key, (set = new Set()));
    if (set.has(value)) return true;
    if (set.size >= max) return false;
    set.add(value);
    return true;
  }

  return {
    admit(host) {
      const second = Math.floor(now() / 1000);
      const r = rate.get(host);
      if (!r || r.second !== second) {
        if (rate.size > 10_000) rate.clear();
        rate.set(host, { second, count: 1 });
      } else if (r.count >= maxRate) {
        dropped++;
        return false;
      } else {
        r.count++;
      }
      return true;
    },
    add(sample) {
      const t = now();
      const minuteMs = Math.floor(t / 60_000) * 60_000;

      if (minuteMs !== limitsMinute) {
        limitsMinute = minuteMs;
        routesSeen = new Map();
        contentIdsSeen = new Map();
      }
      const route = admit(routesSeen, sample.host, sample.route, maxRoutes) ? sample.route : OTHER_ROUTE;
      const contentId = admit(
        contentIdsSeen,
        `${sample.host}\0${sample.environmentId}`,
        sample.contentId,
        maxContentIds,
      )
        ? sample.contentId
        : "";

      const minute = new Date(minuteMs).toISOString();
      const key = [sample.host, sample.environmentId, contentId, route, sample.metric, sample.device, minute].join(
        "\0",
      );
      let batch = batches.get(key);
      if (!batch) {
        // Nothing drains in a core-only install: keep the newest, drop the
        // oldest (a Map iterates in insertion order).
        if (batches.size >= maxKeys) {
          const oldest = batches.keys().next();
          if (!oldest.done) batches.delete(oldest.value);
          dropped++;
        }
        batch = {
          host: sample.host,
          environmentId: sample.environmentId,
          contentId,
          route,
          metric: sample.metric,
          device: sample.device,
          minute,
          buckets: {},
          count: 0,
        };
        batches.set(key, batch);
      }
      const i = String(bucketIndex(sample.metric, sample.value));
      batch.buckets[i] = (batch.buckets[i] ?? 0) + 1;
      batch.count++;
    },
    drain() {
      const out = [...batches.values()];
      batches = new Map();
      return { batches: out };
    },
    stats() {
      return { dropped };
    },
  };
}
