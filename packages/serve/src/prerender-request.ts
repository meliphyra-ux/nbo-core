// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The requests a render sends to a prerender route's function, and the router headers a page varies by.
import type { ServeState } from "./serve.js";

// CONDITIONAL_HEADERS make an upstream answer for one browser's copy
// (304 Not Modified, 412) instead of rendering the page.
// Range is dropped too: a partial render must never become the page.
export const CONDITIONAL_HEADERS = [
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "if-range",
  "range",
];

// ROUTER_HEADERS are what Next's client router and server actions add to a
// request. They change what the function answers (flight data instead of a
// page, a different tree, an action call).
export const ROUTER_HEADERS = [
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-hmr-refresh",
  "next-url",
  "next-action",
];

// ROUTER_NAVIGATION_HEADERS are the router headers a render for a client-side
// navigation needs, to answer with flight data for the part that changed.
export const ROUTER_NAVIGATION_HEADERS = ["rsc", "next-router-state-tree", "next-router-prefetch", "next-url"];

// RSC_VARY is what a response on a prerender route varies by: Next's own
// list, so a cache in front of NBO can't give a page to a router or flight
// data to a browser.
export const RSC_VARY = ["rsc", "next-router-state-tree", "next-router-prefetch"];

// A page and its flight data share a URL, so caches must key on the RSC request headers.
export function varyOnRSC(headers: Headers): void {
  const listed = new Set((headers.get("vary") ?? "").split(",").map((h) => h.trim().toLowerCase()));
  for (const h of RSC_VARY) {
    if (!listed.has(h)) headers.append("vary", h);
  }
}

// isRSCRequest is Next's own test (isRSCRequestHeader).
export function isRSCRequest(request: Request): boolean {
  return request.headers.get("rsc") === "1";
}

// renderRequest is the request an ISR render sends to the function: the
// visitor's request minus its conditional headers, because the result is
// stored for every visitor, not answered to this one. Without this a
// revisit carrying If-None-Match makes Next answer 304 with no body, and
// that empty body would be served (and cached) as the page. The router's
// headers go for the same reason: flight data stored under a page's key
// would be every visitor's page. It is always a GET: a HEAD visitor (uptime
// checks, link checkers) would otherwise get Next's empty HEAD answer cached
// as the page.
export function renderRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const h of [...CONDITIONAL_HEADERS, ...ROUTER_HEADERS]) headers.delete(h);
  return new Request(request.url, { method: "GET", headers });
}

// render calls the prerender route's own function directly and
// captures its response — used for draft mode and for onMiss:
// blocking, both of which need the result synchronously, before
// responding to the client — port of server.render (prerender.go
// lines 207-221).
export async function render(
  state: ServeState,
  request: Request,
  functionName: string,
): Promise<{ status: number; body: Uint8Array; header: Record<string, string[]> }> {
  if (!state.resolve) throw new Error("serve: no function resolver configured for this build");
  const handler = state.resolve(functionName);
  const res = await handler(request);
  const body = new Uint8Array(await res.arrayBuffer());
  // Fetch's Headers iterator yields one entry per Set-Cookie value
  // rather than folding them — the same bug class fixed in serve.ts's
  // handleFunction (final review finding C1): overwriting header[k]
  // on every entry would keep only the last cookie.
  const header: Record<string, string[]> = {};
  for (const [k, v] of res.headers) {
    if (k === "set-cookie") continue;
    header[k] = [v];
  }
  const cookies = res.headers.getSetCookie();
  if (cookies.length > 0) header["set-cookie"] = cookies;
  return { status: res.status, body, header };
}
