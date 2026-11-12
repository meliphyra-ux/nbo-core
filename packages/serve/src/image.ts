// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RE2 } from "re2";
import sharp from "sharp";

type SharpInstance = ReturnType<typeof sharp>;
import { hasJsOnlyEscape } from "@nbo/router";
import { readStaticFile, type ServeState, type ImagesConfig, type ImagePattern } from "./serve.js";
import { cacheGet, storeInBackground, resolveCacheHandler } from "./prerender.js";

// remoteFetchTimeoutMs and remoteFetchCap bound a remote source
// fetch — generous for a real image, finite so a slow or oversized
// upstream can't hang a request indefinitely or exhaust memory —
// matches Go's own remoteFetchTimeout/remoteFetchCap (image.go lines
// 28-29).
const remoteFetchTimeoutMs = 5000;
const remoteFetchCap = 10 << 20; // 10MiB

// loadImagesConfig reads manifest.json's own optional images field —
// undefined when the manifest has no images block at all (a build
// that never called setImages), the same tolerance
// loadTrailingSlashPolicy already has for a missing manifest.json
// file, here for a missing field within one that does exist — port
// of loadImagesConfig (image.go lines 57-77).
export async function loadImagesConfig(nboDir: string): Promise<ImagesConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(nboDir, "manifest.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const doc = JSON.parse(raw) as { images?: ImagesConfig };
  return doc.images;
}

function intAllowed(list: number[] | undefined, v: number): boolean {
  return list?.includes(v) ?? false;
}

interface CompiledImagePattern {
  protocol?: string;
  hostname?: InstanceType<typeof RE2>;
  pathname: InstanceType<typeof RE2>;
}

// compilePatterns RE2-compiles every pattern once — rejecting any
// pattern with a JS-only escape RE2 would silently mistranslate,
// exactly as @nbo/router's own createRouter already does for
// prerender patterns — instead of Go's own regexp.Compile-every-call
// (image.go's matchesAnyLocalPattern/matchesAnyRemotePattern,
// uncached), a real, Review-Focus-closing improvement with no
// behavior change: the same patterns, matched the same way, just not
// recompiled on every single request.
//
// A pattern without a pathname matches any path, as in Next.
function compilePatterns(patterns: ImagePattern[] | undefined): CompiledImagePattern[] {
  const out: CompiledImagePattern[] = [];
  for (const p of patterns ?? []) {
    const pathname = typeof p.pathname === "string" ? p.pathname : "^.*$";
    if (hasJsOnlyEscape(pathname) || (p.hostname && hasJsOnlyEscape(p.hostname))) continue;
    try {
      out.push({
        protocol: p.protocol,
        hostname: p.hostname ? new RE2(p.hostname) : undefined,
        pathname: new RE2(pathname),
      });
    } catch {
      continue;
    }
  }
  return out;
}

// compiledPatternsCache memoizes compilePatterns per ImagesConfig
// object — createHandler builds exactly one ImagesConfig per app
// instance and never mutates it, so the same object reference keys
// every call for that instance's whole lifetime; a different object
// (a fresh config in a test, for instance) gets its own fresh
// compile. Without this, every single cache-miss request recompiled
// every pattern from scratch, contradicting this plan's own stated
// architecture and the comment compilePatterns itself used to carry.
const compiledPatternsCache = new WeakMap<ImagesConfig, { local: CompiledImagePattern[]; remote: CompiledImagePattern[] }>();

// anyLocalPath stands in for an absent or empty localPatterns: Next allows
// every local path when the list is unset, and the Next producer wrote []
// for an unset list until spec 1.0 final (it now writes "^/.*$" itself, and
// Next's explicit [] as "^$").
const anyLocalPath: ImagePattern[] = [{ pathname: "^.*$" }];

function getCompiledPatterns(cfg: ImagesConfig): { local: CompiledImagePattern[]; remote: CompiledImagePattern[] } {
  let compiled = compiledPatternsCache.get(cfg);
  if (!compiled) {
    const local = cfg.localPatterns && cfg.localPatterns.length > 0 ? cfg.localPatterns : anyLocalPath;
    compiled = { local: compilePatterns(local), remote: compilePatterns(cfg.remotePatterns) };
    compiledPatternsCache.set(cfg, compiled);
  }
  return compiled;
}

function matchesAnyLocalPattern(patterns: CompiledImagePattern[], path: string): boolean {
  return patterns.some((p) => p.pathname.test(path));
}

function matchesAnyRemotePattern(patterns: CompiledImagePattern[], url: URL): boolean {
  return patterns.some((p) => {
    if (p.protocol && p.protocol !== url.protocol.replace(/:$/, "")) return false;
    if (!p.hostname || !p.hostname.test(url.hostname)) return false;
    return p.pathname.test(url.pathname);
  });
}

function looksAbsolute(raw: string): boolean {
  try {
    return new URL(raw).protocol !== "";
  } catch {
    return false;
  }
}

async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
    if (total > cap) break; // truncate rather than hang reading further — matches io.LimitReader
  }
  const out = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= out.length) break;
  }
  return out;
}

