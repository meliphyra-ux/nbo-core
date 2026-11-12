// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// translateRoutes builds one exact-match afterFiles rule per app page/route,
// rewriting every one of them to the "ssr" function. No fallback rule: a
// plain 404 for anything unmatched is correct at this slice's scope (no
// catch-all SSR route, no dynamic segments, no middleware).
export function translateRoutes({ appPages, appRoutes }) {
  return [...appPages, ...appRoutes].map((route) => ({
    id: route.id,
    match: { path: "^" + escapeRegExp(route.pathname) + "$" },
    action: { type: "rewrite", function: "ssr" },
  }));
}

// translateMiddleware builds one beforeFiles rule per middleware
// matcher. Matchers with a user-authored has/missing condition are
// rejected — router.CompileMatch already unconditionally rejects any
// non-empty has/missing (a pre-existing gap, not specific to
// middleware). The one missing condition Next itself always injects
// into every matcher (x-prerender-revalidate, used to skip middleware
// on ISR on-demand-revalidation requests) is specifically recognized
// and dropped instead — it has zero effect today since Slice 4's own
// ISR item isn't built yet, and the alternative is that every
// middleware matcher scope-cuts, including Next's own default-generated
// ones.
export function translateMiddleware(matchers) {
  return matchers.map((matcher, index) => {
    if (matcher.has && matcher.has.length) {
      throw new Error(
        `middleware matcher ${JSON.stringify(matcher.source)} has a has-condition (${matcher.has[0].key}) that is not supported by this router version (pre-existing scope cut)`
      );
    }
    const missing = (matcher.missing ?? []).filter((m) => m.key !== "x-prerender-revalidate");
    if (missing.length) {
      throw new Error(
        `middleware matcher ${JSON.stringify(matcher.source)} has a missing-condition (${missing[0].key}) that is not supported by this router version (pre-existing scope cut)`
      );
    }
    return {
      id: `middleware-${index}`,
      match: { path: matcher.sourceRegex },
      action: { type: "middleware", function: "middleware" },
    };
  });
}

// isInternalNextRoute recognizes Next's own always-present framework
// pages (/_not-found, /_global-error): generic static error-boundary UI
// Next generates for every App Router build regardless of user code, not
// user-authored ISR/revalidating content. assertSlice2Scope exempts them
// from the prerender scope cut; the adapter doesn't wire them to anything,
// so an unmatched request still gets this platform's own plain 404 (fine
// at this slice's scope, same as any other unmatched path).
export function isInternalNextRoute(pathname) {
  // Backslash-separated variants have been observed for internal
  // segment-tree pathnames (e.g. a Windows build's own
  // "\_global-error.segments\_tree.segment.rsc") in addition to the
  // ordinary "/_not-found" and "/_global-error" forms, so normalize
  // separators before checking each segment rather than only the string's
  // own leading character.
  return pathname.split(/[\\/]/).some((segment) => segment.startsWith("_"));
}

