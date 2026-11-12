// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { AdapterCapabilities } from "@nbo/planner";

// capabilities is what this adapter publishes to the planner.
// fn.streaming is proven by Slice 2's streaming conformance test
// (internal/nodehost, internal/funcproxy). images.optimize is native
// too — real gap found running Slice 4's next/image verify script
// for real: @nbo/serve's own bundled sharp resizes images inside the
// same deployed container, with no separate service or cloud-
// specific wiring needed at all, so there's nothing to emulate.
// prerender.isr/prerender.onDemand are emulated, naming the real,
// separately deployed cache service (docs/nbo-spec.md's own "own
// cache tier, the same on every cloud" design call) — the exact same
// service on every adapter, matching Cloud Run's own identical
// declaration. route.middleware and cron need no capability
// declaration at all: the router/scheduler handle them regardless of
// adapter. Every other id in the spec's fixed vocabulary — geo.headers,
// fn.edge, fn.waitUntil, fn.arm64 — is still deliberately absent, so a
// build that needs one fails at plan time instead of deploying
// silently broken. Kubernetes itself enforces no execution duration
// or memory ceiling (those are operator-configured, not
// provider-imposed), so limits is the zero value: no numeric ceiling
// — port of Capabilities (capabilities.go lines 15-18), extended.
export const capabilities: AdapterCapabilities = {
  name: "kubernetes",
  native: { "fn.streaming": true, "images.optimize": true },
  emulated: { "prerender.isr": "platform-cache", "prerender.onDemand": "platform-cache" },
};
