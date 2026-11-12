// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Slice 2's SSR conformance fixture: force-dynamic so Next emits this as a
// real appPages/nodejs output (not an auto-static prerender, which Slice 2's
// adapter deliberately rejects — ISR/prerendering is Slice 4 scope). Content
// stays fixed and deterministic despite rendering fresh on every request, so
// a conformance transcript's body digest stays stable across runs.
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>NBO Slice 2 SSR fixture</h1>
      <p>This page is server-rendered on every request.</p>
    </main>
  );
}
