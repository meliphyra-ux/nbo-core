// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { NextResponse, type NextRequest } from "next/server";

// Rewrites onto prerender routes: the page must render as the destination,
// whatever path the visitor asked for.
export function proxy(request: NextRequest) {
  const destination = request.nextUrl.pathname === "/alias-ppr" ? "/visitor" : "/plain-static";
  return NextResponse.rewrite(new URL(destination, request.url));
}

export const config = {
  matcher: ["/alias-ppr", "/alias-static"],
};
