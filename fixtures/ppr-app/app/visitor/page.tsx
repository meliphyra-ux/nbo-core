// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { Suspense } from "react";
import { cookies } from "next/headers";
import { setTimeout as sleep } from "node:timers/promises";

// Visitor proves two things about a resumed hole: it sees the visitor's
// own cookies, and the sleep gives scripts/verify-slice5-ppr.sh a gap to
// measure, because the shell must arrive before the hole does.
async function Visitor() {
  const name = (await cookies()).get("ppr-visitor")?.value ?? "logged-out";
  await sleep(1000);
  return <p data-testid="ppr-visitor">{`visitor:${name}`}</p>;
}

export default function VisitorPage() {
  return (
    <main>
      <h1 data-testid="ppr-static">visitor shell</h1>
      <Suspense fallback={<p data-testid="ppr-fallback">loading…</p>}>
        <Visitor />
      </Suspense>
    </main>
  );
}
