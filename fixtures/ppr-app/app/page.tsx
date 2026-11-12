// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { Suspense } from "react";
import { connection } from "next/server";

// CachedGreeting demonstrates "use cache" directly — it must stay a
// separate component from DynamicPart below: a real build confirmed
// directly that connection() can't be called anywhere inside a "use
// cache" boundary, even transitively through an uncached child, since
// a cached function may run during prerendering with no real request
// to read a connection from.
async function CachedGreeting() {
  "use cache";
  return <p data-testid="ppr-static">static shell</p>;
}

// DynamicPart is deliberately NOT "use cache" — connection() forces a
// genuinely per-request render, which is what gives this route a real
// postponedState (a page with no unresolved dynamic hole renders
// fully static and never gets one) — confirmed directly this session
// with a real cacheComponents build.
async function DynamicPart() {
  await connection();
  // eslint-disable-next-line react-hooks/purity -- deliberate: this fixture's whole job is an externally observable value that changes on every real resume render, proving the dynamic hole actually resumed rather than replaying a cached one
  return <p data-testid="ppr-dynamic">{Date.now()}</p>;
}

export default function PprDemoPage() {
  return (
    <main>
      <h1>NBO Slice 5 PPR fixture</h1>
      <CachedGreeting />
      <Suspense fallback={<p data-testid="ppr-fallback">loading…</p>}>
        <DynamicPart />
      </Suspense>
    </main>
  );
}
