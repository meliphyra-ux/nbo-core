// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Partial prerendering: the shell served at once with the function's resume streamed behind it.
import type { Decision } from "@nbo/router";
import {
  applyHeaderOps,
  decodeFullyURI,
  handleFunction,
  platformOnlyHeaders,
  readStaticFile,
  type PrerenderConfig,
  type ServeState,
} from "./serve.js";
import { CONDITIONAL_HEADERS, ROUTER_HEADERS, ROUTER_NAVIGATION_HEADERS, isRSCRequest } from "./prerender-request.js";

// resumeRequest is the call that renders a route's dynamic hole. The
// hole renders for this visitor, so cookies() and headers() must see the
// visitor's own headers, and searchParams its query string. Left out:
// conditional headers (a 304 can't continue a shell), the original's body
// framing (this request has its own body) and anything a visitor could
// use to pose as the platform, or to turn this into a server action.
// accept-encoding is pinned because the function's bytes go straight after
// the shell's uncompressed ones.
//
// An empty postponedState is Next's other kind of resume: no state to
// continue, so it renders the whole route for this request (the comment in
// app-page-runtime.js: "An empty string represents a resume request without
// postponed state, which should perform a full dynamic render").
export function resumeRequest(
  request: Request,
  path: string,
  postponedState: string,
  signal: AbortSignal,
  keep: string[] = [],
): Request {
  const headers = new Headers();
  const dropped = new Set([
    ...CONDITIONAL_HEADERS,
    ...platformOnlyHeaders,
    ...ROUTER_HEADERS,
    "x-prerender-revalidate",
    "content-length",
    "content-type",
  ]);
  for (const h of keep) dropped.delete(h);
  for (const [name, value] of request.headers) {
    if (!dropped.has(name)) headers.append(name, value);
  }
  headers.set("next-resume", "1");
  headers.set("x-matched-path", path);
  headers.set("accept-encoding", "identity");
  return new Request(request.url, { method: "POST", headers, body: postponedState, signal });
}

// forwardToFunction hands a request to the route's function and streams the
// answer: for anything that isn't stored and isn't the shell.
export function forwardToFunction(
  state: ServeState,
  request: Request,
  cfg: PrerenderConfig,
  decision: Decision,
): Promise<Response> {
  return handleFunction(state, request, {
    kind: "function",
    functionName: cfg.function,
    headerOps: decision.headerOps,
  });
}

// forwardFlightData is forwardToFunction for an RSC request. Next writes
// s-maxage for the platform to read; passed on, a shared cache that ignores
// Vary would store flight data at the page's URL.
export async function forwardFlightData(
  state: ServeState,
  request: Request,
  cfg: PrerenderConfig,
  decision: Decision,
): Promise<Response> {
  const res = await forwardToFunction(state, request, cfg, decision);
  const cacheControl = res.headers.get("cache-control") ?? "";
  if (!cacheControl.includes("private") && !cacheControl.includes("no-store"))
    res.headers.set("cache-control", "private");
  return res;
}

// renderForOneVisitor is a whole render of a PPR route, for this request
// only. In minimal mode a plain GET can't do it: Next treats that as a
// revalidation and answers with the static prerender (the shell, unfinished,
// or flight data with no hole), so this is the empty resume.
export async function renderForOneVisitor(
  state: ServeState,
  request: Request,
  path: string,
  cfg: PrerenderConfig,
  decision: Decision,
): Promise<Response> {
  const res = await forwardToFunction(
    state,
    resumeRequest(request, path, "", request.signal, ROUTER_NAVIGATION_HEADERS),
    cfg,
    decision,
  );
  res.headers.set("cache-control", "private, no-store");
  return res;
}

export const documentClose = new TextEncoder().encode("</body></html>");

