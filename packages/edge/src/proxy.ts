// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { Agent } from "undici";
import { proxyRequest } from "@nbo/funcproxy";
import { CLIENT_IP_HEADER } from "@nbo/nodehost";
import { type Registry, type Backend } from "./registry.js";
import { newVisitorId, pickSticky, readVisitorId, stripVisitorCookie, visitorCookie } from "./sticky.js";
import { isDocumentNavigation, visitorScheme } from "./navigation.js";
import { isIP } from "node:net";
import type { CloudflareTrust } from "./cloudflare-trust.js";
import { RELAY_TOKEN_HEADER, RELAY_UPSTREAM_HEADER } from "./relay.js";
import { createAggregator, type Aggregator } from "./insights/aggregator.js";
import { handleBeacon } from "./insights/beacon.js";
import { createInsertionStream, insightsTag, shouldInsert } from "./insights/inject.js";
import { INSIGHTS_PREFIX, SCRIPT_PATH, VITALS_PATH, scriptResponse } from "./insights/script.js";

export type FetchHandler = (request: Request) => Promise<Response>;

// edgeResponseHeaderTimeoutMs bounds how long a single attempt waits
// for a backend to start responding — without it, a backend that
// accepts a connection but never responds hangs the request
// indefinitely instead of failing with a clean 502 — port of
// edgeResponseHeaderTimeout (proxy.go line 21).
//
// NBO_EDGE_HEADER_TIMEOUT_MS overrides it, for tests only (the black-box
// suite's never-answering backend); unset, it is 30 s.
export const edgeResponseHeaderTimeoutMs = headerTimeoutFromEnv(process.env.NBO_EDGE_HEADER_TIMEOUT_MS);

function headerTimeoutFromEnv(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n > 0 ? n : 30_000;
}

// buildDispatcher clones http.DefaultTransport's effective behavior via
// undici's own Agent defaults, only overriding headersTimeout (the
// direct equivalent of Go's ResponseHeaderTimeout — bounds only
// time-to-first-byte) and, for the insecure variant, connect's own
// rejectUnauthorized. bodyTimeout: 0 is deliberate, not an oversight:
// Go's ResponseHeaderTimeout never bounded body transfer at all, and
// undici's own default bodyTimeout (300s) would otherwise impose a
// limit Go's edge layer never had — port of newEdgeTransport (proxy.go
// lines 23-35).
function buildDispatcher(insecure: boolean, headersTimeoutMs: number): Agent {
  return new Agent({
    headersTimeout: headersTimeoutMs,
    bodyTimeout: 0,
    connect: insecure ? { rejectUnauthorized: false } : undefined,
  });
}

// edgeStrictDispatcher and edgeInsecureDispatcher are the only two
// dispatchers a proxied request ever uses — which one is chosen per
// request based on the picked Backend's own insecureSkipVerify field,
// never applied globally — port of edgeStrictTransport/
// edgeInsecureTransport (proxy.go lines 37-47).
let edgeStrictDispatcher = buildDispatcher(false, edgeResponseHeaderTimeoutMs);
const edgeInsecureDispatcher = buildDispatcher(true, edgeResponseHeaderTimeoutMs);

// setEdgeStrictDispatcherForTest replaces edgeStrictDispatcher and
// returns the previous value, so a test can restore it afterward.
//
// Ruling (Task 4): the plan's own brief called edgeStrictDispatcher/
// edgeInsecureDispatcher "mutable lets a test reassigns directly,
// matching proxy.go's own var edgeStrictTransport" — confirmed directly
// that this doesn't hold for a real ES module: Node throws "Cannot
// assign to read only property" when outside code assigns to an
// imported `let` binding (Go's package-level var has no such
// restriction for a same-package test). Only this module's own code may
// reassign its own `let`; this function does that reassignment on a
// test's behalf, which is the ESM-correct equivalent of the brief's
// intent. Cost if wrong: the one timeout test (Task 4, test 5) would
// need a different seam, not a correctness issue in production code.
export function setEdgeStrictDispatcherForTest(dispatcher: Agent): Agent {
  const previous = edgeStrictDispatcher;
  edgeStrictDispatcher = dispatcher;
  return previous;
}

// One Agent per distinct relay CA: the relay's certificate is trusted only
// if signed by that CA, never insecurely.
const relayDispatchers = new Map<string, Agent>();
function relayDispatcher(caPem: string): Agent {
  let agent = relayDispatchers.get(caPem);
  if (!agent) {
    agent = new Agent({ headersTimeout: edgeResponseHeaderTimeoutMs, bodyTimeout: 0, connect: { ca: caPem } });
    relayDispatchers.set(caPem, agent);
  }
  return agent;
}

function dispatcherFor(backend: Backend): Agent {
  if (backend.via) return relayDispatcher(backend.via.caPem);
  return backend.insecureSkipVerify ? edgeInsecureDispatcher : edgeStrictDispatcher;
}

