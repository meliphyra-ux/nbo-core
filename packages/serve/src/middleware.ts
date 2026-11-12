// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { MiddlewareOutcome, MiddlewareInvoker, HeaderOp, Decision } from "@nbo/router";
import type { Resolver, FetchHandler } from "@nbo/funcproxy";
import { NULL_BODY_STATUSES } from "./http-status.js";

// middlewareBudgetMs is the spec's own default (docs/nbo-spec.md's
// Middleware section): on timeout the invoker fails closed with 504,
// so an auth check is never skipped — matches Go's own
// middlewareBudget (middleware.go line 18).
const middlewareBudgetMs = 5000;

// middlewareRequestBodyCap bounds how much of the real request's
// body gets buffered before handing middleware its own independent
// copy — generous for the small SSR/API payloads this protocol
// targets, but finite so an oversized or slow upload can't exhaust
// memory indefinitely — matches Go's own middlewareRequestBodyCap
// (middleware.go line 25), exported since this task's own test for
// it needs the exact value.
export const middlewareRequestBodyCap = 10 << 20; // 10MiB

const reservedRequestHeaderPrefix = "x-nbo-request-header-";

// reservedResponseHeaders are the wire-protocol headers a middleware
// response uses to steer routing — never forwarded to the real
// client, and never merged into a continue/rewrite's carried-forward
// headers either — port of reservedResponseHeaders (middleware.go
// lines 36-40).
const reservedResponseHeaders = new Set(["x-nbo-next", "x-nbo-rewrite", "x-nbo-request-headers"]);

