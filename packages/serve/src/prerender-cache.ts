// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The ISR cache client: reads and writes through the cache service, cache keys, timeouts and background writes.
import { readFile } from "node:fs/promises";
import { secretEquals } from "./secret-equals.js";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FetchHandler } from "@nbo/funcproxy";
import { NULL_BODY_STATUSES } from "./http-status.js";
import { decodeFullyURI, type ServeState, type PrerenderConfig } from "./serve.js";

// ISR_CACHE_KEY is the fixed name the ISR cache service is
// resolved under — reached exactly the way a function is (the same
// Resolver mechanism, not a second HTTP client), so it needs a name
// to resolve by even though it's never a real entry in manifest.json's
// own functions array — port of the Go ISR cache function name (prerender.go
// line 27).
// A deploy bakes the cache's URL into /functions.json under this key; function
// names match ^[a-z][a-z0-9-]{0,62}$, so it can never clash with one.
export const ISR_CACHE_KEY = "__isrcache";

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
export function raceTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
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
export function isDraftMode(request: Request, cfg: PrerenderConfig): boolean {
  const token = process.env[cfg.bypassToken.env];
  if (!token) return false;
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [name, value] = part.trim().split("=", 2);
    if (name === "__nbo_bypass") return value !== undefined && secretEquals(value, token);
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
export async function cacheGet(
  handler: FetchHandler,
  key: string,
  timeoutMs = CACHE_READ_TIMEOUT_MS,
): Promise<CachedEntry | undefined> {
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

export type CachedEntry = { body: Uint8Array; header: Record<string, string[]>; state: string; status?: number };

export async function readEntry(
  handler: FetchHandler,
  key: string,
  signal: AbortSignal,
): Promise<CachedEntry | undefined> {
  try {
    const res = await handler(new Request(`http://isrcache/entries/${encodeURIComponent(key)}`, { signal }));
    if (res.status !== 200) {
      res.body?.cancel().catch(() => {});
      return undefined;
    }
    const out = (await res.json()) as {
      body: string;
      header: Record<string, string[]>;
      state: string;
      status?: number;
    };
    // status: absent on entries written before NBO stored it — those were
    // all 200s.
    return {
      body: new Uint8Array(Buffer.from(out.body, "base64")),
      header: out.header,
      state: out.state,
      status: typeof out.status === "number" ? out.status : undefined,
    };
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
        body: JSON.stringify({
          body: Buffer.from(body).toString("base64"),
          header,
          tags,
          path,
          revalidateSec,
          expireSec,
          status,
        }),
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
export async function backgroundWrite(...args: Parameters<typeof cachePut>): Promise<void> {
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
export function writeUpstreamResponse(status: number, body: Uint8Array, header: Record<string, string[]>): Response {
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
export function forMethod(request: Request, res: Response): Response {
  if (request.method !== "HEAD" || res.body === null) return res;
  return new Response(null, { status: res.status, headers: res.headers });
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
