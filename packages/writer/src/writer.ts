// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import {
  mkdirSync,
  rmSync,
  copyFileSync,
  cpSync,
  writeFileSync,
  statSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, sep } from "node:path";
import { canonicalize, contentId, sha256Hex } from "@nbo/digest";
import { contentTypeFor } from "./content-type.js";
import type {
  Manifest,
  StaticIndex,
  Routes,
  PrerenderConfig,
  Images,
  Env,
  Binding,
  Cron,
  Extension,
  Capability,
} from "@nbo/spec";

// The spec version every manifest says, from its one source.
const SPEC_VERSION: string = (
  JSON.parse(readFileSync(createRequire(import.meta.url).resolve("@nbo/spec/version.json"), "utf8")) as {
    specVersion: string;
  }
).specVersion;

interface StaticEntry {
  urlPath: string;
  sourceFilePath: string;
  relativeFile: string;
  cache: "immutable" | "revalidate" | "no-store";
}

interface FunctionRoute {
  id: string;
  pathname: string;
  filePath: string;
}

interface FunctionEntry {
  name: string;
  runtime: { kind: "node"; version?: string };
  entryFilePath: string;
  capabilities: Capability[];
  routes: FunctionRoute[];
  files: Record<string, string>;
  inlineFiles: Record<string, string>;
}

export interface FunctionBuilder {
  addRoute(id: string, pathname: string, filePath: string): void;
  addFiles(assets: Record<string, string>): void;
  addFile(relPath: string, content: string): void;
}

// mapConcurrent runs fn over items with at most `limit` in flight at once.
// A function's bundle can carry tens of thousands of files (its whole
// traced dependency closure), and firing every read as its own promise
// with no cap can exceed the OS's open-file-handle limit (observed:
// EMFILE on Windows at ~19k files). A fixed concurrency window gets most
// of the throughput win from overlapping I/O without that failure mode.
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// walkBundleFiles lists every regular file under dir, as paths relative to
// dir (POSIX-separated). A traced asset entry can point at a directory
// (e.g. a whole node_modules package, observed with @swc/helpers) rather
// than a single file — copying it is a plain recursive copy (cpSync
// handles both shapes uniformly), but bundle.index.json still needs one
// entry per actual file, never one entry for a directory, so this walks
// the result on disk rather than trusting the declared asset keys.
function walkBundleFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkBundleFiles(full, base));
    } else if (entry.isFile()) {
      out.push(relative(base, full).split(sep).join("/"));
    }
  }
  return out;
}

// packageNameFromTracedPath derives an npm package name (scoped or plain)
// from a traced asset's relPath, by reading its last one or two segments
// (the last two when the second-to-last starts with "@", for a scoped
// package). Returns undefined for a path that was never under
// node_modules/ at all, so a plain repo-relative file never gets treated
// as a package.
function packageNameFromTracedPath(relPath: string): string | undefined {
  const normalized = relPath.replace(/\\/g, "/");
  if (!normalized.includes("node_modules/")) return undefined;
  const segments = normalized.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return undefined;
  const secondLast = segments[segments.length - 2];
  return secondLast?.startsWith("@") ? `${secondLast}/${last}` : last;
}

// hoistTracedPackage copies a whole traced package directory to
// bundle/node_modules/<name>, once per package name (hoistedPackages is
// the caller's shared first-wins guard — see copyTracedAssets). pnpm's
// own node_modules relies on a chain of symlinks to resolve nested
// packages (e.g. next/node_modules/@swc/helpers -> the central .pnpm
// store), and Next's own tracer doesn't always report that chain's
// intermediate links as their own assets. bundle/node_modules is the
// last ancestor directory Node's resolution algorithm checks for any
// file inside the bundle before walking past its root, so a flat copy
// there is a reliable fallback regardless of whether the nested
// virtual-store path otherwise resolves.
function hoistTracedPackage(
  relPath: string,
  resolvedSourcePath: string,
  dest: string,
  bundleDir: string,
  hoistedPackages: Set<string>,
): void {
  const pkgName = packageNameFromTracedPath(relPath);
  if (!pkgName || hoistedPackages.has(pkgName)) return;
  const hoistDest = join(bundleDir, "node_modules", pkgName);
  if (hoistDest !== dest) {
    mkdirSync(dirname(hoistDest), { recursive: true });
    cpSync(resolvedSourcePath, hoistDest, { recursive: true, dereference: true });
  }
  hoistedPackages.add(pkgName);
}