// translatePrerenders maps one outputs.prerenders entry per
// docs/context.md's own Next.js -> NBO mapping table and the Adapter
// skeleton's field names, into prerender.json's wire shape
// (spec/prerender.schema.json via @nbo/writer's addPrerender) — a
// different vocabulary than the skeleton's own illustrative call shape
// (path/route/seedFile/ppr), since that shape was never the wire
// format.
//
// onMiss is "blocking" for every translated route except the long-lived
// static ones below: Next's own build output carries nothing equivalent
// to pick a different policy from, and "blocking" is the one policy
// that's always correct (a fresh render) regardless of whether a seed
// exists — my own call, not derived from anything Next reports.
//
// bypassToken is always {env: "NBO_PRERENDER_BYPASS"} — this platform's
// own token, never Next's own build-time bypassToken value, which must
// never reach prerender.json at all (docs/context.md's own gotcha: it's
// a secret, and CLAUDE.md's own ".nbo/ never contains... secret values"
// rule would reject it anyway).
//
// A PARTIALLY_STATIC entry maps its postponedState onto "x-nbo-ppr"
// per docs/nbo-spec.md's extension convention, and skips the numeric
// revalidateSec/expireSec requirement below entirely — those two
// fields are inert for a real PPR route (packages/serve's own
// handlePrerender never reads them for one), so 0 is written as an
// unused placeholder rather than extending the schema with a nullable
// variant.
//
// Real build output confirmed directly: cacheComponents marks EVERY
// app page PARTIALLY_STATIC by default, not only ones that actually
// postponed something — an ordinary page with no dynamic hole
// anywhere gets renderingMode: PARTIALLY_STATIC too, with no
// postponedState and initialRevalidate: false. That isn't a PPR route
// at all (there's nothing to resume), so isPPR is gated on a real,
// non-empty postponedState rather than renderingMode alone; such an
// entry instead gets isStaticUnderCacheComponents's long-lived
// onMiss: "shell" treatment, below. One with a lifetime ("use cache" with
// cacheLife gives a numeric initialRevalidate) is ordinary ISR.
//
// A renderingMode: PARTIALLY_STATIC entry with no fallback.filePath is
// the .rsc client-nav companion entry (the same route also emits an
// HTML entry, which does have a filePath) — real build output
// confirmed this directly. That companion exists only to serve Partial
// Prefetching's client-side segment-navigation cache, a separate,
// still-undecided feature this extension does not cover, so it's
// filtered out rather than translated.
//
// nextInternalVaryHeaders are the protocol-internal names a real build
// puts in config.allowHeader (confirmed against a real Next.js 16.4.2
// build: host, x-matched-path, and Next's own on-demand-revalidation
// signals) — varying this platform's own cache key by any of them would
// fragment the cache on a token that changes on every single request
// (the whole point of a revalidation token), defeating ISR entirely.
// Anything else in allowHeader (e.g. a real accept-language) survives.
const nextInternalVaryHeaders = new Set([
  "host",
  "x-matched-path",
  "x-prerender-revalidate",
  "x-prerender-revalidate-if-generated",
  "x-next-revalidated-tags",
  "x-next-revalidate-tag-token",
]);

// oneYearSeconds is the revalidate/expire window given to a
// PARTIALLY_STATIC route that turns out to have no postponedState at
// all (real build output confirmed this happens for an ordinary page
// with no dynamic hole anywhere — cacheComponents marks every app page
// PARTIALLY_STATIC by default, not only ones that actually postponed
// something). Next's own build output labels a page like that
// "Static" with a 1y Expire, so there's nothing to resume and nothing
// to ever revalidate server-side either; onMiss: "shell" with this
// long a window answers from the seed, and a cache service keeps one
// regenerated copy of it, matching what Next itself calls this page.
const oneYearSeconds = 60 * 60 * 24 * 365;

