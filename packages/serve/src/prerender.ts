// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Decision } from "@nbo/router";
import type { FetchHandler } from "@nbo/funcproxy";
import { NULL_BODY_STATUSES, isCacheableStatus } from "./http-status.js";
import { serveStaticEntry, readStaticFile, applyHeaderOps, notFound, decodeFullyURI, handleFunction, platformOnlyHeaders, type ServeState, type PrerenderConfig } from "./serve.js";

// ISR_CACHE_KEY is the fixed name the ISR cache service is
// resolved under — reached exactly the way a function is (the same
// Resolver mechanism, not a second HTTP client), so it needs a name
// to resolve by even though it's never a real entry in manifest.json's
// own functions array — port of IsrCacheFunctionName (prerender.go
// line 27).
// A deploy bakes the cache's URL into /functions.json under this key; function
// names match ^[a-z][a-z0-9-]{0,62}$, so it can never clash with one.
export const ISR_CACHE_KEY = "__isrcache";
// IsrCacheFunctionName is the older name of ISR_CACHE_KEY.
export const IsrCacheFunctionName = ISR_CACHE_KEY;

// CACHE_READ_TIMEOUT_MS bounds a cache read: a slower cache is a miss, so a
// cold or stuck cache adds at most this much to a page.
export const CACHE_READ_TIMEOUT_MS = 2000;

// CACHE_WRITE_TIMEOUT_MS bounds a cache write or invalidation: a cache that
// accepts a connection and never answers can't hold a page body (or a
// regeneration's in-flight mark) for longer than this.
export const CACHE_WRITE_TIMEOUT_MS = 5000;

// BACKGROUND_WRITE_LIMIT caps the background writes in flight per process.
// A write beyond it is skipped and counted, never queued: the next request
// for that page renders again.
export const BACKGROUND_WRITE_LIMIT = 64;

// backgroundWrites counts the background writes in flight and those skipped
// at the cap.
export const backgroundWrites = { inFlight: 0, skipped: 0 };

// raceTimeout rejects with message when p hasn't settled within ms.
function raceTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timedOut]).finally(() => clearTimeout(timer));
}