// createProxyHandler builds the edge layer's data-plane handler: for
// every request, it resolves the request's own Host header against
// registry (404 if unknown), picks one of that Target's Backends per
// the Registry's weights, and reverse proxies to it via
// @nbo/funcproxy's own proxyRequest — port of NewProxyHandler/
// proxyToBackend (proxy.go lines 49-112), with httputil.ReverseProxy's
// own job entirely absorbed by proxyRequest (hop-by-hop header
// stripping, redirect: "manual", the outgoing Host computed by fetch()
// itself, a stale content-encoding/content-length stripped after
// transparent decompression — all already real, already tested there).
export interface ProxyOptions {
  // insights receives Speed Insights beacons; main.ts shares it with the
  // admin API, which drains it. Defaults to a private one.
  insights?: Aggregator;
  // scheme is the listener's own scheme (cluster mode). When set, the cookie's
  // Secure flag and x-forwarded-proto come from it, x-forwarded-for is the
  // address nodeToFetch's clientIp option recorded, and anything the visitor
  // sent in x-forwarded-proto, x-forwarded-for, x-real-ip or forwarded is
  // ignored. Unset (dev): today's behaviour.
  scheme?: "http" | "https";
  // cloudflareTrust: Cloudflare address ranges (cluster mode). A marked
  // target believes cf-connecting-ip from a peer inside them.
  cloudflareTrust?: CloudflareTrust;
}

