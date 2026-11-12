// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

const here = dirname(fileURLToPath(import.meta.url));
const dispatch = JSON.parse(readFileSync(join(here, "dispatch.json"), "utf8"));
const nextDispatch = JSON.parse(readFileSync(join(here, "next-dispatch.json"), "utf8"));

// Next's own compiled runtime (e.g. async-local-storage.js) expects a
// setup step to have run first — it checks globalThis.AsyncLocalStorage
// directly rather than requiring node:async_hooks itself, and throws
// "Invariant: AsyncLocalStorage accessed in runtime where it is not
// available" if nothing ever set it. next/dist/build/adapter/
// setup-node-env.external.js is exactly that step (it requires
// next/dist/server/node-environment, which does the polyfilling); the
// adapter locates it among the traced assets and records it here under
// this reserved key, since its real on-disk path is build-specific.
const setupNodeEnvRelPath = nextDispatch.__setupNodeEnv;
const setupNodeEnvPromise = setupNodeEnvRelPath
  ? import(pathToFileURL(join(here, setupNodeEnvRelPath)).href)
  : Promise.resolve();

// Found running Slice 4's ISR verify script for real: Next's own
// compiled route handler — the exact render path this shim calls into
// — runs its own internal incremental cache (the same stale-serve/
// background-regenerate behavior as NBO's own prerender.ts, just
// per-process) unless told this is an on-demand revalidation, so a
// request forwarded here came back with the same stale body across
// repeated calls even past the page's revalidateSec. NBO's own
// prerender.ts is meant to be the sole ISR cache authority — shared
// across every replica on either cloud — so Next's own per-process one
// must never activate at all. x-prerender-revalidate set to the
// build's own previewModeId (read from .next/prerender-manifest.json,
// already traced into every function's bundle for Next's own internal
// preview-cookie validation) forces Next to always render fresh,
// confirmed directly against a real build's own compiled handler.
// Absent entirely (and thus a no-op) for a build with no prerender
// routes at all, which never writes a prerender-manifest.json.
let previewModeId;
try {
  const manifest = JSON.parse(readFileSync(join(here, ".next", "prerender-manifest.json"), "utf8"));
  previewModeId = manifest.preview?.previewModeId;
} catch {
  // no prerender-manifest.json at all — nothing to force.
}

function routeIdFor(pathname) {
  for (const [id, route] of Object.entries(dispatch.routes)) {
    if (route.pathname === pathname) return id;
  }
  return undefined;
}

const handlerCache = new Map();
async function handlerFor(routeId) {
  if (!handlerCache.has(routeId)) {
    // Dynamic import() requires a file:// URL for an absolute path on
    // Windows (a raw "C:\..." path throws ERR_UNSUPPORTED_ESM_URL_SCHEME
    // under Node's native loader — this is a no-op on POSIX paths and
    // under bundler-provided loaders like Vite's, which is why this was
    // only caught by actually running the production path, not by the
    // vitest-run version of this same test).
    const mod = await import(pathToFileURL(join(here, nextDispatch[routeId])).href);
    handlerCache.set(routeId, mod.handler ?? mod.default.handler);
  }
  return handlerCache.get(routeId);
}

// Lazily started once per process, shared by every request: Next's built
// handler expects a real IncomingMessage/ServerResponse, and running one
// real loopback HTTP server gets streaming and chunked transfer correct
// for free instead of hand-rolling those two interfaces. The in-flight
// Promise itself (not just its resolved port) is cached, so two requests
// racing in before the first server finishes binding share one server
// instead of each starting their own.
let serverPortPromise;
function ensureServer() {
  if (!serverPortPromise) {
    serverPortPromise = new Promise((resolve) => {
      const server = createServer(async (req, res) => {
        // Next's handler rethrows because its own server normally catches
        // it. Nothing would end res here, and the caller would wait for
        // its header timeout; before prepare() installs Next's listener,
        // the unhandled rejection would end the process.
        try {
          await handle(req, res);
        } catch (err) {
          console.error(JSON.stringify({ level: "error", msg: "next handler threw", url: req.url, error: String(err) }));
          if (res.headersSent) res.destroy();
          else res.writeHead(500).end();
        }
      });
      server.listen(0, "127.0.0.1", () => {
        resolve(server.address().port);
      });
    });
  }
  return serverPortPromise;
}

async function handle(req, res) {
  const routeId = routeIdFor(new URL(req.url, "http://x").pathname);
  if (!routeId) {
    res.writeHead(404).end();
    return;
  }
  const handler = await handlerFor(routeId);
  // Real bug found reviewing Slice 5's PPR work: forcing this
  // header unconditionally (needed so Next's own per-process ISR
  // cache never activates — see the comment on previewModeId
  // above) also makes checkIsOnDemandRevalidate return true for
  // a PPR resume request, which makes app-page-runtime.js's own
  // handler discard the real postponed state entirely (`let
  // postponed = !isOnDemandRevalidate && ... ? minimalPostponed :
  // undefined`) and fall back to a full fresh render instead of
  // resuming — confirmed directly (a real resume POST came back
  // as a complete second document, not a continuation fragment).
  // A next-resume request's own forced freshness already comes
  // from the postponed state itself being per-request; it never
  // needs this header at all.
  if (previewModeId !== undefined && req.headers["next-resume"] !== "1") {
    req.headers["x-prerender-revalidate"] = previewModeId;
  }
  // minimalMode keeps each rendered page in Next's in-memory response
  // cache for 10 seconds, on-demand revalidation or not, unless the
  // request has its own invocation id. NBO's prerender.ts is the only
  // ISR cache, so every request gets an id nothing else can reuse.
  req.headers["x-invocation-id"] = randomUUID();
  // minimalMode: true makes the compiled handler honor PPR resume
  // requests (POST + next-resume: 1) — confirmed directly by
  // reading next/dist/build/templates/app-page-runtime.js's own
  // handler(req, res, ctx), which only reads req's postponed-state
  // headers/body when getRequestMeta(req, 'minimalMode') is true,
  // and sets that meta straight from this same ctx.requestMeta.
  await handler(req, res, { waitUntil: () => {}, requestMeta: { relativeProjectDir: ".", minimalMode: true } });
}

export default {
  async fetch(request) {
    await setupNodeEnvPromise;
    const port = await ensureServer();
    const reqUrl = new URL(request.url);
    const target = `http://127.0.0.1:${port}${reqUrl.pathname}${reqUrl.search}`;
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstream = await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: hasBody ? request.body : undefined,
      duplex: hasBody ? "half" : undefined,
      // A redirect is the app's answer to the visitor, not this hop's to
      // follow: following it would serve the target under the original URL.
      redirect: "manual",
      // A caller who hangs up closes the loopback connection, which is
      // what tells Next's handler to stop rendering.
      signal: request.signal,
    });
    // Minimal mode adds this for the platform to read and remove.
    const headers = new Headers(upstream.headers);
    headers.delete("x-next-cache-tags");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
