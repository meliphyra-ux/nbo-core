// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";

// notFound() inside a hole: as with redirect(), the status is already sent.
async function Hole() {
  await connection();
  notFound();
  return null;
}

export default function HoleNotFoundPage() {
  return (
    <main>
      <h1 data-testid="ppr-static">not-found shell</h1>
      <Suspense fallback={<p data-testid="ppr-fallback">loading…</p>}>
        <Hole />
      </Suspense>
    </main>
  );
}