export function createProxyHandler(registry: Registry, options: ProxyOptions = {}): FetchHandler {
  const aggregator = options.insights ?? createAggregator();
  const schemeOf = (request: Request): "http" | "https" => options.scheme ?? visitorScheme(request);
  return async (request: Request): Promise<Response> => {
    const host = request.headers.get("host") ?? "";
    const target = registry.get(host);
    if (!target) {
      return new Response(`edge: no target registered for host ${host}`, { status: 404 });
    }

    // Speed Insights endpoints, answered by the edge itself before any
    // backend is picked (no visitor cookie is set for them). On a host
    // with Speed Insights off these paths go to the app, as before.
    const insights = target.insights?.enabled ? target.insights : undefined;
    if (insights) {
      const path = new URL(request.url).pathname;
      if (path.startsWith(INSIGHTS_PREFIX)) {
        if (path === SCRIPT_PATH && (request.method === "GET" || request.method === "HEAD")) {
          const res = scriptResponse(insights.sampleRate);
          return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
        }
        if (path === VITALS_PATH) {
          try {
            return await handleBeacon(request, target, aggregator);
          } catch {
            return new Response(null, { status: 204 });
          }
        }
        return new Response("not found", { status: 404 });
      }
    }

    const cloudflareMarked = target.cloudflare === true;
    // forward sends one request on to one backend (or its relay) with the
    // headers every proxied request gets; it throws when the call fails.
    const forward = async (backend: Backend, outgoing: Request): Promise<Response> => {
      // A fan-out copy goes as bytes, not a stream: fetch turns a 401 to a
      // streamed body into a network error, which would hide the status.
      const buffered = outgoing === request ? {} : { body: await outgoing.arrayBuffer() };
      const forwardHeaders = new Headers(outgoing.headers);
      const cfIp = options.scheme ? request.headers.get("cf-connecting-ip") : null;
      stripVisitorCookie(forwardHeaders);
      // Visitors may never set the relay headers; only the edge does.
      forwardHeaders.delete(RELAY_TOKEN_HEADER);
      forwardHeaders.delete(RELAY_UPSTREAM_HEADER);
      if (options.scheme) {
        for (const h of ["x-forwarded-proto", "x-forwarded-for", "x-real-ip", "forwarded", "cf-connecting-ip", "true-client-ip", CLIENT_IP_HEADER]) forwardHeaders.delete(h);
      }
      const forwarded =
        "body" in buffered
          ? new Request(outgoing.url, { method: outgoing.method, headers: forwardHeaders, signal: outgoing.signal })
          : new Request(outgoing, { headers: forwardHeaders });
      const extra: Record<string, string> = { "x-forwarded-host": host, "x-forwarded-proto": schemeOf(request) };
      const clientIp = options.scheme ? request.headers.get(CLIENT_IP_HEADER) : null;
      if (clientIp) extra["x-forwarded-for"] = clientIp;
      if (clientIp && cfIp && cloudflareMarked && isIP(cfIp) !== 0 && options.cloudflareTrust?.has(clientIp)) {
        extra["x-forwarded-for"] = cfIp;
      }
      let url = new URL(backend.url);
      if (backend.via) {
        extra[RELAY_TOKEN_HEADER] = backend.via.token;
        extra[RELAY_UPSTREAM_HEADER] = url.host;
        url = new URL(backend.via.url);
      }
      return proxyRequest(forwarded, url, extra, { dispatcher: dispatcherFor(backend), ...buffered });
    };

    // A revalidation goes to every backend, before any sticky pick: no
    // visitor cookie, no single backend, never cached.
    if (isRevalidateRequest(request)) return fanOutRevalidate(request, target.backends, forward, host);

    // Keep the visitor on one cloud: their cookie id picks the backend
    // (see sticky.ts). A visitor without one gets a new id, served and,
    // on a page navigation, remembered in the same response. Other
    // requests without a cookie (assets, API calls) are picked by a fresh
    // id but not given a cookie: Set-Cookie on an asset stops CDNs from
    // caching it.
    const knownId = readVisitorId(request.headers);
    const visitorId = knownId ?? newVisitorId();

    let backend: Backend;
    try {
      backend = pickSticky(target, visitorId);
    } catch (err) {
      return new Response(`edge: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
    }

    let response: Response;
    try {
      response = await forward(backend, request);
    } catch (err) {
      return new Response(`edge: ${String(err)}`, { status: 502 });
    }

    // Lets a real end-to-end run (and operators generally) see which
    // backend actually served a request — without this, there was no
    // way to prove a weighted split was honored rather than just "some
    // backend answered".
    const headers = new Headers(response.headers);
    headers.set("x-nbo-edge-backend", backend.url);
    if (!knownId && isDocumentNavigation(request.headers)) headers.append("set-cookie", visitorCookie(visitorId, schemeOf(request) === "https"));

    let body = response.body;
    if (insights?.inject && shouldInsert(request, response)) {
      const tag = insightsTag({ environmentId: backend.id ?? "", contentId: response.headers.get("x-nbo-deployment-id") ?? "", sampleRate: insights.sampleRate });
      body = response.body!.pipeThrough(createInsertionStream(tag));
      headers.delete("content-length");
      // The bytes changed, so a strong validator no longer holds; a weak
      // one still does (the insertion is the same for the same page).
      const etag = headers.get("etag");
      if (etag && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);
    }
    return new Response(body, { status: response.status, headers });
  };
}

// ---------- revalidation fan-out

// REVALIDATE_PATH: the spec's on-demand revalidation endpoint. A POST to it
// goes to every backend of the host (weights ignored, 0% ones too), so one
// call reaches every cloud's cache; anything else there is proxied as usual.
export const REVALIDATE_PATH = "/_nbo/revalidate";
// FANOUT_MAX_BODY_BYTES: the largest revalidation body the edge buffers.
export const FANOUT_MAX_BODY_BYTES = 65_536;
// fanOutTimeoutMs: each backend's limit to answer, 10 s, capped by the
// header timeout (NBO_EDGE_HEADER_TIMEOUT_MS, which tests lower).
export const fanOutTimeoutMs = Math.min(10_000, edgeResponseHeaderTimeoutMs);

export function isRevalidateRequest(request: Request): boolean {
  return request.method === "POST" && new URL(request.url).pathname === REVALIDATE_PATH;
}

// readCapped reads a body of at most max bytes; undefined when it is longer.
async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return undefined;
  if (!request.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// fanOutRevalidate buffers the body once (413 over 64 KiB, before any
// backend is called) and sends the same method, path, headers and body to
// every backend in parallel through forward, each bounded by
// fanOutTimeoutMs. Answer: 204 when all answered 2xx; the shared status
// when all answered the same non-2xx; else 502 listing each backend's id
// (its URL without one) and status (0: unreachable or timed out). Every
// answer carries x-nbo-edge-fanout and is never cached.
export async function fanOutRevalidate(
  request: Request,
  backends: Backend[],
  forward: (backend: Backend, request: Request) => Promise<Response>,
  host: string = request.headers.get("host") ?? "",
): Promise<Response> {
  const headers = { "x-nbo-edge-fanout": String(backends.length), "cache-control": "no-store" };
  // The registry refuses a target with no backends; should one ever get
  // through, it is answered as an unknown host, never as a 204 for "all of none".
  if (backends.length === 0) return new Response(`edge: no target registered for host ${host}`, { status: 404, headers });
  let body: Uint8Array<ArrayBuffer> | undefined;
  try {
    body = await readCapped(request, FANOUT_MAX_BODY_BYTES);
  } catch {
    return new Response("edge: the request body could not be read", { status: 400, headers });
  }
  if (body === undefined) {
    return new Response("edge: revalidation body over 65536 bytes", { status: 413, headers });
  }
  const outHeaders = new Headers(request.headers);
  outHeaders.delete("content-length");
  outHeaders.delete("transfer-encoding");
  const statuses = await Promise.all(
    backends.map(async (backend): Promise<number> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(0);
        }, fanOutTimeoutMs);
      });
      const call = (async () => {
        const res = await forward(backend, new Request(request.url, { method: request.method, headers: outHeaders, body, signal: controller.signal }));
        await res.body?.cancel().catch(() => {});
        return res.status;
      })().catch(() => 0);
      try {
        return await Promise.race([call, timeout]);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const ok = (s: number) => s >= 200 && s <= 299;
  if (statuses.every(ok)) return new Response(null, { status: 204, headers });
  if (statuses[0] !== 0 && statuses.every((s) => s === statuses[0])) return new Response(null, { status: statuses[0], headers });
  return Response.json({ backends: backends.map((b, i) => ({ id: b.id ?? b.url, status: statuses[i] })) }, { status: 502, headers });
}
