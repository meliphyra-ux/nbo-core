// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { timingSafeEqual } from "node:crypto";
import { proxyRequest } from "@nbo/funcproxy";
import type { FetchHandler } from "./proxy.js";

export const RELAY_TOKEN_HEADER = "x-nbo-relay-token";
export const RELAY_UPSTREAM_HEADER = "x-nbo-upstream";
// Only in-cluster Services of project namespaces on port 8080 are reachable
// through a relay.
export const RELAY_UPSTREAM_PATTERN = /^[a-z0-9-]{1,63}\.nbo-p-[a-z0-9]{1,16}\.svc\.cluster\.local:8080$/;

export interface RelayOptions {
  token: string;
  // Tests replace this to reach a local server instead of cluster DNS.
  fetchUpstream?: (url: URL, req: Request) => Promise<Response>;
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// createRelayHandler is the relay mode of the edge binary: it runs inside a
// remote cluster and forwards requests from the public edge to a Service there.
export function createRelayHandler(options: RelayOptions): FetchHandler {
  const fetchUpstream =
    options.fetchUpstream ??
    // x-forwarded-* pass through as received (proxyRequest copies headers).
    ((url: URL, req: Request) => proxyRequest(req, new URL(url.origin)));
  return async (request: Request): Promise<Response> => {
    if (!tokenMatches(request.headers.get(RELAY_TOKEN_HEADER), options.token)) {
      return new Response("relay: forbidden", { status: 403 });
    }
    const upstream = request.headers.get(RELAY_UPSTREAM_HEADER) ?? "";
    if (!RELAY_UPSTREAM_PATTERN.test(upstream)) {
      return new Response("relay: bad upstream", { status: 400 });
    }
    const headers = new Headers(request.headers);
    headers.delete(RELAY_TOKEN_HEADER);
    headers.delete(RELAY_UPSTREAM_HEADER);
    const incoming = new URL(request.url);
    const url = new URL(`http://${upstream}${incoming.pathname}${incoming.search}`);
    const forwarded = new Request(request, { headers });
    try {
      return await fetchUpstream(url, forwarded);
    } catch (err) {
      // The detail goes to the log only: the answer reaches visitors through the edge.
      console.error(`relay: upstream ${upstream} unreachable: ${String(err)}`);
      return new Response("relay: upstream unreachable", { status: 502 });
    }
  };
}
