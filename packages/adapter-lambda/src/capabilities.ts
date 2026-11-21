// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { AdapterCapabilities } from "@nbo/planner";

// capabilities: what Lambda runs natively (response streaming through
// RESPONSE_STREAM function URLs, next/image in nbo serve) and Lambda's own
// ceilings: 10240 MB memory, a 900 s timeout, a 6 MB request payload.
// A Lambda can't host the in-memory ISR cache service, so prerender routes
// plan with a note and are served uncached (spec 2026-11-20, non-goals).
export const capabilities: AdapterCapabilities = {
  name: "lambda",
  native: { "fn.streaming": true, "images.optimize": true },
  emulated: { "prerender.isr": "uncached", "prerender.onDemand": "uncached" },
  notes: {
    "prerender.isr": "served uncached on Lambda: every request to a prerender route reaches the function",
    "prerender.onDemand": "nothing to revalidate on Lambda: prerender routes are served uncached",
  },
  limits: { maxMemoryMB: 10240, maxDurationSec: 900, maxRequestBodyMB: 6 },
};
