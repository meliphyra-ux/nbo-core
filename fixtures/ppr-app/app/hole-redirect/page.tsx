// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";

// redirect() inside a hole: the 200 and the shell are already on their way
// when it runs, so it can't become a 307.
async function Hole() {
  await connection();
  redirect("/plain-static");
  return null;
}

export default function HoleRedirectPage() {
  return (
    <main>
      <h1 data-testid="ppr-static">redirect shell</h1>
      <Suspense fallback={<p data-testid="ppr-fallback">loading…</p>}>
        <Hole />
      </Suspense>
    </main>
  );
}
