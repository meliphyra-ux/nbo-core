// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { Suspense } from "react";
import { draftMode } from "next/headers";
import { connection } from "next/server";

// Says whether the hole rendered in draft mode.
async function Status() {
  await connection();
  const { isEnabled } = await draftMode();
  return <p data-testid="draft-status">{`draft:${isEnabled}`}</p>;
}

export default function DraftPeekPage() {
  return (
    <main>
      <h1 data-testid="ppr-static">draft shell</h1>
      <Suspense fallback={<p data-testid="ppr-fallback">loading…</p>}>
        <Status />
      </Suspense>
    </main>
  );
}