// framingHeaders is RFC 7230 §6.1's hop-by-hop set — describes one
// specific connection/transfer, never valid to forward onto a
// different response (middleware's own typically-null body via
// mergeHeaderOps, or — reused from serve.ts's own handleFunction — a
// proxied function response, which would otherwise carry a stale
// Content-Length or a bare Connection/Transfer-Encoding straight onto
// the client) — port of framingHeaders (middleware.go lines 55-65).
export const framingHeaders = new Set(["content-length", "transfer-encoding", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"]);

function cleanFailure(status: number): MiddlewareOutcome {
  return { continue: false, response: { kind: "middlewareHandled", middlewareStatus: status } };
}

function looksLikeAbsoluteURL(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

// splitPathAndQuery separates a rewrite target's path from its query
// string, if any — port of splitPathAndQuery (middleware.go lines
// 229-235).
function splitPathAndQuery(target: string): { path: string; query: string } {
  const idx = target.indexOf("?");
  if (idx === -1) return { path: target, query: "" };
  return { path: target.slice(0, idx), query: target.slice(idx + 1) };
}

// applyRequestHeaderOverrides replaces the request headers downstream
// sees with exactly the set middleware named in
// x-nbo-request-headers — a header the real client sent that isn't
// in that set is removed, not left alone — port of
// applyRequestHeaderOverrides (middleware.go lines 246-269).
function applyRequestHeaderOverrides(request: Request, responseHeaders: Headers): void {
  const namesValue = responseHeaders.get("x-nbo-request-headers");
  if (!namesValue) return;
  const names = namesValue
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  const keep = new Set(names.map((n) => n.toLowerCase()));
  for (const existing of [...request.headers.keys()]) {
    if (!keep.has(existing.toLowerCase())) request.headers.delete(existing);
  }
  for (const name of names) {
    request.headers.set(name, responseHeaders.get(reservedRequestHeaderPrefix + name) ?? "");
  }
}

// mergeHeaderOps carries every header the middleware set other than
// the reserved and framing ones, for the headerOps accumulator on a
// continue/rewrite — one HeaderOp per header *value*, so a header the
// middleware set more than once survives in full — port of
// mergeHeaderOps (middleware.go lines 277-288).
function mergeHeaderOps(headers: Headers): HeaderOp[] {
  const ops: HeaderOp[] = [];
  for (const [k, v] of headers) {
    // Fetch's Headers iterator yields one "set-cookie" entry per
    // stored value (never comma-folded, unlike every other header) —
    // handled once, below, via getSetCookie() instead of here, or
    // each value would be pushed twice.
    if (k === "set-cookie") continue;
    if (reservedResponseHeaders.has(k) || framingHeaders.has(k) || k.startsWith(reservedRequestHeaderPrefix)) continue;
    ops.push({ append: { [k]: v } });
  }
  for (const v of headers.getSetCookie()) {
    ops.push({ append: { "set-cookie": v } });
  }
  return ops;
}

// interpretMiddlewareResponse classifies a captured middleware
// response per docs/nbo-spec.md's Middleware section, purely by
// which reserved header is present, never by status code — port of
// interpretMiddlewareResponse (middleware.go lines 185-227).
async function interpretMiddlewareResponse(response: Response, request: Request): Promise<MiddlewareOutcome> {
  const headers = response.headers;

  if (headers.get("x-nbo-next") === "1") {
    applyRequestHeaderOverrides(request, headers);
    return { continue: true, mergeHeaders: mergeHeaderOps(headers) };
  }

  const rewrite = headers.get("x-nbo-rewrite");
  if (rewrite) {
    if (looksLikeAbsoluteURL(rewrite)) return cleanFailure(502);
    const { path, query } = splitPathAndQuery(rewrite);
    const url = new URL(request.url);
    url.search = query ? `?${query}` : "";
    Object.defineProperty(request, "url", { value: url.toString() });
    applyRequestHeaderOverrides(request, headers);
    return { continue: true, rewritePath: path, mergeHeaders: mergeHeaderOps(headers) };
  }

  // Any other response, including a redirect: send as-is, routing
  // ends. Every reserved header is stripped before it ever reaches
  // middlewareHeaders, along with the framing headers (Content-
  // Length chief among them) — this response's own body is about to
  // be read and re-wrapped below, so any pre-existing length/encoding
  // header would describe bytes that no longer match what's sent.
  const middlewareHeaders: Record<string, string[]> = {};
  for (const [k, v] of headers) {
    if (k === "set-cookie") continue; // handled once, below, to avoid double-counting
    if (reservedResponseHeaders.has(k) || framingHeaders.has(k) || k.startsWith(reservedRequestHeaderPrefix)) continue;
    middlewareHeaders[k] = [v];
  }
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) middlewareHeaders["set-cookie"] = cookies;

  // A null-body status (204, 304, …) gets no body: Node's Response
  // constructor throws on any body for them, even an empty one (a CORS
  // preflight answered with 204 is the common case).
  const middlewareBody = NULL_BODY_STATUSES.has(response.status) ? undefined : Buffer.from(await response.arrayBuffer());
  const decision: Decision = { kind: "middlewareHandled", middlewareStatus: response.status, middlewareHeaders, middlewareBody };
  return { continue: false, response: decision };
}

// readCapped reads body up to cap bytes, throwing past it — the
// manual-reader equivalent of Go's http.MaxBytesReader + io.ReadAll
// (middleware.go lines 133-141), since Fetch's own body-size limits
// aren't configurable per call.
async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      // Deliberately not calling reader.cancel() here — verified
      // directly: cancelling a reader that already received its
      // final chunk (done: false, but nothing left to read) hangs
      // indefinitely in this runtime. The whole request is about to
      // be discarded anyway (a 502 is returned, mwRequest's body is
      // never read again), so abandoning the reader uncancelled is
      // the safe choice over a cancel call that never resolves.
      throw new Error(`request body exceeds ${cap} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// createMiddlewareInvoker builds a router.MiddlewareInvoker that
// invokes a middleware function through resolve at the given budget
// (defaulting to middlewareBudgetMs, matching Go's own
// middlewareBudget) — port of
// newMiddlewareInvoker/newMiddlewareInvokerWithBudget (middleware.go
// lines 67-180).
export function createMiddlewareInvoker(resolve: Resolver | undefined, request: Request, budgetMs: number = middlewareBudgetMs): MiddlewareInvoker {
  // invoked tracks which function names this invoker has already run
  // this request — Next's own overlapping matchers can legitimately
  // dispatch the same middleware function more than once for one
  // request; a repeat call gets the same "continue" its first, real
  // invocation already gave, not run again.
  const invoked = new Set<string>();

  return async (functionName: string, _path: string, _method: string): Promise<MiddlewareOutcome> => {
    if (invoked.has(functionName)) return { continue: true };
    invoked.add(functionName);

    if (!resolve) return cleanFailure(502);
    let handler: FetchHandler;
    try {
      handler = resolve(functionName);
    } catch {
      return cleanFailure(502);
    }

    // The Fetch spec forbids reading a "disturbed" request twice —
    // clone before either side reads anything, so the later real
    // dispatch (serve.ts's own handleFunction, called against this
    // same request after this invoker returns) still sees the
    // original, unconsumed body.
    const cloned = request.body ? request.clone() : request;

    let bodyBytes: Uint8Array | null;
    try {
      bodyBytes = request.body ? await readCapped(cloned.body, middlewareRequestBodyCap) : null;
    } catch {
      return cleanFailure(502);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);

    // Carries the budget's own signal onto the request a real
    // resolver forwards (@nbo/funcproxy's own proxyRequest now reads
    // request.signal) — without this, a timed-out middleware call
    // still left its outbound fetch running for however long the
    // backend actually took, leaking a connection per timeout under
    // a degraded backend.
    const mwRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bodyBytes,
      signal: controller.signal,
      ...(bodyBytes ? { duplex: "half" } : {}),
    } as RequestInit);

    try {
      const response = await Promise.race([
        handler(mwRequest),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
        }),
      ]);
      return await interpretMiddlewareResponse(response, request);
    } catch (err) {
      if (err instanceof Error && err.message === "timeout") return cleanFailure(504);
      return cleanFailure(502);
    } finally {
      clearTimeout(timer);
    }
  };
}