// streamAfterShell is the body of a PPR response: the shell at once, then
// the function's body piped behind it chunk by chunk. render() can't do
// this, it buffers because ISR has to store the whole page. The resume
// starts here, concurrently with the shell, not when the reader gets past
// it.
//
// The 200 and the shell are already sent when the resume answers, so a
// failure can't change the status. It is logged, and the document is
// closed so the visitor keeps the shell with its Suspense fallback.
export function streamAfterShell(
  shell: Uint8Array,
  startResume: (signal: AbortSignal) => Promise<Response>,
  visitorSignal: AbortSignal,
  routeID: string,
): ReadableStream<Uint8Array> {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([visitorSignal, cancelled.signal]);
  const resume = startResume(signal);
  // Read in pull(); this keeps a rejection nobody has reached yet from
  // counting as unhandled.
  resume.catch(() => {});
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let shellSent = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!shellSent) {
        shellSent = true;
        controller.enqueue(shell);
        return;
      }
      try {
        if (!reader) {
          const res = await resume;
          if (cancelled.signal.aborted) return;
          if (res.status !== 200 || !res.body) {
            res.body?.cancel().catch(() => {});
            throw new Error(`function answered ${res.status}`);
          }
          reader = res.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        if (cancelled.signal.aborted) return;
        if (!signal.aborted)
          console.error(
            JSON.stringify({ level: "error", msg: "ppr resume failed", route: routeID, error: String(err) }),
          );
        controller.enqueue(documentClose);
        controller.close();
      }
    },
    async cancel(reason) {
      cancelled.abort(reason);
      // A function that answers despite the abort still has a body to
      // release.
      resume.then((res) => (res.body?.locked ? undefined : res.body?.cancel())).catch(() => {});
      await reader?.cancel(reason);
    },
  });
}

// handlePPR serves a PPR-flagged route. Next's client never sends the
// "next-resume" request (next/dist/client has no reference to it): as in
// Vercel's minimal-mode model, the platform resumes the dynamic hole and
// appends it to the shell, in one response. A GET therefore answers with
// the shell's raw bytes and pipes the function's resume answer after them
// (POST, next-resume: 1, the route's postponedState as the body, exactly
// what app-page-runtime.js expects). The shell's unfinished streaming
// markers are completed by the resume's $RC(...) script and closing tags,
// which makes one document. A HEAD gets the same status and headers from
// the shell, with no function call.
//
// A client-side navigation (a GET with rsc) and a draft-mode GET need the
// whole route rendered for this request: renderForOneVisitor, streamed. A
// static prefetch (rsc with next-router-prefetch: 1) is the shell's flight
// data, which a plain GET is the way to ask for. Anything else (a server
// action POST) goes to the function unchanged. Segment-level navigation
// caching (Partial Prefetching) is this extension's stated non-goal, so
// nothing here is cached.
export async function handlePPR(
  state: ServeState,
  request: Request,
  cfg: PrerenderConfig,
  decision: Decision,
  draft: boolean,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET") {
    const prefetch = request.headers.get("next-router-prefetch") === "1";
    if (draft || (isRSCRequest(request) && !prefetch)) return renderForOneVisitor(state, request, path, cfg, decision);
    if (isRSCRequest(request)) return forwardFlightData(state, request, cfg, decision);
  } else if (request.method !== "HEAD") {
    return forwardToFunction(state, request, cfg, decision);
  }

  const entry = state.index.get(decodeFullyURI(path));
  if (!entry) return new Response(`serve: no seed for ${path} on prerender route ${cfg.id}`, { status: 404 });
  const shellBytes = await readStaticFile(state, entry);
  if (!shellBytes) return new Response(`serve: no seed for ${path} on prerender route ${cfg.id}`, { status: 404 });

  const headers = new Headers();
  headers.set("content-type", entry.contentType);
  applyHeaderOps(headers, decision.headerOps ?? []);
  // After the header ops, so a route rule can't weaken it: unlike the static
  // shell bytes alone, this response embeds a render for one visitor (their
  // cookies included) and must never be reused for another.
  headers.set("cache-control", "private, no-store");
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });

  const postponedState = cfg["x-nbo-ppr"]!.postponedState;
  const startResume = async (signal: AbortSignal) => {
    if (!state.resolve) throw new Error("serve: no function resolver configured for this build");
    return state.resolve(cfg.function)(resumeRequest(request, path, postponedState, signal));
  };
  return new Response(streamAfterShell(shellBytes, startResume, request.signal, cfg.id), { status: 200, headers });
}
