// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Decision } from "@nbo/router";
import { secretEquals } from "./secret-equals.js";
import type { FetchHandler } from "@nbo/funcproxy";
import { isCacheableStatus } from "./http-status.js";
import { serveStaticEntry, notFound, decodeFullyURI, type ServeState, type PrerenderConfig } from "./serve.js";
import {
  CACHE_WRITE_TIMEOUT_MS,
  backgroundWrite,
  cacheGet,
  forMethod,
  isDraftMode,
  prerenderCacheKey,
  raceTimeout,
  resolveCacheHandler,
  storeInBackground,
  writeUpstreamResponse,
} from "./prerender-cache.js";
import { render, renderRequest, isRSCRequest, varyOnRSC } from "./prerender-request.js";
import { forwardFlightData, handlePPR } from "./prerender-ppr.js";

export {
  BACKGROUND_WRITE_LIMIT,
  ISR_CACHE_KEY,
  backgroundWrites,
  cacheGet,
  loadPrerenderDoc,
  prerenderCacheKey,
  resolveCacheHandler,
  storeInBackground,
} from "./prerender-cache.js";

// maybeRegenerateInBackground kicks a deduped (per this app instance)
// regeneration of key — a plain Set check-then-set, not a Mutex: both
// happen with no `await` between them, so Node's single-threaded
// event loop already makes it atomic. The request passed to the
// function carries no inherited AbortSignal: a signal tied to the
// triggering request/response would abort the regeneration almost
// immediately once that request finishes, on every single call —
// port of maybeRegenerateInBackground (prerender.go lines 238-273).
function maybeRegenerateInBackground(
  state: ServeState,
  key: string,
  request: Request,
  cfg: PrerenderConfig,
  cacheHandler: FetchHandler,
): void {
  if (state.regenInFlight.has(key)) return;
  state.regenInFlight.add(key);

  const bgRequest = renderRequest(request);

  void (async () => {
    try {
      const { status, body, header } = await render(state, bgRequest, cfg.function);
      // Only a cacheable render (a page, a not-found, a redirect) replaces
      // the entry: a failed one leaves the stale (but good) page in place.
      if (!isCacheableStatus(status)) return;
      await backgroundWrite(
        cacheHandler,
        key,
        body,
        header,
        cfg.tags,
        new URL(request.url).pathname,
        cfg.revalidateSec,
        cfg.expireSec,
        status,
      );
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
        storeInBackground(
          cacheHandler,
          key,
          body,
          header,
          cfg.tags,
          new URL(request.url).pathname,
          cfg.revalidateSec,
          cfg.expireSec,
          status,
        );
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
    return token !== undefined && token !== "" && secretEquals(provided, token);
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
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return new Response("serve: invalid request body", { status: 400 });
  for (const key of Object.keys(body)) {
    if (key !== "tags" && key !== "paths")
      return new Response(`serve: invalid request body: unknown field "${key}"`, { status: 400 });
  }
  const cacheHandler = resolveCacheHandler(state);
  if (!cacheHandler) return new Response("serve: no ISR cache service configured for this build", { status: 500 });
  let res: Response;
  try {
    res = await raceTimeout(
      cacheHandler(
        new Request("http://isrcache/invalidate", {
          method: "POST",
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(CACHE_WRITE_TIMEOUT_MS),
        }),
      ),
      CACHE_WRITE_TIMEOUT_MS,
      "serve: the ISR cache did not answer in time",
    );
  } catch {
    return new Response("serve: the ISR cache did not answer", { status: 502 });
  }
  res.body?.cancel().catch(() => {});
  return new Response(null, { status: res.status });
}
