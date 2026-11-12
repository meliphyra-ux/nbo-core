// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { createRouter, type Decision, type HeaderOp, type Router } from "@nbo/router";
import { resolveStatic } from "@nbo/nbopath";
import type { Resolver, FetchHandler } from "@nbo/funcproxy";
import { loadStaticIndex, loadRoutesDoc, loadTrailingSlashPolicy, type StaticEntry } from "./loader.js";
import { createMiddlewareInvoker, framingHeaders } from "./middleware.js";
import { loadPrerenderDoc, handlePrerender, handleRevalidate } from "./prerender.js";
import { loadImagesConfig, handleImage } from "./image.js";
import { loadCarry, CARRIED_FROM_HEADER, type CarryIndex } from "./carry.js";

export type { StaticEntry } from "./loader.js";

// platformOnlyHeaders are headers Next's own compiled handler treats
// as platform-internal trust signals once minimalMode is on (confirmed
// directly against next/dist/server/base-server.js and
// next/dist/build/templates/app-page-runtime.js): "next-resume" plus
// "x-matched-path" together let a caller resume a PPR render with an
// arbitrary postponedState and an arbitrary matched path, and Next
// itself never expects a real client to set them (it strips the
// equivalent "x-matched-path"/"x-next-resume-state-length" from
// outbound IPC requests in its own
// server/lib/server-ipc/utils.js#INTERNAL_HEADERS). NBO's own
// handlePrerender is the only legitimate source of these headers (its
// internal resume call to the ssr function) — stripping them from
// every incoming client request here, before any routing decision,
// closes an untrusted-deserialization/path-spoofing gap a client could
// otherwise reach directly now that minimalMode is unconditionally on.
// The list is Next's whole INTERNAL_HEADERS, not only the ones NBO's path
// reads today, so a Next upgrade can't open one of the others.
export const platformOnlyHeaders = [
  "next-resume",
  "x-matched-path",
  "x-next-resume-state-length",
  "x-now-route-matches",
  "x-nextjs-data",
  "x-middleware-rewrite",
  "x-middleware-redirect",
  "x-middleware-set-cookie",
  "x-middleware-skip",
  "x-middleware-override-headers",
  "x-middleware-next",
];

// DEPLOYMENT_ID_HEADER carries the content id of the build being served: set on
// every request to a function and on every response, replacing any copy a client,
// function or middleware supplied. Speed Insights uses it to credit the right build.
export const DEPLOYMENT_ID_HEADER = "x-nbo-deployment-id";

export interface HandlerOptions {
  deploymentId?: string;
  carryDir?: string;
}

