// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Target } from "../registry.js";
import { pickSticky, readVisitorId } from "../sticky.js";
import type { Aggregator, Device } from "./aggregator.js";
import { METRICS, type Metric } from "./histogram.js";
import { MAX_ROUTE_LENGTH, normalizeRoute } from "./route.js";

export const MAX_BEACON_BYTES = 2048;
const MAX_TIMING_MS = 120_000;
const MAX_CLS = 10;
const CONTENT_ID_PATTERN = /^[A-Za-z0-9:._-]{0,128}$/;
const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9:._-]{0,128}$/;

// BOT_UA matches crawlers, headless browsers and lab tools. Lighthouse and
// PageSpeed runs are lab data, not real visitors, so they are dropped too.
// An empty user-agent is treated as a bot: browsers always send one.
export const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|gtmetrix|phantomjs|^$/i;

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function bad(reason: string): Response {
  return new Response(`edge: invalid beacon: ${reason}`, { status: 400 });
}

async function readLimited(request: Request, limit: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// handleBeacon takes one POST to /_nbo/insights/v1/vitals. Well-formed
// beacons get 204 even when they are not counted (bot, unknown
// environment, over a limit), so a client learns nothing from the answer;
// a malformed one gets 400; a host with Speed Insights off gets 404.
// Nothing about the visitor is kept: the cookie is only read to find the
// environment of a page that did not say (manual tag).
export async function handleBeacon(request: Request, target: Target, aggregator: Aggregator): Promise<Response> {
  if (!target.insights?.enabled) return new Response("not found", { status: 404 });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });

  // The rate cap comes first: a beacon over it is not read or parsed.
  if (!aggregator.admit(target.host)) {
    await request.body?.cancel().catch(() => {});
    return noContent();
  }
  const text = await readLimited(request, MAX_BEACON_BYTES);
  if (text === undefined) return bad("body over 2 KB");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad("not JSON");
  }
  if (!isRecord(body)) return bad("not an object");

  const { metric, value, route, device, environmentId, contentId } = body;
  if (typeof metric !== "string" || !(METRICS as readonly string[]).includes(metric)) return bad("unknown metric");
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return bad("value is not a finite number ≥ 0");
  if (value > (metric === "CLS" ? MAX_CLS : MAX_TIMING_MS)) return bad("value out of range");
  if (typeof route !== "string" || route.length > MAX_ROUTE_LENGTH) return bad("route");
  const normalized = normalizeRoute(route);
  if (normalized === undefined) return bad("route is not a path");
  if (device !== "mobile" && device !== "desktop") return bad("device");
  if (environmentId !== undefined && (typeof environmentId !== "string" || !ENVIRONMENT_ID_PATTERN.test(environmentId)))
    return bad("environmentId");
  if (contentId !== undefined && (typeof contentId !== "string" || !CONTENT_ID_PATTERN.test(contentId)))
    return bad("contentId");

  if (BOT_UA.test(request.headers.get("user-agent") ?? "")) return noContent();

  let env: string;
  if (typeof environmentId === "string") {
    const known = target.backends.some((b) => (b.id ?? "") === environmentId);
    if (!known) return noContent();
    env = environmentId;
  } else {
    // Manual tag: the page did not say which environment served it. The
    // visitor's cookie picks the same backend the proxy picked.
    const visitorId = readVisitorId(request.headers);
    if (!visitorId) return noContent();
    try {
      env = pickSticky(target, visitorId).id ?? "";
    } catch {
      return noContent();
    }
  }

  aggregator.add({
    host: target.host,
    environmentId: env,
    contentId: typeof contentId === "string" ? contentId : "",
    route: normalized.slice(0, MAX_ROUTE_LENGTH),
    metric: metric as Metric,
    device: device as Device,
    value,
  });
  return noContent();
}