// loadPrerenderDoc reads prerender.json — optional, the same way
// manifest.json already is for loadTrailingSlashPolicy. Order is
// preserved so createRouter compiles prerender routes in the same
// deterministic order they were written in — port of
// loadPrerenderDoc (prerender.go lines 62-80).
export async function loadPrerenderDoc(nboDir: string): Promise<PrerenderConfig[]> {
  let raw: string;
  try {
    raw = await readFile(join(nboDir, "prerender.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const doc = JSON.parse(raw) as { prerenders?: PrerenderConfig[] };
  return doc.prerenders ?? [];
}

// prerenderCacheKey hashes the normalized path plus exactly the
// allowQuery params and varyHeaders listed, sorted for a stable key —
// an unlisted query param or header never fragments the cache, and
// two requests differing in a listed one never collide — port of
// prerenderCacheKey (prerender.go lines 93-117).
//
// scope is the build's content id: the key becomes `<scope>.<hash>`, so
// builds sharing one cache during a rollout never read each other's pages.
export function prerenderCacheKey(request: Request, cfg: PrerenderConfig, scope?: string): string {
  const url = new URL(request.url);
  const hash = createHash("sha256");
  // Go's own r.URL.Path is already fully decoded; matching that here
  // means two requests for the same page differing only in
  // percent-encoding style (e.g. a literal "é" vs "%C3%A9") hash to
  // the same cache key instead of silently fragmenting the cache.
  hash.update(`path:${decodeFullyURI(url.pathname)}`);

  const queryNames = [...(cfg.allowQuery ?? [])].sort();
  for (const name of queryNames) {
    if (url.searchParams.has(name)) {
      hash.update(`|q:${name}=${url.searchParams.get(name)}`);
    }
  }

  const headerNames = [...(cfg.varyHeaders ?? [])].sort();
  for (const name of headerNames) {
    hash.update(`|h:${name.toLowerCase()}=${request.headers.get(name) ?? ""}`);
  }

  const digest = hash.digest("base64url");
  return scope === undefined ? digest : `${scope}.${digest}`;
}

// isDraftMode reports whether request carries the cookie matching
// cfg's own bypass token — draft mode skips the cache entirely in
// both directions, so this check gates reading or writing the cache
// at all, not just which body gets served — port of isDraftMode
// (prerender.go lines 119-133).
function isDraftMode(request: Request, cfg: PrerenderConfig): boolean {
  const token = process.env[cfg.bypassToken.env];
  if (!token) return false;
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [name, value] = part.trim().split("=", 2);
    if (name === "__nbo_bypass") return value === token;
  }
  return false;
}

// cacheGet reads key from the cache service through handler. ok is
// false for a 404 (missing or expired, indistinguishable from here —
// deliberately so, since onMiss treats them identically) — port of
// cacheGet (prerender.go lines 160-177).
//
// A failure is a miss too: a handler that throws, an answer other than 200,
// or no whole answer within timeoutMs. The page then renders as onMiss says,
// instead of the visitor getting an error or a long wait.
export async function cacheGet(handler: FetchHandler, key: string, timeoutMs = CACHE_READ_TIMEOUT_MS): Promise<CachedEntry | undefined> {
  // The signal stops a handler that honours it; the race covers one that
  // doesn't.
  const read = readEntry(handler, key, AbortSignal.timeout(timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

type CachedEntry = { body: Uint8Array; header: Record<string, string[]>; state: string; status?: number };

async function readEntry(handler: FetchHandler, key: string, signal: AbortSignal): Promise<CachedEntry | undefined> {
  try {
    const res = await handler(new Request(`http://isrcache/entries/${encodeURIComponent(key)}`, { signal }));
    if (res.status !== 200) {
      res.body?.cancel().catch(() => {});
      return undefined;
    }
    const out = (await res.json()) as { body: string; header: Record<string, string[]>; state: string; status?: number };
    // status: absent on entries written before NBO stored it — those were
    // all 200s.
    return { body: new Uint8Array(Buffer.from(out.body, "base64")), header: out.header, state: out.state, status: typeof out.status === "number" ? out.status : undefined };
  } catch {
    // A malformed 200, a thrown handler or an aborted read is a clean miss,
    // never a rejection for the caller.
    return undefined;
  }
}

// cachePut writes key to the cache service through handler — port of
// cachePut (prerender.go lines 180-193). Callers go through
// backgroundWrite / storeInBackground: a write never delays the page. It
// rejects after timeoutMs (the request's signal stops a handler that honours
// it; the race covers one that doesn't).
export async function cachePut(
  handler: FetchHandler,
  key: string,
  body: Uint8Array,
  header: Record<string, string[]>,
  tags: string[] | undefined,
  path: string,
  revalidateSec: number,
  expireSec: number,
  status = 200,
  timeoutMs = CACHE_WRITE_TIMEOUT_MS,
): Promise<void> {
  const res = await raceTimeout(
    handler(
      new Request(`http://isrcache/entries/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ body: Buffer.from(body).toString("base64"), header, tags, path, revalidateSec, expireSec, status }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    ),
    timeoutMs,
    "serve: the ISR cache did not answer a write in time",
  );
  res.body?.cancel().catch(() => {});
}

// backgroundWrite is cachePut under BACKGROUND_WRITE_LIMIT: at the cap the
// write is skipped (counted in backgroundWrites.skipped) and this resolves
// at once.
async function backgroundWrite(...args: Parameters<typeof cachePut>): Promise<void> {
  if (backgroundWrites.inFlight >= BACKGROUND_WRITE_LIMIT) {
    backgroundWrites.skipped++;
    return;
  }
  backgroundWrites.inFlight++;
  try {
    await cachePut(...args);
  } finally {
    backgroundWrites.inFlight--;
  }
}

// storeInBackground writes a rendered page without making the visitor wait;
// a failed, timed-out or skipped write is ignored, and the next request
// renders again.
export function storeInBackground(...args: Parameters<typeof cachePut>): void {
  void backgroundWrite(...args).catch(() => {});
}

// writeUpstreamResponse builds a Response copying a captured
// function/cache response's own status, body, and headers — port of
// writeUpstreamResponse (prerender.go lines 195-205).
function writeUpstreamResponse(status: number, body: Uint8Array, header: Record<string, string[]>): Response {
  const headers = new Headers();
  for (const [k, vs] of Object.entries(header)) {
    for (const v of vs) headers.append(k, v);
  }
  // A null-body status (204, 304, …) must be built with a null body:
  // Node's Response constructor throws on any body, even an empty one.
  if (NULL_BODY_STATUSES.has(status)) return new Response(null, { status, headers });
  return new Response(new Uint8Array(body), { status, headers });
}

// forMethod answers a HEAD with the GET result's status and headers.
function forMethod(request: Request, res: Response): Response {
  if (request.method !== "HEAD" || res.body === null) return res;
  return new Response(null, { status: res.status, headers: res.headers });
}

// CONDITIONAL_HEADERS make an upstream answer for one browser's copy
// (304 Not Modified, 412) instead of rendering the page.
// Range is dropped too: a partial render must never become the page.
const CONDITIONAL_HEADERS = ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range", "range"];

// ROUTER_HEADERS are what Next's client router and server actions add to a
// request. They change what the function answers (flight data instead of a
// page, a different tree, an action call).
const ROUTER_HEADERS = ["rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-hmr-refresh", "next-url", "next-action"];

// ROUTER_NAVIGATION_HEADERS are the router headers a render for a client-side
// navigation needs, to answer with flight data for the part that changed.
const ROUTER_NAVIGATION_HEADERS = ["rsc", "next-router-state-tree", "next-router-prefetch", "next-url"];

// RSC_VARY is what a response on a prerender route varies by: Next's own
// list, so a cache in front of NBO can't give a page to a router or flight
// data to a browser.
const RSC_VARY = ["rsc", "next-router-state-tree", "next-router-prefetch"];

function varyOnRSC(headers: Headers): void {
  const listed = new Set((headers.get("vary") ?? "").split(",").map((h) => h.trim().toLowerCase()));
  for (const h of RSC_VARY) {
    if (!listed.has(h)) headers.append("vary", h);
  }
}

// isRSCRequest is Next's own test (isRSCRequestHeader).
function isRSCRequest(request: Request): boolean {
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
function renderRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const h of [...CONDITIONAL_HEADERS, ...ROUTER_HEADERS]) headers.delete(h);
  return new Request(request.url, { method: "GET", headers });
}

// render calls the prerender route's own function directly and
// captures its response — used for draft mode and for onMiss:
// blocking, both of which need the result synchronously, before
// responding to the client — port of server.render (prerender.go
// lines 207-221).
async function render(state: ServeState, request: Request, functionName: string): Promise<{ status: number; body: Uint8Array; header: Record<string, string[]> }> {
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

// resolveCacheHandler resolves the ISR cache service, if one is
// configured for this build at all — undefined (not an error) when
// it isn't, so a build still serves prerender routes uncached rather
// than hard-failing every request when no cache service URL was
// wired up — port of server.resolveCacheHandler (prerender.go lines
// 223-236).
export function resolveCacheHandler(state: ServeState): FetchHandler | undefined {
  if (!state.resolveCache) return undefined;
  try {
    return state.resolveCache(ISR_CACHE_KEY);
  } catch {
    return undefined;
  }
}

// maybeRegenerateInBackground kicks a deduped (per this app instance)
// regeneration of key — a plain Set check-then-set, not a Mutex: both
// happen with no `await` between them, so Node's single-threaded
// event loop already makes it atomic. The request passed to the
// function carries no inherited AbortSignal: a signal tied to the
// triggering request/response would abort the regeneration almost
// immediately once that request finishes, on every single call —
// port of maybeRegenerateInBackground (prerender.go lines 238-273).
function maybeRegenerateInBackground(state: ServeState, key: string, request: Request, cfg: PrerenderConfig, cacheHandler: FetchHandler): void {
  if (state.regenInFlight.has(key)) return;
  state.regenInFlight.add(key);

  const bgRequest = renderRequest(request);

  void (async () => {
    try {
      const { status, body, header } = await render(state, bgRequest, cfg.function);
      // Only a cacheable render (a page, a not-found, a redirect) replaces
      // the entry: a failed one leaves the stale (but good) page in place.
      if (!isCacheableStatus(status)) return;
      await backgroundWrite(cacheHandler, key, body, header, cfg.tags, new URL(request.url).pathname, cfg.revalidateSec, cfg.expireSec, status);
    } catch {
      // best-effort — a failed regeneration leaves the existing
      // (stale, but still servable) entry in place.
    } finally {
      state.regenInFlight.delete(key);
      state.onRegenDone?.(key);
    }
  })();
}

// prerenderConfigByID finds cfg by id among this build's prerender
// routes — port of server.prerenderConfig (prerender.go lines
// 275-286).
function prerenderConfigByID(state: ServeState, id: string): PrerenderConfig | undefined {
  return state.prerenders.find((cfg) => cfg.id === id);
}

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
function resumeRequest(request: Request, path: string, postponedState: string, signal: AbortSignal, keep: string[] = []): Request {
  const headers = new Headers();
  const dropped = new Set([...CONDITIONAL_HEADERS, ...platformOnlyHeaders, ...ROUTER_HEADERS, "x-prerender-revalidate", "content-length", "content-type"]);
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
function forwardToFunction(state: ServeState, request: Request, cfg: PrerenderConfig, decision: Decision): Promise<Response> {
  return handleFunction(state, request, { kind: "function", functionName: cfg.function, headerOps: decision.headerOps });
}

// forwardFlightData is forwardToFunction for an RSC request. Next writes
// s-maxage for the platform to read; passed on, a shared cache that ignores
// Vary would store flight data at the page's URL.
async function forwardFlightData(state: ServeState, request: Request, cfg: PrerenderConfig, decision: Decision): Promise<Response> {
  const res = await forwardToFunction(state, request, cfg, decision);
  const cacheControl = res.headers.get("cache-control") ?? "";
  if (!cacheControl.includes("private") && !cacheControl.includes("no-store")) res.headers.set("cache-control", "private");
  return res;
}

// renderForOneVisitor is a whole render of a PPR route, for this request
// only. In minimal mode a plain GET can't do it: Next treats that as a
// revalidation and answers with the static prerender (the shell, unfinished,
// or flight data with no hole), so this is the empty resume.
async function renderForOneVisitor(state: ServeState, request: Request, path: string, cfg: PrerenderConfig, decision: Decision): Promise<Response> {
  const res = await forwardToFunction(state, resumeRequest(request, path, "", request.signal, ROUTER_NAVIGATION_HEADERS), cfg, decision);
  res.headers.set("cache-control", "private, no-store");
  return res;
}

const documentClose = new TextEncoder().encode("</body></html>");

// streamAfterShell is the body of a PPR response: the shell at once, then
// the function's body piped behind it chunk by chunk. render() can't do
// this, it buffers because ISR has to store the whole page. The resume
// starts here, concurrently with the shell, not when the reader gets past
// it.
//
// The 200 and the shell are already sent when the resume answers, so a
// failure can't change the status. It is logged, and the document is
// closed so the visitor keeps the shell with its Suspense fallback.
function streamAfterShell(shell: Uint8Array, startResume: (signal: AbortSignal) => Promise<Response>, visitorSignal: AbortSignal, routeID: string): ReadableStream<Uint8Array> {
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
        if (!signal.aborted) console.error(JSON.stringify({ level: "error", msg: "ppr resume failed", route: routeID, error: String(err) }));
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
async function handlePPR(state: ServeState, request: Request, cfg: PrerenderConfig, decision: Decision, draft: boolean): Promise<Response> {
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

// handlePrerender serves a Prerender decision through the
// fresh/stale/expired cache state machine, or through onMiss's own
// policy on a true miss — port of server.handlePrerender
// (prerender.go lines 288-344).
export async function handlePrerender(state: ServeState, request: Request, decision: Decision): Promise<Response> {
  const res = await servePrerender(state, atMatchedPath(request, decision), decision);
  varyOnRSC(res.headers);
  return res;
}

// atMatchedPath is request as the route sees it: after a rewrite, the seed,
// the cache key and the function all go by the destination.
function atMatchedPath(request: Request, decision: Decision): Request {
  const url = new URL(request.url);
  if (!decision.prerenderPath || decision.prerenderPath === url.pathname) return request;
  url.pathname = decision.prerenderPath;
  return new Request(url, request);
}

async function servePrerender(state: ServeState, request: Request, decision: Decision): Promise<Response> {
  const routeID = decision.prerenderRoute?.id ?? "";
  const cfg = prerenderConfigByID(state, routeID);
  if (!cfg) return new Response(`serve: no prerender config for route ${routeID}`, { status: 500 });

  const draft = isDraftMode(request, cfg);

  // A PPR route never participates in the ISR fresh/stale/expired cache
  // state machine below -- its "shell" (an ordinary seed) never goes
  // stale the way a rendered body does, and a resume response is
  // per-request dynamic by definition, so caching it would serve a
  // stranger's resumed render to the next visitor.
  if (cfg["x-nbo-ppr"]) {
    return handlePPR(state, request, cfg, decision, draft);
  }

  if (draft) {
    try {
      const { status, body, header } = await render(state, request, cfg.function);
      return writeUpstreamResponse(status, body, header);
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), { status: 502 });
    }
  }

  // Only GET and HEAD are pages; anything else (a Server Action POST to
  // the page URL, …) goes straight to the function with its body, never
  // reading or writing the cache.
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      const { status, body, header } = await render(state, request, cfg.function);
      return writeUpstreamResponse(status, body, header);
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), { status: 502 });
    }
  }

  // Flight data isn't the page, and the page isn't flight data: an RSC
  // request neither reads nor writes the entry the page is stored under.
  if (isRSCRequest(request)) return forwardFlightData(state, request, cfg, decision);

  const cacheHandler = resolveCacheHandler(state);
  const key = prerenderCacheKey(request, cfg, state.deploymentId);

  if (cacheHandler) {
    const cached = await cacheGet(cacheHandler, key);
    if (cached) {
      const res = writeUpstreamResponse(cached.status ?? 200, cached.body, cached.header);
      if (cached.state === "stale") maybeRegenerateInBackground(state, key, request, cfg, cacheHandler);
      return forMethod(request, res);
    }
  }

  switch (cfg.onMiss) {
    case "blocking": {
      let status: number, body: Uint8Array, header: Record<string, string[]>;
      try {
        ({ status, body, header } = await render(state, renderRequest(request), cfg.function));
      } catch (err) {
        return new Response(err instanceof Error ? err.message : String(err), { status: 502 });
      }
      if (cacheHandler && isCacheableStatus(status))
        storeInBackground(cacheHandler, key, body, header, cfg.tags, new URL(request.url).pathname, cfg.revalidateSec, cfg.expireSec, status);
      return forMethod(request, writeUpstreamResponse(status, body, header));
    }
    case "shell": {
      const path = new URL(request.url).pathname;
      const entry = state.index.get(decodeFullyURI(path));
      if (!entry) return new Response(`serve: no seed for ${path} on prerender route ${cfg.id}`, { status: 404 });
      const res = await serveStaticEntry(state, entry, 200, entry.cache, decision.headerOps ?? []);
      if (!res) return new Response(`serve: no seed for ${path} on prerender route ${cfg.id}`, { status: 404 });
      if (cacheHandler) maybeRegenerateInBackground(state, key, request, cfg, cacheHandler);
      return res;
    }
    case "notFound":
      return notFound(state, decision.headerOps ?? []);
    default:
      return new Response(`serve: unknown onMiss policy ${cfg.onMiss} on prerender route ${cfg.id}`, { status: 500 });
  }
}

// revalidateAuthorized checks request's bearer token against any one
// of this build's configured prerender routes' own bypass tokens — a
// build with no prerender routes at all has no token to match, so
// this always fails closed to 401 — port of server.revalidateAuthorized
// (prerender.go lines 346-365).
function revalidateAuthorized(state: ServeState, request: Request): boolean {
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!provided) return false;
  return state.prerenders.some((cfg) => {
    const token = process.env[cfg.bypassToken.env];
    return token && provided === token;
  });
}

// handleRevalidate forwards an authorized revalidation request to the
// cache service's own /invalidate endpoint — port of
// server.handleRevalidate (prerender.go lines 367-390).
export async function handleRevalidate(state: ServeState, request: Request): Promise<Response> {
  if (!revalidateAuthorized(state, request)) {
    return new Response("unauthorized", { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("serve: invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return new Response("serve: invalid request body", { status: 400 });
  for (const key of Object.keys(body)) {
    if (key !== "tags" && key !== "paths") return new Response(`serve: invalid request body: unknown field "${key}"`, { status: 400 });
  }
  const cacheHandler = resolveCacheHandler(state);
  if (!cacheHandler) return new Response("serve: no ISR cache service configured for this build", { status: 500 });
  let res: Response;
  try {
    res = await raceTimeout(
      cacheHandler(new Request("http://isrcache/invalidate", { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(CACHE_WRITE_TIMEOUT_MS) })),
      CACHE_WRITE_TIMEOUT_MS,
      "serve: the ISR cache did not answer in time",
    );
  } catch {
    return new Response("serve: the ISR cache did not answer", { status: 502 });
  }
  res.body?.cancel().catch(() => {});
  return new Response(null, { status: res.status });
}
