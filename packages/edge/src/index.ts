// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export { createRegistry, pick, type Registry, type Backend, type Target, type InsightsSettings } from "./registry.js";
export { createProxyHandler, type FetchHandler } from "./proxy.js";
export { createRelayHandler } from "./relay.js";
export { createAdminMux } from "./admin.js";
export { resolveEdgeAddrs } from "./main.js";
export { bucketIndex, bucketValue, metricValue, mergeBuckets, quantile, METRICS, type Metric, type Buckets } from "./insights/histogram.js";
export { createAggregator, type Aggregator, type Batch, type Device, type Sample } from "./insights/aggregator.js";
export { normalizeRoute } from "./insights/route.js";
export { SCRIPT_PATH, VITALS_PATH } from "./insights/script.js";
export { insightsTag } from "./insights/inject.js";
