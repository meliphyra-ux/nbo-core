// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // cacheComponents is incompatible with the classic `export const
  // dynamic`/`revalidate` segment config fixtures/next-app uses
  // (confirmed directly: `next build` hard-errors naming the offending
  // export) — this fixture exists specifically to exercise PPR, so it
  // lives on its own rather than retrofitting next-app.
  //
  // partialPrefetching is deliberately left off: it's a separate
  // feature (client-side segment-navigation prefetch caching) that
  // explodes one route into five prerender entries instead of two —
  // out of scope for this extension (docs/nbo-spec.md's own
  // Prerendering and ISR section).
  cacheComponents: true,
  // Scaffolded with --no-agents-md; `next dev` otherwise regenerates
  // AGENTS.md on every run regardless of that flag.
  agentRules: false,
  adapterPath: "@nbo/next-adapter/src/adapter.js",
};

export default nextConfig;
