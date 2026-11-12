// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dispatch = JSON.parse(readFileSync(join(here, "middleware-dispatch.json"), "utf8"));

// Same bootstrap entry-shim.mjs already does for route modules — Next's
// own compiled runtime expects setup-node-env to have run first (see
// entry-shim.mjs's own comment for why). outputs.middleware's traced
// assets carry this file too (confirmed by inspecting a real build),
// so adapter.js records its relative path here under the same reserved
// key.
const setupNodeEnvRelPath = dispatch.__setupNodeEnv;
const setupNodeEnvPromise = setupNodeEnvRelPath ? import(pathToFileURL(join(here, setupNodeEnvRelPath)).href) : Promise.resolve();

const modPromise = import(pathToFileURL(join(here, dispatch.compiledPath)).href);

// isLoopbackHostname is true for every spelling of "this machine,
// addressed via loopback" that Node's own net/http stack treats as
// interchangeable.
function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

// sameEffectiveOrigin is origin equality, except two loopback
// hostnames on the same port also count as the same origin. Found
// running Slice 4's middleware verify script for real: Next's own
// middleware runtime renames a loopback hostname to "localhost" when
// it builds new URL(path, request.url) — confirmed directly (a real
// compiled handler, given a request.url of "http://127.0.0.1:<port>/
// ...", returned an x-middleware-rewrite of "http://localhost:<port>/
// ..." — same port, renamed host) — so a strict string comparison
// against requestOrigin (computed from the request this shim actually
// received, still "127.0.0.1") saw an ordinary same-origin rewrite as
// cross-origin.
function sameEffectiveOrigin(a, b) {
  if (a.origin === b.origin) return true;
  return a.port === b.port && isLoopbackHostname(a.hostname) && isLoopbackHostname(b.hostname);
}

// toPathIfSameOrigin narrows a same-origin absolute URL down to a bare
// path. NextResponse.rewrite(destination) always emits a fully-
// qualified URL in x-middleware-rewrite — new URL(path, request.url),
// the documented, canonical way to write a same-origin rewrite, is
// itself always absolute — but the x-nbo-* protocol's own router-side
// consumer treats an absolute x-nbo-rewrite as a cross-origin rewrite
// (out of scope, rejected with a clean 502). Without this narrowing,
// every ordinary same-origin Next.js rewrite would hit that rejection.
// A target that isn't a valid absolute URL at all (a hand-written
// Response carrying an already-relative path) passes through as-is.
function toPathIfSameOrigin(target, requestURL) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return target;
  }
  return sameEffectiveOrigin(url, requestURL) ? url.pathname + url.search + url.hash : target;
}

function renameMiddlewareHeaders(middlewareHeaders, requestURL) {
  const out = new Headers();
  for (const [key, value] of middlewareHeaders) {
    const lower = key.toLowerCase();
    if (lower === "x-middleware-next") {
      out.set("x-nbo-next", value);
    } else if (lower === "x-middleware-rewrite") {
      out.set("x-nbo-rewrite", toPathIfSameOrigin(value, requestURL));
    } else if (lower === "x-middleware-override-headers") {
      out.set("x-nbo-request-headers", value);
    } else if (lower.startsWith("x-middleware-request-")) {
      out.set("x-nbo-request-header-" + key.slice("x-middleware-request-".length), value);
    } else if (lower === "x-middleware-set-cookie") {
      // Dropped, not translated: confirmed empirically (calling
      // response.cookies.set() against a real NextResponse) that this
      // header is a redundant re-encoding of cookies the response
      // *also* sets as ordinary, native set-cookie headers — those are
      // already forwarded below via the generic passthrough branch.
      // Translating this one too produced duplicate Set-Cookie entries
      // for the same cookie.
    } else {
      out.append(key, value);
    }
  }
  return out;
}

export default {
  async fetch(request) {
    await setupNodeEnvPromise;
    const mod = await modPromise;
    const handler = mod.handler ?? mod.default.handler;
    const response = await handler(request, { waitUntil: () => {} });
    const requestURL = new URL(request.url);
    return new Response(response.body, { status: response.status, headers: renameMiddlewareHeaders(response.headers, requestURL) });
  },
};
