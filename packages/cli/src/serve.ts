// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validate } from "@nbo/validate";
import { contentId } from "@nbo/digest";
import { createHandler, ISR_CACHE_KEY } from "@nbo/serve";
import { createStaticURLs, createLocalSpawner, createCloudRunURLs, metadataServerIdentityToken, type Resolver } from "@nbo/funcproxy";
import { serveFetch } from "@nbo/nodehost";

// manifestFunctionNames reads manifest.json's functions array,
// returning [] if the file is missing or has none — a static-only
// build — port of manifestFunctionNames (serve.go lines 18-32).
function manifestFunctionNames(nboDir: string): Promise<string[]> {
  return readFile(join(nboDir, "manifest.json"), "utf8")
    .then((raw) => {
      const manifest = JSON.parse(raw) as { functions?: unknown };
      return Array.isArray(manifest.functions) ? manifest.functions.filter((v): v is string => typeof v === "string") : [];
    })
    .catch(() => []);
}

// manifestContentId is the build's content id (the manifest minus its build
// block), or undefined when there is no manifest.json.
export async function manifestContentId(nboDir: string): Promise<string | undefined> {
  try {
    return contentId(JSON.parse(await readFile(join(nboDir, "manifest.json"), "utf8")) as Record<string, unknown>);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

// functionsFileURLs reads the fixed-path /functions.json a Kubernetes
// function image bakes in — null if the file is missing (local dev, or
// a static-only app's image) or empty — port of functionsFileURLs
// (serve.go lines 34-48).
async function functionsFileURLs(): Promise<Record<string, string> | null> {
  let raw: string;
  try {
    raw = await readFile("/functions.json", "utf8");
  } catch {
    return null;
  }
  try {
    const urls = JSON.parse(raw) as Record<string, string>;
    return Object.keys(urls).length > 0 ? urls : null;
  } catch {
    return null;
  }
}

// parseServeArgs — port of parseServeArgs (serve.go lines 50-74).
export function parseServeArgs(args: string[]): { dir: string; port: string; functionURLs: Record<string, string>; carryDir?: string } {
  let port = "4000";
  const functionURLs: Record<string, string> = {};
  let carryDir: string | undefined;
  if (args.length === 0) return { dir: "", port, functionURLs };
  const dir = args[0]!;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) {
      port = args[i + 1]!;
      i++;
    } else if (args[i] === "--function" && i + 1 < args.length) {
      const [name, url] = args[i + 1]!.split("=", 2);
      if (name && url !== undefined) functionURLs[name] = url;
      i++;
    } else if (args[i] === "--carry" && i + 1 < args.length) {
      carryDir = args[i + 1]!;
      i++;
    }
  }
  return carryDir === undefined ? { dir, port, functionURLs } : { dir, port, functionURLs, carryDir };
}

// serviceURLs is the URL map a request is resolved against: the --function
// flags when any were given, else /functions.json, else nothing. It can hold
// the ISR cache under ISR_CACHE_KEY next to the functions.
export async function serviceURLs(flags: Record<string, string>): Promise<Record<string, string>> {
  if (Object.keys(flags).length > 0) return flags;
  return (await functionsFileURLs()) ?? {};
}

// withoutCache is urls minus the ISR cache's entry, which is never a function.
function withoutCache(urls: Record<string, string>): Record<string, string> {
  const { [ISR_CACHE_KEY]: _cache, ...functions } = urls;
  return functions;
}