// withDeploymentId returns res carrying the real id, re-wrapping when its headers
// are immutable (a Response built by fetch()).
function withDeploymentId(res: Response, id: string): Response {
  try {
    res.headers.set(DEPLOYMENT_ID_HEADER, id);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set(DEPLOYMENT_ID_HEADER, id);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

// prepareIncoming removes the platform-only headers and names the public
// host for functions. funcproxy drops Host, so a function otherwise sees
// its own address, and Next refuses a server action whose Origin doesn't
// match. An x-forwarded-host already on the request is the edge's: it stays.
function prepareIncoming(request: Request, deploymentId?: string): Request {
  const missingHost = !request.headers.get("x-forwarded-host");
  const stale = deploymentId !== undefined && request.headers.get(DEPLOYMENT_ID_HEADER) !== deploymentId;
  if (!missingHost && !stale && !platformOnlyHeaders.some((h) => request.headers.has(h))) return request;
  const headers = new Headers(request.headers);
  for (const h of platformOnlyHeaders) headers.delete(h);
  if (deploymentId !== undefined) headers.set(DEPLOYMENT_ID_HEADER, deploymentId);
  if (missingHost) headers.set("x-forwarded-host", request.headers.get("host") ?? new URL(request.url).host);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  // duplex is a real, required Fetch API option for a request carrying
  // a streamed body (undici throws without it) — @types/node's
  // RequestInit doesn't know about it yet, same gap entry-shim.mjs's
  // own identical fetch() call already works around being plain JS.
  const init = { method: request.method, headers, body: hasBody ? request.body : undefined, duplex: hasBody ? "half" : undefined, signal: request.signal } as RequestInit;
  return new Request(request.url, init);
}

// PrerenderConfig mirrors prerender.json's own jsonPrerenderConfig
// shape (prerender.go lines 43-55) — declared here, once, as a
// placeholder with every real field already named; Task 4
// (prerender.ts) implements the behavior behind it without
// redeclaring the type.
export interface PrerenderConfig {
  id: string;
  match: string;
  function: string;
  revalidateSec: number;
  expireSec: number;
  tags?: string[];
  seeds?: Record<string, { file: string }>;
  onMiss: "blocking" | "shell" | "notFound";
  allowQuery?: string[];
  varyHeaders?: string[];
  bypassToken: { env: string };
  "x-nbo-ppr"?: { postponedState: string };
}

// ImagesConfig mirrors manifest.json's own images field
// (jsonImagesConfig, image.go lines 47-55) — same placeholder
// pattern as PrerenderConfig above; Task 5 (image.ts) implements the
// behavior behind it.
export interface ImagePattern {
  protocol?: string;
  hostname?: string;
  // Absent: any path, as in Next.
  pathname?: string;
}

// widths, qualities and minimumCacheTTLSec are optional in the schema (and
// Next can leave qualities unset): a missing list allows nothing, a missing
// minimumCacheTTLSec stores nothing (0 s).
export interface ImagesConfig {
  widths?: number[];
  formats?: string[];
  qualities?: number[];
  remotePatterns?: ImagePattern[];
  localPatterns?: ImagePattern[];
  minimumCacheTTLSec?: number;
  allowSvg?: boolean;
}

// ServeState holds everything one .nbo/ directory's handler needs
// across requests: the parsed static index and routes, the compiled
// router, and the function resolvers. Built once by createHandler,
// read-only thereafter — nothing here is request-scoped state — port
// of server (serve.go lines 265-287).
export interface ServeState {
  nboDir: string;
  index: Map<string, StaticEntry>;
  router: Router;
  resolve?: Resolver;
  resolveCache?: Resolver;
  prerenders: PrerenderConfig[];
  images?: ImagesConfig;
  // deploymentId is the build's content id: the prefix of every ISR cache
  // key, so an old and a new build sharing one cache never read each other's
  // pages. Undefined (unscoped keys) when the build has no manifest.json.
  deploymentId?: string;
  // regenInFlight dedups a stale/shell-seed background regeneration
  // per cache key, within this one app instance — a plain Set, not a
  // Mutex-guarded map: every method that touches it runs to
  // completion with no `await` inside the check-then-set itself, so
  // Node's single-threaded event loop already makes it atomic.
  regenInFlight: Set<string>;
  // onRegenDone is a test-only hook: undefined in production, a
  // callback in tests that want to wait for a background
  // regeneration deterministically instead of sleeping — replaces
  // Go's own regenDone channel.
  onRegenDone?: (key: string) => void;
}

// decodeFullyURI fully percent-decodes a path segment that came from
// a real request URL, for matching against static.index.json's own
// keys — @nbo/writer keys that file by the fully-decoded, NFC path
// (writer.ts), but @nbo/router's own normalizePath deliberately
// decodes only RFC 3986 *unreserved* characters (so a request can
// never smuggle a literal "/" past routing rules via %2F). A path
// with non-ASCII characters or spaces survives normalizePath still
// percent-encoded, so the index lookup — a different concern from
// routing — needs its own, fuller decode. A malformed escape falls
// through to the literal (and so, correctly, missing) string rather
// than throwing.
export function decodeFullyURI(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

function cacheControlFor(cache: string): string {
  switch (cache) {
    case "immutable":
      return "max-age=31536000, immutable";
    case "no-store":
      return "no-store";
    default:
      return "max-age=0, must-revalidate";
  }
}

// applyHeaderOps ports serve.go's own applyHeaderOps (lines 175-187)
// onto a Fetch Headers object.
export function applyHeaderOps(headers: Headers, ops: HeaderOp[]): void {
  for (const op of ops) {
    if (op.set) for (const [k, v] of Object.entries(op.set)) headers.set(k, v);
    if (op.append) for (const [k, v] of Object.entries(op.append)) headers.append(k, v);
    if (op.delete) for (const k of op.delete) headers.delete(k);
  }
}

// readStaticFile resolves and reads entry's own file, shared by
// serveStaticEntry (which writes the bytes straight into a Response)
// and image.ts's own fetchImageSource (Task 5), which needs the raw
// bytes to decode and resize, not a written response — port of
// readStaticFile (serve.go lines 319-333).
export async function readStaticFile(state: ServeState, entry: StaticEntry): Promise<Uint8Array | null> {
  const resolved = resolveStatic(state.nboDir, entry.file);
  if (!resolved.ok) return null;
  try {
    return await readFile(resolved.path);
  } catch {
    return null;
  }
}

// serveStaticEntry resolves and writes a static.index.json entry as
// the response (content type, then Cache-Control when cache is
// non-empty, then headerOps so an onMatch rule can override either,
// then status and body) — returns null on failure (a path-escape
// rejection or a missing file) instead of writing anything, leaving
// the caller to fall back to its own error path — port of
// serveStaticEntry (serve.go lines 304-317).
export async function serveStaticEntry(state: ServeState, entry: StaticEntry, status: number, cache: string, headerOps: HeaderOp[]): Promise<Response | null> {
  const raw = await readStaticFile(state, entry);
  if (!raw) return null;
  const headers = new Headers();
  headers.set("content-type", entry.contentType);
  if (cache !== "") headers.set("cache-control", cacheControlFor(cache));
  applyHeaderOps(headers, headerOps);
  return new Response(new Uint8Array(raw), { status, headers });
}

// notFound applies headerOps regardless of which branch it takes
// below — accumulated headerOps from beforeFiles/afterFiles/fallback
// rules with continue: true must land on the response no matter what
// the final decision turns out to be — port of notFound (serve.go
// lines 341-351).
export async function notFound(state: ServeState, headerOps: HeaderOp[]): Promise<Response> {
  const target = state.router.errorDoc["404"];
  if (target?.file) {
    const entry = state.index.get(target.file);
    if (entry) {
      const res = await serveStaticEntry(state, entry, 404, "", headerOps);
      if (res) return res;
    }
  }
  const headers = new Headers();
  applyHeaderOps(headers, headerOps);
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response("404 not found", { status: 404, headers });
}

async function handleServe(state: ServeState, decision: Decision): Promise<Response> {
  const entry = decision.staticPath !== undefined ? state.index.get(decodeFullyURI(decision.staticPath)) : undefined;
  const headerOps = decision.headerOps ?? [];
  if (!entry) return notFound(state, headerOps);
  const res = await serveStaticEntry(state, entry, 200, entry.cache, headerOps);
  return res ?? notFound(state, headerOps);
}

function handleRedirect(decision: Decision): Response {
  const headers = new Headers();
  applyHeaderOps(headers, decision.headerOps ?? []);
  headers.set("location", decision.redirectLocation ?? "");
  return new Response(null, { status: decision.redirectStatus ?? 302, headers });
}

async function handleRespond(state: ServeState, decision: Decision): Promise<Response> {
  const status = decision.respondStatus ?? 200;
  const headerOps = decision.headerOps ?? [];
  if (decision.respondFile) {
    const entry = state.index.get(decision.respondFile);
    if (entry) {
      const res = await serveStaticEntry(state, entry, status, "", headerOps);
      if (res) return res;
    }
  }
  const headers = new Headers();
  applyHeaderOps(headers, headerOps);
  return new Response(null, { status, headers });
}

// handleFunction dispatches to the resolved function, then applies
// this decision's own headerOps as a base layer and the function's
// own response headers on top — the function's own headers win any
// overlap, matching Go's real precedence: applyHeaderOps there runs
// against the same shared, mutable http.Header map the handler keeps
// writing into afterward, so the handler's own later Set/Add calls
// are what actually survive to the wire, not headerOps — port of
// handleFunction (serve.go lines 382-404).
export async function handleFunction(state: ServeState, request: Request, decision: Decision): Promise<Response> {
  if (!state.resolve) {
    return new Response("no function resolver configured for this build", { status: 500 });
  }
  let handler: FetchHandler;
  try {
    handler = state.resolve(decision.functionName ?? "");
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), { status: 502 });
  }

  // A rewrite (middleware's, or a plain rewrite.path rule) can change
  // the path before a later phase's rule dispatches it to this
  // function — the function's own routing has no other way to learn
  // that, since it dispatches by request path, so the real request
  // object must reflect functionPath before it's forwarded.
  let effectiveRequest = request;
  const currentPath = new URL(request.url).pathname;
  if (decision.functionPath && decision.functionPath !== currentPath) {
    const newURL = new URL(request.url);
    newURL.pathname = decision.functionPath;
    effectiveRequest = new Request(newURL, request);
  }

  let res: Response;
  try {
    res = await handler(effectiveRequest);
  } catch (err) {
    // A rejecting/throwing handler must still produce a clean
    // response — the FetchHandler contract every resolver in this
    // rewrite already follows (@nbo/funcproxy's own
    // proxyRequestOrFail, @nbo/controlplane's router) is "never
    // reject"; this is the one call site here that forwards an
    // arbitrary external handler, so it's the one that needs its own
    // guard rather than inheriting the contract for free.
    return new Response(err instanceof Error ? err.message : String(err), { status: 502 });
  }
  const headers = new Headers();
  applyHeaderOps(headers, decision.headerOps ?? []);
  // Fetch's Headers iterator yields one entry per Set-Cookie value
  // rather than folding them — copying every header via .set() would
  // make each successive Set-Cookie entry overwrite the one before
  // it, losing every value but the last. Every other header is
  // genuinely single-valued once joined, so .set() is correct there.
  // Hop-by-hop headers (RFC 7230 §6.1) describe the upstream
  // connection, never the one this response travels over, and must
  // never be forwarded either.
  for (const [k, v] of res.headers) {
    if (k === "set-cookie" || framingHeaders.has(k)) continue;
    headers.set(k, v);
  }
  for (const v of res.headers.getSetCookie()) headers.append("set-cookie", v);
  return new Response(res.body, { status: res.status, headers });
}

// handleMiddlewareHandled writes a middleware function's own "any
// other response" as-is: its own headers first, then the accumulated
// other-rule HeaderOps applied last, matching every other decision
// kind's own header-ops-applied-last convention — port of
// handleMiddlewareHandled (serve.go lines 411-420).
function handleMiddlewareHandled(decision: Decision): Response {
  const headers = new Headers();
  for (const [k, vs] of Object.entries(decision.middlewareHeaders ?? {})) {
    for (const v of vs) headers.append(k, v);
  }
  applyHeaderOps(headers, decision.headerOps ?? []);
  const body = decision.middlewareBody ? new Uint8Array(decision.middlewareBody) : null;
  return new Response(body, { status: decision.middlewareStatus ?? 200, headers });
}

// serveCarried answers a GET/HEAD that B 404'd from the previous build's carried
// files. Any failure returns null so the caller keeps B's 404.
async function serveCarried(carry: { dir: string; index: CarryIndex }, request: Request): Promise<Response | null> {
  const key = decodeFullyURI(new URL(request.url).pathname);
  const entry = Object.hasOwn(carry.index.files, key) ? carry.index.files[key] : undefined;
  if (!entry) return null;
  const resolved = resolveStatic(carry.dir, entry.file);
  if (!resolved.ok) return null;
  let raw: Buffer;
  try {
    raw = await readFile(resolved.path);
  } catch {
    return null;
  }
  const headers = new Headers();
  headers.set("content-type", entry.contentType);
  headers.set("cache-control", cacheControlFor("immutable"));
  headers.set(CARRIED_FROM_HEADER, carry.index.contentId);
  return new Response(request.method === "HEAD" ? null : new Uint8Array(raw), { status: 200, headers });
}

async function dispatchRoute(state: ServeState, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const decision = await state.router.route(path, request.method, (p) => state.index.has(decodeFullyURI(p)), createMiddlewareInvoker(state.resolve, request));
  switch (decision.kind) {
    case "serve":
      return handleServe(state, decision);
    case "redirect":
      return handleRedirect(decision);
    case "respond":
      return handleRespond(state, decision);
    case "function":
      return handleFunction(state, request, decision);
    case "middlewareHandled":
      return handleMiddlewareHandled(decision);
    case "loopDetected":
      return new Response("508 Loop Detected", { status: 508 });
    case "prerender":
      return handlePrerender(state, request, decision);
    default:
      return notFound(state, decision.headerOps ?? []);
  }
}

async function dispatch(state: ServeState, request: Request, carry: { dir: string; index: CarryIndex } | null): Promise<Response> {
  const res = await dispatchRoute(state, request);
  if (res.status !== 404 || !carry || (request.method !== "GET" && request.method !== "HEAD")) return res;
  const carried = await serveCarried(carry, request);
  if (!carried) return res;
  await res.body?.cancel();
  return carried;
}

// createHandler builds the handler for one .nbo/ directory — port of
// Handler (serve.go lines 449-490), as a plain function returning a
// Fetch-style handler rather than an http.Handler object, matching
// this rewrite's own established function convention.
export async function createHandler(nboDir: string, resolve?: Resolver, resolveCache?: Resolver, options: HandlerOptions = {}): Promise<FetchHandler> {
  const index = await loadStaticIndex(nboDir);
  const routes = await loadRoutesDoc(nboDir);
  const trailingSlash = await loadTrailingSlashPolicy(nboDir);
  const prerenders = await loadPrerenderDoc(nboDir);
  const router = createRouter(
    { ...routes, prerenders: prerenders.map((p) => ({ id: p.id, matchPath: p.match, functionName: p.function })) },
    trailingSlash,
  );

  const images = await loadImagesConfig(nboDir);

  const state: ServeState = {
    nboDir,
    index,
    router,
    resolve,
    resolveCache,
    prerenders,
    images,
    regenInFlight: new Set(),
  };
  if (options.deploymentId !== undefined) state.deploymentId = options.deploymentId;

  const { deploymentId } = options;
  const carry = options.carryDir !== undefined ? await loadCarry(options.carryDir) : null;
  const inner = (request: Request): Promise<Response> => {
    request = prepareIncoming(request, deploymentId);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/_nbo/revalidate") return handleRevalidate(state, request);
    if (request.method === "GET" && path === "/_nbo/image") return handleImage(state, request);
    return dispatch(state, request, carry);
  };
  if (deploymentId === undefined) return inner;
  return async (request: Request) => withDeploymentId(await inner(request), deploymentId);
}
