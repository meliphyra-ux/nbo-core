// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export const dynamic = "force-dynamic";

export function GET(request) {
  return Response.json({ hello: new URL(request.url).searchParams.get("name") ?? "world" });
}
