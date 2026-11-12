// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { NextRequest } from "next/server";
import { runsOf } from "../action-log";

export async function GET(request: NextRequest) {
  return new Response(`runs:${runsOf(request.nextUrl.searchParams.get("name") ?? "")}`);
}
