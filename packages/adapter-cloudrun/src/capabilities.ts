// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { AdapterCapabilities } from "@nbo/planner";

// capabilities is what this adapter publishes to the planner.
// fn.streaming is the only capability it runs natively today — the
// same proven scope as adapters/k8s (Slice 2's streaming conformance
// test). Limits are Cloud Run's own published per-container-instance
// ceilings (docs.cloud.google.com/run, checked 2026-10-24): 32 GiB
// memory, a request timeout configurable up to 3600s (default
// 300s — this is the adapter's declared *ceiling*, not what any one
// deploy requests), and a 32 MiB request/response body limit on
// HTTP/1 (HTTP/2 and streamed responses aren't limited, but the
// planner doesn't yet distinguish transport, so this is the
// conservative, always-safe number) — port of Capabilities
// (capabilities.go lines 18-26).
// images.optimize and prerender.isr/prerender.onDemand — same
// reasoning as @nbo/adapter-k8s's own identical declaration: a real
// gap found running Slice 4's next/image verify script for real.
export const capabilities: AdapterCapabilities = {
  name: "cloudrun",
  native: { "fn.streaming": true, "images.optimize": true },
  emulated: { "prerender.isr": "platform-cache", "prerender.onDemand": "platform-cache" },
  limits: {
    maxMemoryMB: 32768,
    maxDurationSec: 3600,
    maxRequestBodyMB: 32,
  },
};
