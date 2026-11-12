// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { cacheLife } from "next/cache";

// A hole-less page with a real cache lifetime: "use cache" + cacheLife makes
// Next report a numeric initialRevalidate instead of false.
async function Stamp() {
  "use cache";
  cacheLife({ stale: 30, revalidate: 2, expire: 3600 });
  return <p data-testid="cache-life">{`rendered:${Date.now()}`}</p>;
}

export default function CacheLifePage() {
  return <Stamp />;
}
