// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { NextResponse } from "next/server";

export function middleware() {
  const res = NextResponse.next();
  res.headers.set("x-from-middleware", "1");
  return res;
}

export const config = { matcher: "/posts/:path*" };