export function translatePrerenders(prerenders) {
  return prerenders
    .filter((p) => !isInternalNextRoute(p.pathname))
    .filter((p) => p.config?.renderingMode !== "PARTIALLY_STATIC" || p.fallback?.filePath !== undefined)
    .map((p) => {
    const isPPR = p.config?.renderingMode === "PARTIALLY_STATIC" && typeof p.fallback?.postponedState === "string" && p.fallback.postponedState.length > 0;
    const isStaticUnderCacheComponents = p.config?.renderingMode === "PARTIALLY_STATIC" && !isPPR && p.fallback?.initialRevalidate === false;
    let revalidateSec, expireSec, onMiss;
    if (isPPR) {
      revalidateSec = 0;
      expireSec = 0;
      onMiss = "blocking";
    } else if (isStaticUnderCacheComponents) {
      revalidateSec = oneYearSeconds;
      expireSec = oneYearSeconds;
      onMiss = "shell";
    } else {
      revalidateSec = p.fallback?.initialRevalidate;
      if (typeof revalidateSec !== "number") {
        throw new Error(
          `prerender route ${p.pathname}: initialRevalidate must be a number for this adapter version (got ${JSON.stringify(revalidateSec)} — "revalidate: false" is not yet supported)`
        );
      }
      expireSec = p.fallback?.initialExpiration;
      if (typeof expireSec !== "number") {
        throw new Error(`prerender route ${p.pathname}: initialExpiration must be a number for this adapter version (got ${JSON.stringify(expireSec)})`);
      }
      onMiss = "blocking";
    }
    // seeds[pathname].file is deliberately NOT p.fallback.filePath — that
    // value is a real, absolute path on the build machine (confirmed
    // against a real build), and writing it into prerender.json would
    // both leak build-machine filesystem structure and break build
    // determinism (the same commit built on two different checkouts
    // would get two different prerender.json digests). The spec's own
    // framing treats a seed as "an ordinary file in static.index.json" —
    // that's the authoritative file reference; this field uses the
    // pathname itself as a stable, deterministic placeholder.
    const seeds = {};
    if (p.fallback?.filePath) {
      seeds[p.pathname] = { file: p.pathname };
    }
    const entry = {
      // id is the pathname, not p.route: a real build emits one route
      // shared by an HTML page and its .rsc data variant as two
      // separate outputs.prerenders entries with the SAME route but
      // DIFFERENT pathnames (confirmed against a real build) — using
      // route as id collided the two under one id, so a lookup by id
      // could silently resolve to the wrong entry's config.
      id: p.pathname,
      match: "^" + escapeRegExp(p.pathname) + "$",
      function: "ssr",
      revalidateSec,
      expireSec,
      tags: [`group:${p.groupId}`],
      seeds,
      onMiss,
      allowQuery: p.config?.allowQuery ?? [],
      varyHeaders: (p.config?.allowHeader ?? []).filter((h) => !nextInternalVaryHeaders.has(h)),
      bypassToken: { env: "NBO_PRERENDER_BYPASS" },
    };
    if (isPPR) {
      entry["x-nbo-ppr"] = { postponedState: p.fallback.postponedState };
    }
    return entry;
  });
}

// assertSlice2Scope throws, naming the offending item, for any build
// output outside this adapter version's scope: edge runtime, Pages
// Router, or a dynamic route segment. Slice 4 lifts these cuts one at a
// time; until then a build that touches any of them must fail loudly
// rather than silently ship a feature that doesn't work.
//
// Middleware and ISR/prerendering were the first two cuts lifted
// (Slice 4's Middleware and ISR items) — middleware only for the
// nodejs runtime (see below); ISR/prerendering unconditionally
// (translatePrerenders, above). Dynamic route segments remain cut even
// for a prerender route: a prerender output's own pathname isn't
// checked here, but the matching appPages/appRoutes entry for the same
// route already is, by the dynamic-segment check below.
export function assertSlice2Scope(outputs) {
  if (outputs.middleware && outputs.middleware.runtime !== "nodejs") {
    throw new Error(
      `middleware with the ${outputs.middleware.runtime} runtime is not supported by this adapter version ` +
        `(Slice 4 scope cut — add "export const config = { runtime: 'nodejs' }" to your middleware/proxy source): ${outputs.middleware.pathname}`
    );
  }
  if (outputs.pages?.length) {
    throw new Error(`the Pages Router is not supported by this adapter version (Slice 4 scope cut): ${outputs.pages[0].pathname}`);
  }
  if (outputs.pagesApi?.length) {
    throw new Error(`the Pages Router is not supported by this adapter version (Slice 4 scope cut): ${outputs.pagesApi[0].pathname}`);
  }
  for (const route of [...(outputs.appPages ?? []), ...(outputs.appRoutes ?? [])]) {
    if (route.runtime === "edge") {
      throw new Error(`the edge runtime is not supported by this adapter version (Slice 4 scope cut): ${route.pathname}`);
    }
    if (route.pathname.includes("[")) {
      throw new Error(`dynamic route segments are not supported by this adapter version (Slice 4 scope cut): ${route.pathname}`);
    }
  }
}
