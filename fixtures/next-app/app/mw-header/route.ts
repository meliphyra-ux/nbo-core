// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export async function GET(request: Request) {
  return Response.json({ echoed: request.headers.get("x-mw-echo") });
}