// resolveFunctions decides how a request for a function should be
// served, in priority order: an explicit --function flag, then
// /functions.json (the Kubernetes case), then locally spawning the
// generic Node host per function named in manifest.json (plain local
// dev). Returns an empty object for a static-only build with no
// functions at all — port of resolveFunctions (serve.go lines 76-107).
//
// The ISR cache's entry (ISR_CACHE_KEY) is dropped first: a route naming that
// function fails as an unknown function, and a map holding only the cache
// counts as no map.
export async function resolveFunctions(nboDir: string, functionURLs: Record<string, string>): Promise<{ resolve?: Resolver; stop?: () => Promise<void> }> {
  const urls = withoutCache(await serviceURLs(functionURLs));
  if (Object.keys(urls).length > 0) {
    const k = process.env.K_SERVICE;
    if (k) {
      console.error(`nbo: K_SERVICE=${JSON.stringify(k)} — using the Cloud Run (authenticated) function resolver for ${JSON.stringify(urls)}`);
      return { resolve: createCloudRunURLs(urls, metadataServerIdentityToken) };
    }
    console.error(`nbo: K_SERVICE not set — using the plain (unauthenticated) function resolver for ${JSON.stringify(urls)}`);
    return { resolve: createStaticURLs(urls) };
  }
  const names = await manifestFunctionNames(nboDir);
  if (names.length > 0) {
    const { resolve, stop } = await createLocalSpawner(nboDir, names);
    return { resolve, stop };
  }
  return {};
}

// readBakedEnv reads path (typically /env.json, @nbo/adapter-k8s's own
// buildImage's own baked file) as a plain string map — null for a
// missing file, the same optional-file treatment /functions.json
// already gets — port of readBakedEnv (serve.go lines 109-126).
export async function readBakedEnv(path: string): Promise<Record<string, string> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw) as Record<string, string>;
}

// applyBakedEnv sets every var /env.json baked in as a real process env
// var, before resolveFunctions/resolveISRCache run — port of
// applyBakedEnv (serve.go lines 128-143).
async function applyBakedEnv(): Promise<void> {
  const vars = await readBakedEnv("/env.json");
  if (!vars) return;
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

// resolveISRCache resolves the ISR cache service the same way
// resolveFunctions resolves a function URL. NBO_ISRCACHE_URL wins (local
// nbo serve, the old verify scripts), else the map's ISR_CACHE_KEY entry
// (what a deploy bakes into /functions.json). Undefined with neither: a build
// still serves prerender routes uncached rather than hard-failing every
// request.
export function resolveISRCache(functionURLs: Record<string, string>): Resolver | undefined {
  const url = process.env.NBO_ISRCACHE_URL || functionURLs[ISR_CACHE_KEY];
  if (!url) return undefined;
  const urls = { [ISR_CACHE_KEY]: url };
  if (process.env.K_SERVICE) {
    return createCloudRunURLs(urls, metadataServerIdentityToken);
  }
  return createStaticURLs(urls);
}

// installShutdownHook kills every function stop spawned on Ctrl+C or
// SIGTERM, so a local nbo serve never leaves an orphaned Node child
// behind on a clean shutdown — port of installShutdownHook (serve.go
// lines 164-176).
function installShutdownHook(stop: () => Promise<void>): void {
  const handler = () => {
    stop()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

// runServe — port of runServe (serve.go lines 178-220). Doesn't return
// cleanly on success in the Go original either — http.ListenAndServe
// blocks forever; this port's own version resolves only on a startup
// failure, matching that (it never resolves on success).
export async function runServe(args: string[]): Promise<number> {
  if (args.length < 1) {
    console.error("usage: nbo serve <dir> [--port N]");
    return 1;
  }
  const { dir, port, functionURLs, carryDir } = parseServeArgs(args);

  await applyBakedEnv();

  const errs = validate(dir);
  if (errs.length !== 0) {
    for (const e of errs) console.error(e.message);
    console.error(`refusing to serve ${dir}: it does not pass nbo validate`);
    return 1;
  }

  const urls = await serviceURLs(functionURLs);
  let resolve: Resolver | undefined;
  let stop: (() => Promise<void>) | undefined;
  try {
    ({ resolve, stop } = await resolveFunctions(dir, urls));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (stop) installShutdownHook(stop);

  let handler;
  try {
    handler = await createHandler(dir, resolve, resolveISRCache(urls), { deploymentId: await manifestContentId(dir), carryDir });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  serveFetch(handler, { port: Number(port) }, (p) => {
    console.log(`serving ${dir} on :${p}`);
  });
  return new Promise(() => {});
}