// copyTracedAssets copies every traced asset entry into the bundle at its
// relPath, hoisting whole traced package directories along the way (see
// hoistTracedPackage). Several distinct traced relPaths can resolve to
// the same hoisted package name (e.g. pnpm's own .pnpm/node_modules/<pkg>
// virtual-store view is a second, symlinked path to logically the same
// package a deeper .pnpm/<version>/node_modules/<pkg> entry already
// provided) — first one wins; hoistedPackages, shared across the whole
// loop, skips every later attempt outright rather than retrying cpSync
// against an already-populated destination, which can itself error
// depending on the second source's own shape.
function copyTracedAssets(files: Record<string, string>, bundleDir: string): void {
  const hoistedPackages = new Set<string>();
  for (const [relPath, sourcePath] of Object.entries(files)) {
    const dest = join(bundleDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    // cpSync handles both shapes uniformly: a traced asset entry is
    // usually a single file, but can be a whole directory (e.g. a
    // node_modules package traced as one unit). Resolving the source
    // through realpathSync first, rather than leaning on cpSync's own
    // dereference option, sidesteps a real cpSync bug: when dest
    // already exists as a real directory (built up from an earlier
    // entry — Next's tracer can give both individual files under a
    // package and a separate whole-package-directory entry for the
    // same package) and the source is a symlink, cpSync misdetects
    // the symlink as "non-directory" before dereference ever applies,
    // and throws ERR_FS_CP_NON_DIR_TO_DIR instead of merging into it.
    // dereference: true still matters for symlinks nested *inside*
    // the resolved directory (pnpm's own node_modules is symlink-heavy
    // throughout), and the spec forbids any symlink surviving into
    // .nbo/ output regardless of what the source layout does.
    const resolvedSourcePath = realpathSync(sourcePath);
    const isDir = statSync(resolvedSourcePath).isDirectory();
    cpSync(resolvedSourcePath, dest, { recursive: true, dereference: true });
    if (isDir) {
      hoistTracedPackage(relPath, resolvedSourcePath, dest, bundleDir, hoistedPackages);
    }
  }
}

function writeInlineFiles(inlineFiles: Record<string, string>, bundleDir: string): void {
  for (const [relPath, content] of Object.entries(inlineFiles)) {
    const dest = join(bundleDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}

// computeBundleIndex walks the bundle on disk and hashes every file,
// returning bundle.index.json's canonical bytes (the caller writes them).
// A function's bundle can carry its whole traced dependency closure
// (tens of thousands of files for a real Next.js app). Reading and
// hashing them one at a time via readFileSync leaves libuv's I/O
// threadpool almost idle — each call blocks until the previous one's
// disk round-trip completes. Firing them concurrently via fs/promises
// lets libuv's own threadpool actually overlap those round-trips; this
// one change took the next-app fixture's own dependency closure
// (~19k files) from ~130s to ~33s.
async function computeBundleIndex(bundleDir: string, fnName: string): Promise<string> {
  const walked = walkBundleFiles(bundleDir).sort();
  const t0 = Date.now();
  const bundleFiles: Record<string, { digest: string; size: number }> = {};
  await mapConcurrent(walked, 64, async (relPath) => {
    const raw = await readFile(join(bundleDir, relPath));
    bundleFiles[relPath] = { digest: `sha256:${sha256Hex(raw)}`, size: raw.length };
  });
  console.error(`nbo: computed digests for ${walked.length} files in "${fnName}" in ${Date.now() - t0}ms`);
  return canonicalize({ files: bundleFiles });
}

function writeDispatchFile(routes: FunctionRoute[], bundleDir: string): void {
  const dispatch = { routes: Object.fromEntries(routes.map((r) => [r.id, { pathname: r.pathname }])) };
  writeFileSync(join(bundleDir, "dispatch.json"), canonicalize(dispatch));
}

// buildFunctionManifest serializes function.json. Its own digest (over
// its canonical bytes) is distinct from bundleIndexCanonical's digest,
// which is embedded inside it as artifact.digest — the former identifies
// function.json itself (for manifest.json's digests map), the latter
// identifies the bundle it points at.
function buildFunctionManifest(fn: FunctionEntry, bundleIndexCanonical: string): { canonical: string; digest: string } {
  const functionJson = {
    name: fn.name,
    runtime: fn.runtime,
    handler: { style: "fetch", entry: "index.mjs", export: "default" },
    artifact: {
      type: "bundle",
      path: "bundle/",
      digest: `sha256:${sha256Hex(bundleIndexCanonical)}`,
      files: "bundle.index.json",
    },
    concurrency: "multi",
  };
  const canonical = canonicalize(functionJson);
  return { canonical, digest: `sha256:${sha256Hex(canonical)}` };
}

function buildDefaultRoutes(fallbackToRoot: boolean): Routes {
  const routes: Routes = { version: 1 };
  if (fallbackToRoot) {
    routes.fallback = [
      {
        id: "spa-fallback",
        match: { path: "^/", pathNot: "\\.[A-Za-z0-9]+$" },
        action: { type: "rewrite", path: "/" },
      },
    ];
  }
  return routes;
}

function buildManifest(opts: {
  framework: { name: string; version?: string };
  functionNames: string[];
  capabilities: Capability[];
  extensions: Extension[];
  staticIndexCanonical: string;
  routesCanonical: string;
  functionDigests: Record<string, string>;
  prerenderCanonical?: string;
  images?: Images;
  env?: Env;
  bindings?: Binding[];
  crons?: Cron[];
}): Manifest {
  const digests: Record<string, string> = {
    "static.index.json": `sha256:${sha256Hex(opts.staticIndexCanonical)}`,
    "routes.json": `sha256:${sha256Hex(opts.routesCanonical)}`,
    ...opts.functionDigests,
  };
  if (opts.prerenderCanonical !== undefined) {
    digests["prerender.json"] = `sha256:${sha256Hex(opts.prerenderCanonical)}`;
  }
  return {
    specVersion: SPEC_VERSION,
    build: {
      id: `b_${sha256Hex(String(Date.now())).slice(0, 10)}`,
      createdAt: new Date(),
      framework: opts.framework,
    },
    requires: { capabilities: [...new Set(opts.capabilities)].sort(), extensions: opts.extensions },
    routing: { trailingSlash: "never", cleanUrls: true, caseSensitive: true },
    functions: opts.functionNames,
    digests,
    ...(opts.images !== undefined ? { images: opts.images } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.bindings !== undefined && opts.bindings.length > 0 ? { bindings: opts.bindings } : {}),
    ...(opts.crons !== undefined && opts.crons.length > 0 ? { crons: opts.crons } : {}),
  };
}

export class NboWriter {
  private outDir: string;
  private framework: { name: string; version?: string };
  private staticEntries: StaticEntry[] = [];
  private fallbackToRoot = false;
  private functionEntries: FunctionEntry[] = [];
  private routesOverride: Routes | undefined;
  private prerenderConfigs: PrerenderConfig[] = [];
  private imagesConfig: Images | undefined;
  private envConfig: Env | undefined;
  private bindings: Binding[] = [];
  private crons: Cron[] = [];

  constructor(opts: { outDir: string; framework: { name: string; version?: string } }) {
    this.outDir = opts.outDir;
    this.framework = opts.framework;
  }

  addStatic(
    urlPath: string,
    sourceFilePath: string,
    opts: { cache?: "immutable" | "revalidate" | "no-store" } = {},
  ): void {
    // Paths are UTF-8 NFC. Normalize here too, so callers that bypass the
    // producer's classifier still get one key per logical name; relativeFile
    // is derived from the normalized urlPath so the two stay consistent.
    urlPath = urlPath.normalize("NFC");
    const sourceExt = extname(sourceFilePath);
    const urlExt = extname(urlPath);
    const relativeFile =
      urlPath === "/" ? `index${sourceExt}` : urlExt === sourceExt ? urlPath.slice(1) : urlPath.slice(1) + sourceExt;
    // Two sources mapping to the same URL path (e.g. foo.html and
    // foo/index.html both -> /foo) or the same output file must fail loudly:
    // otherwise whichever is added last wins, which depends on the
    // filesystem's directory-read order.
    for (const existing of this.staticEntries) {
      const key =
        existing.urlPath === urlPath
          ? { name: "urlPath", value: urlPath }
          : existing.relativeFile === relativeFile
            ? { name: "relativeFile", value: relativeFile }
            : undefined;
      if (key) {
        throw new Error(
          `static path collision on ${key.name} ${JSON.stringify(key.value)}: ` +
            `${JSON.stringify(sourceFilePath)} conflicts with ${JSON.stringify(existing.sourceFilePath)}`,
        );
      }
    }
    this.staticEntries.push({
      urlPath,
      sourceFilePath,
      relativeFile,
      cache: opts.cache ?? "revalidate",
    });
  }

  setFallbackToRoot(): void {
    this.fallbackToRoot = true;
  }

  addFunction(
    name: string,
    opts: { runtime: { kind: "node"; version?: string }; entryFilePath: string; capabilities?: Capability[] },
  ): FunctionBuilder {
    const entry: FunctionEntry = {
      name,
      runtime: opts.runtime,
      entryFilePath: opts.entryFilePath,
      capabilities: opts.capabilities ?? [],
      routes: [],
      files: {},
      inlineFiles: {},
    };
    this.functionEntries.push(entry);
    return {
      addRoute(id, pathname, filePath) {
        entry.routes.push({ id, pathname, filePath });
      },
      addFiles(assets) {
        Object.assign(entry.files, assets);
      },
      addFile(relPath, content) {
        entry.inlineFiles[relPath] = content;
      },
    };
  }

  setRoutes(routes: Routes): void {
    this.routesOverride = routes;
  }

  private writeStaticFiles(): string {
    const files: StaticIndex["files"] = {};
    for (const entry of this.staticEntries) {
      const destPath = join(this.outDir, "static", entry.relativeFile);
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(entry.sourceFilePath, destPath);
      files[entry.urlPath] = {
        file: entry.relativeFile.split(sep).join("/"),
        digest: `sha256:${sha256Hex(readFileSync(destPath))}`,
        size: statSync(destPath).size,
        contentType: contentTypeFor(entry.sourceFilePath),
        cache: entry.cache,
      };
    }
    const staticIndexCanonical = canonicalize({ files } as StaticIndex);
    writeFileSync(join(this.outDir, "static.index.json"), staticIndexCanonical);
    return staticIndexCanonical;
  }

  // writeFunctionBundle writes one function's entire bundle/ directory
  // (entry module, traced + inline files, bundle.index.json,
  // dispatch.json) and its own function.json, returning function.json's
  // digest for the caller's manifest.digests map.
  private async writeFunctionBundle(fn: FunctionEntry): Promise<string> {
    console.error(`nbo: bundling function "${fn.name}" (${Object.keys(fn.files).length} traced files)...`);
    const bundleDir = join(this.outDir, "functions", fn.name, "bundle");
    mkdirSync(bundleDir, { recursive: true });
    copyFileSync(fn.entryFilePath, join(bundleDir, "index.mjs"));

    const t0 = Date.now();
    copyTracedAssets(fn.files, bundleDir);
    writeInlineFiles(fn.inlineFiles, bundleDir);
    console.error(`nbo: copied files for "${fn.name}" in ${Date.now() - t0}ms`);

    // dispatch.json goes in before the index is computed, so it is listed
    // in bundle.index.json and covered by the content id like every other
    // bundle file (spec 1.0; earlier builds wrote it after, outside every digest).
    writeDispatchFile(fn.routes, bundleDir);
    const bundleIndexCanonical = await computeBundleIndex(bundleDir, fn.name);
    writeFileSync(join(bundleDir, "bundle.index.json"), bundleIndexCanonical);

    const { canonical: functionJsonCanonical, digest } = buildFunctionManifest(fn, bundleIndexCanonical);
    writeFileSync(join(this.outDir, "functions", fn.name, "function.json"), functionJsonCanonical);
    return digest;
  }

  private writeRoutes(): string {
    const routes = this.routesOverride ?? buildDefaultRoutes(this.fallbackToRoot);
    const routesCanonical = canonicalize(routes);
    writeFileSync(join(this.outDir, "routes.json"), routesCanonical);
    return routesCanonical;
  }

  addPrerender(config: PrerenderConfig): void {
    this.prerenderConfigs.push(config);
  }

  setImages(images: Images): void {
    this.imagesConfig = images;
  }

  setEnv(env: Env): void {
    this.envConfig = env;
  }

  addBinding(binding: Binding): void {
    this.bindings.push(binding);
  }

  addCron(cron: Cron): void {
    this.crons.push(cron);
  }

  // writePrerender returns undefined (and writes nothing) when no prerender
  // routes were added — a build with no ISR has no prerender.json at all,
  // the same optional-file treatment internal/serve already gives
  // manifest.json's own routing block.
  private writePrerender(): string | undefined {
    if (this.prerenderConfigs.length === 0) return undefined;
    const prerenderCanonical = canonicalize({ version: 1, prerenders: this.prerenderConfigs });
    writeFileSync(join(this.outDir, "prerender.json"), prerenderCanonical);
    return prerenderCanonical;
  }

  async write(): Promise<{ contentId: string }> {
    // Start from a clean slate: stale files from a previous build must never
    // survive into this one.
    rmSync(this.outDir, { recursive: true, force: true });
    mkdirSync(join(this.outDir, "static"), { recursive: true });

    const staticIndexCanonical = this.writeStaticFiles();

    const functionNames: string[] = [];
    const functionDigests: Record<string, string> = {};
    let capabilities: Capability[] = [];
    for (const fn of this.functionEntries) {
      functionDigests[`functions/${fn.name}/function.json`] = await this.writeFunctionBundle(fn);
      functionNames.push(fn.name);
      capabilities = [...capabilities, ...fn.capabilities];
    }

    const routesCanonical = this.writeRoutes();
    const prerenderCanonical = this.writePrerender();
    if (this.prerenderConfigs.length > 0) {
      capabilities = [...capabilities, "prerender.isr", "prerender.onDemand"];
    }
    if (this.imagesConfig !== undefined) {
      capabilities = [...capabilities, "images.optimize"];
    }

    const extensions: Extension[] = this.prerenderConfigs.some((c) => c["x-nbo-ppr"])
      ? [{ id: "x-nbo-ppr", version: "1", critical: true }]
      : [];

    const manifest = buildManifest({
      framework: this.framework,
      functionNames,
      capabilities,
      extensions,
      staticIndexCanonical,
      routesCanonical,
      functionDigests,
      prerenderCanonical,
      images: this.imagesConfig,
      env: this.envConfig,
      bindings: this.bindings,
      crons: this.crons,
    });
    writeFileSync(join(this.outDir, "manifest.json"), canonicalize(manifest));
    return { contentId: contentId(manifest as unknown as Record<string, unknown>) };
  }
}
