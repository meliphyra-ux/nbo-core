// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash, timingSafeEqual } from "node:crypto";
import type { Backend, Registry } from "./registry.js";
import { hasOnlyKeys, isRecord, parseBackend, parseInsightsSettings } from "./route-table.js";
import type { FetchHandler } from "./proxy.js";
import type { Aggregator } from "./insights/aggregator.js";

const allowedBodyKeys = new Set(["backends", "insights"]);

export interface AdminOptions {
  // insights is the aggregator GET /insights/drain empties.
  insights?: Aggregator;
  // drainToken, when set (cluster mode), makes this a drain-only API: only
  // GET /insights/drain?token=<t> answers, everything else is 404.
  drainToken?: string;
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
// createAdminMux builds the edge layer's admin API — loopback-only by
// convention when wired up (main.ts binds it to 127.0.0.1), the same
// mitigation cmd/control-plane's own final review landed on for its
// unauthenticated write surface, applied here from the start instead of
// after a finding. A manual path/method match, not a generic router —
// two routes don't earn one. Port of NewAdminMux (admin.go lines 8-44).
export function createAdminMux(registry: Registry, options: AdminOptions = {}): FetchHandler {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (options.drainToken !== undefined && url.pathname !== "/insights/drain") {
      return new Response("not found", { status: 404 });
    }
    if (url.pathname === "/insights/drain") {
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
      if (options.drainToken !== undefined && !tokenMatches(url.searchParams.get("token"), options.drainToken)) {
        return new Response("forbidden", { status: 403 });
      }
      return Response.json(options.insights ? options.insights.drain() : { batches: [] });
    }
    const match = url.pathname.match(/^\/targets\/(.+)$/);
    if (!match) {
      return new Response("not found", { status: 404 });
    }
    const host = match[1]!;

    if (request.method === "PUT") {
      let body: unknown;
      try {
        body = await request.json();
      } catch (err) {
        return new Response(`edge: invalid request body: ${err instanceof Error ? err.message : String(err)}`, { status: 400 });
      }
      if (!isRecord(body) || !hasOnlyKeys(body, allowedBodyKeys) || !Array.isArray(body.backends)) {
        return new Response("edge: invalid request body", { status: 400 });
      }
      const insights = parseInsightsSettings(body.insights);
      if (insights === "invalid") {
        return new Response("edge: invalid insights settings", { status: 400 });
      }
      const backends: Backend[] = [];
      const seenIds = new Set<string>();
      for (const raw of body.backends) {
        // via is route-table only; the dev admin API rejects it.
        const backend = parseBackend(raw, false, seenIds);
        if (!backend) return new Response("edge: invalid request body", { status: 400 });
        backends.push(backend);
      }
      try {
        registry.set(host, backends, insights);
      } catch (err) {
        return new Response(err instanceof Error ? err.message : String(err), { status: 400 });
      }
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET") {
      const target = registry.get(host);
      if (!target) {
        return new Response(`edge: no target registered for host ${host}`, { status: 404 });
      }
      return Response.json(target);
    }

    if (request.method === "DELETE") {
      registry.remove(host);
      return new Response(null, { status: 204 });
    }

    return new Response("method not allowed", { status: 405 });
  };
}
