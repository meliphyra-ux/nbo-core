// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { draftMode } from "next/headers";

// Turns Next's own draft mode on for this browser.
export async function GET() {
  (await draftMode()).enable();
  return new Response("draft on");
}