// fetchImageSource resolves and reads the raw bytes for rawURL —
// local (no scheme: a static.index.json entry, read via
// readStaticFile) or remote (an absolute URL, fetched with
// remoteFetchCap/remoteFetchTimeoutMs) — port of
// server.fetchImageSource (image.go lines 139-175).
async function fetchImageSource(
  state: ServeState,
  localPatterns: CompiledImagePattern[],
  remotePatterns: CompiledImagePattern[],
  rawURL: string,
): Promise<{ body: Uint8Array; status: number } | { body: null; status: number }> {
  if (!looksAbsolute(rawURL)) {
    if (!matchesAnyLocalPattern(localPatterns, rawURL)) return { body: null, status: 400 };
    const entry = state.index.get(rawURL);
    if (!entry) return { body: null, status: 404 };
    const body = await readStaticFile(state, entry);
    if (!body) return { body: null, status: 404 };
    return { body, status: 0 };
  }

  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    return { body: null, status: 400 };
  }
  if (!matchesAnyRemotePattern(remotePatterns, url)) return { body: null, status: 400 };

  let res: Response;
  try {
    res = await fetch(rawURL, { signal: AbortSignal.timeout(remoteFetchTimeoutMs) });
  } catch {
    return { body: null, status: 502 };
  }
  const body = await readCapped(res.body, remoteFetchCap);
  return { body, status: 0 };
}

// encodeImage picks PNG when src carries real transparency (to not
// silently drop it) and JPEG otherwise, at quality q — verified
// directly: sharp().metadata().hasAlpha alone reports true even for
// a fully-opaque 4-channel source, so the real per-pixel scan Go's
// own hasAlpha performs maps to stats()'s own alpha channel min, not
// metadata() — port of encodeImage/hasAlpha (image.go lines 177-220).
//
// Final-review fixes: metadata() reads input-level header info and
// never reflects queued operations, confirmed directly (a
// resize({width:10}).clone().metadata() on a 1000px source still
// reported width 1000) — so the resize is materialized into a real,
// lossless (PNG) buffer first, and every check below runs against
// that buffer, genuinely reflecting the resized pixels Go's own
// encodeImage(resized, ...) checks. The alpha channel is always the
// *last* channel sharp reports, not a hardcoded index 3 — the
// original code's assumption broke on a grayscale+alpha (2-channel)
// source, which has no index 3 at all. A CMYK source's own channel 3
// is its K (black) channel, not an alpha channel at all, and
// meta.hasAlpha is false for CMYK regardless — Go never hits this
// case either, since it always decodes into NRGBA.
async function encodeImage(image: SharpInstance, width: number, quality: number): Promise<{ body: Buffer; contentType: string }> {
  const resizedBuffer = await image.resize({ width }).png().toBuffer();
  const meta = await sharp(resizedBuffer).metadata();

  let hasRealTransparency = false;
  if (meta.hasAlpha) {
    const stats = await sharp(resizedBuffer).stats();
    const alpha = stats.channels[stats.channels.length - 1];
    hasRealTransparency = alpha !== undefined && alpha.min < 255;
  }

  if (hasRealTransparency) {
    return { body: resizedBuffer, contentType: "image/png" };
  }
  return { body: await sharp(resizedBuffer).jpeg({ quality }).toBuffer(), contentType: "image/jpeg" };
}

// handleImage serves a resized, optionally cached image — port of
// server.handleImage (image.go lines 230-282).
export async function handleImage(state: ServeState, request: Request): Promise<Response> {
  const cfg = state.images;
  if (!cfg) return new Response("serve: no images config for this build", { status: 500 });

  const url = new URL(request.url);
  const rawURL = url.searchParams.get("url") ?? "";
  const width = Number(url.searchParams.get("w"));
  if (!Number.isInteger(width) || !intAllowed(cfg.widths, width)) {
    return new Response(cfg.widths?.length ? "serve: w must be one of the configured widths" : "serve: the images config lists no widths", { status: 400 });
  }
  const quality = Number(url.searchParams.get("q"));
  if (!Number.isInteger(quality) || !intAllowed(cfg.qualities, quality)) {
    return new Response(cfg.qualities?.length ? "serve: q must be one of the configured qualities" : "serve: the images config lists no qualities", { status: 400 });
  }

  const cacheHandler = resolveCacheHandler(state);
  // Scoped by the build's content id like a page: a new build's image of the
  // same name never gets the old build's resized copy.
  const imageKey = `img:${rawURL}:${width}:${quality}`;
  const cacheKey = state.deploymentId === undefined ? imageKey : `${state.deploymentId}.${imageKey}`;
  if (cacheHandler) {
    const cached = await cacheGet(cacheHandler, cacheKey);
    if (cached) {
      const headers = new Headers();
      for (const [k, vs] of Object.entries(cached.header)) for (const v of vs) headers.append(k, v);
      return new Response(new Uint8Array(cached.body), { status: 200, headers });
    }
  }

  const { local: localPatterns, remote: remotePatterns } = getCompiledPatterns(cfg);
  const source = await fetchImageSource(state, localPatterns, remotePatterns, rawURL);
  if (source.body === null) {
    return new Response("serve: image source rejected or unreadable", { status: source.status });
  }

  let decoded: SharpInstance;
  try {
    decoded = sharp(Buffer.from(source.body));
    await decoded.metadata();
  } catch (err) {
    return new Response(`serve: could not decode image source: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  }

  let body: Buffer;
  let contentType: string;
  try {
    const encoded = await encodeImage(decoded, width, quality);
    body = encoded.body;
    contentType = encoded.contentType;
  } catch (err) {
    return new Response(`serve: could not encode resized image: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  }

  const headers = new Headers({ "content-type": contentType });
  if (cacheHandler) {
    const ttl = cfg.minimumCacheTTLSec ?? 0;
    storeInBackground(cacheHandler, cacheKey, new Uint8Array(body), { "content-type": [contentType] }, undefined, rawURL, ttl, ttl);
  }
  return new Response(new Uint8Array(body), { status: 200, headers });
}
