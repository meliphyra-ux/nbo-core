// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { NboWriter } from "@nbo/writer";
import { translateRoutes, translateMiddleware, translatePrerenders, assertSlice2Scope, isInternalNextRoute } from "./translate-routing.js";
import { fromNextImages } from "./images.js";
import { fromNextEnv } from "./env.js";
import { toStaticEntry } from "./static-files.js";
import { listPublicFiles } from "./public-files.js";
import { stripProjectRoot } from "./project-root.js";
import { withBuildId } from "./build-id.js";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const entryShimPath = join(dirname(fileURLToPath(import.meta.url)), "entry-shim.mjs");
const middlewareEntryShimPath = join(dirname(fileURLToPath(import.meta.url)), "middleware-entry-shim.mjs");

// computeProjectRoot derives the project's own repo-root-relative
// directory (e.g. "" for a repo-root app, "apps/web" for a monorepo
// subdirectory) from config.configFile's absolute path. Traced asset
// keys are repo-root-relative, but Next's runtime looks up files like
// .next/routes-manifest.json relative to the bundle's own root — see
// stripProjectRoot for why this value is needed to reconcile that.
function computeProjectRoot(config) {
  const projectRootEndIndex = config.configFile.indexOf(config.configFileName);
  return config.configFile.slice(config.repoRoot.length + 1, projectRootEndIndex);
}

// addStaticOutputs registers every static asset the build produced:
// outputs.staticFiles (Next's own /_next/static and automatically
// statically optimized pages) plus public/ directly, since
// AdapterOutputs has no field for public/ at all (STATIC_FILE only
// covers the other two) — Next expects an adapter to read that
// directory itself.
function addStaticOutputs(nbo, outputs, projectDir) {
  for (const f of outputs.staticFiles) {
    const { pathname, cache } = toStaticEntry(f);
    nbo.addStatic(pathname, f.filePath, { cache });
  }
  for (const { pathname, filePath } of listPublicFiles(join(projectDir, "public"))) {
    nbo.addStatic(pathname, filePath, { cache: "revalidate" });
  }
}

// addPrerenderSeeds registers each prerender route's own shell file as
// a static entry, under the exact pathname translatePrerenders' own
// `seeds[pathname] = { file: pathname }` already points at. Real gap
// found running Slice 5's PPR verify script for real: a prerender
// fallback (ISR or PPR) is never also one of outputs.staticFiles — a
// real build's own static.index.json never had this entry at all,
// so onMiss: "shell" (and PPR's own always-serve-the-shell GET) 404'd
// on every real build, latent since Slice 4 (next-app's own ISR
// fixture only ever uses onMiss: "blocking", which never reads a seed).
function addPrerenderSeeds(nbo, prerenders) {
  for (const p of prerenders) {
    if (isInternalNextRoute(p.pathname)) continue;
    if (!p.fallback?.filePath) continue;
    nbo.addStatic(p.pathname, p.fallback.filePath, { cache: "revalidate" });
  }
}

// addFunctionRoute wires one app route (a page or route handler) into
// fn and nextDispatch: registers the route, copies its traced assets
// (project-root-stripped), ensures the route's own entry file is
// present in the bundle even if it wasn't one of its own traced assets,
// and records where entry-shim.mjs should dispatch that route's id to.
// It also opportunistically records __setupNodeEnv the first time any
// route's traced assets happen to include it — see entry-shim.mjs for
// what that bootstrap file is for.
function addFunctionRoute(fn, route, projectRoot, repoRoot, nextDispatch) {
  fn.addRoute(route.id, route.pathname, route.filePath);
  const strippedAssets = Object.fromEntries(Object.entries(route.assets).map(([key, source]) => [stripProjectRoot(key, projectRoot), source]));
  fn.addFiles(strippedAssets);
  // route.filePath isn't documented as necessarily appearing as one of
  // route.assets' own values — if it doesn't, add it explicitly under
  // its own repo-root-relative key so the entry is always actually
  // present in the bundle, instead of assuming.
  let relPath = Object.keys(strippedAssets).find((p) => strippedAssets[p] === route.filePath);
  if (!relPath) {
    relPath = stripProjectRoot(relative(repoRoot, route.filePath), projectRoot);
    fn.addFiles({ [relPath]: route.filePath });
  }
  nextDispatch[route.id] = relPath;

  // Next's own compiled runtime needs next/dist/build/adapter/
  // setup-node-env.external.js required before any built route module
  // runs (it polyfills globalThis.AsyncLocalStorage and a few other
  // Node-environment globals Next's code assumes are already in place)
  // — see entry-shim.mjs for what it's for. Its real on-disk relPath is
  // build-specific, so find it among whichever route's traced assets
  // happened to include it.
  if (!nextDispatch.__setupNodeEnv) {
    const setupPath = Object.keys(strippedAssets).find((p) => p.endsWith("next/dist/build/adapter/setup-node-env.external.js"));
    if (setupPath) nextDispatch.__setupNodeEnv = setupPath;
  }
}

// addSsrFunction sets up the single "ssr" function every non-export
// build gets: one Fetch-style function fronting every app page and
// route handler, dispatched by entry-shim.mjs via next-dispatch.json.
function addSsrFunction(nbo, outputs, repoRoot, projectRoot) {
  const fn = nbo.addFunction("ssr", {
    runtime: { kind: "node", version: `>=${process.versions.node.split(".")[0]}` },
    entryFilePath: entryShimPath,
    capabilities: ["fn.streaming"],
  });
  const nextDispatch = {};
  const routes = [...outputs.appPages, ...outputs.appRoutes];
  console.error(`nbo: tracing assets for ${routes.length} route(s)...`);
  for (const route of routes) {
    addFunctionRoute(fn, route, projectRoot, repoRoot, nextDispatch);
  }
  fn.addFile("next-dispatch.json", JSON.stringify(nextDispatch));
}

// addMiddlewareFunction wires outputs.middleware into a dedicated
// "middleware" function, dispatched by middleware-entry-shim.mjs via
// middleware-dispatch.json — the same asset-stripping and "ensure
// filePath itself is present under its own key" fallback
// addFunctionRoute already applies for route modules, but for the
// single middleware entry rather than a per-route loop (middleware has
// no dispatch table of its own: the router invokes it as one whole
// function, never per-route).
function addMiddlewareFunction(nbo, outputs, projectRoot, repoRoot) {
  const mw = outputs.middleware;
  const fn = nbo.addFunction("middleware", {
    runtime: { kind: "node", version: `>=${process.versions.node.split(".")[0]}` },
    entryFilePath: middlewareEntryShimPath,
    capabilities: [],
  });
  const strippedAssets = Object.fromEntries(Object.entries(mw.assets).map(([key, source]) => [stripProjectRoot(key, projectRoot), source]));
  fn.addFiles(strippedAssets);
  let relPath = Object.keys(strippedAssets).find((p) => strippedAssets[p] === mw.filePath);
  if (!relPath) {
    relPath = stripProjectRoot(relative(repoRoot, mw.filePath), projectRoot);
    fn.addFiles({ [relPath]: mw.filePath });
  }
  const dispatch = { compiledPath: relPath };
  const setupPath = Object.keys(strippedAssets).find((p) => p.endsWith("next/dist/build/adapter/setup-node-env.external.js"));
  if (setupPath) dispatch.__setupNodeEnv = setupPath;
  fn.addFile("middleware-dispatch.json", JSON.stringify(dispatch));
}

/** @type {import('next').NextAdapter} */
export default {
  name: "nbo",
  modifyConfig(config) {
    return withBuildId(config);
  },
  async onBuildComplete({ outputs, routing, nextVersion, config, repoRoot, projectDir }) {
    const nbo = new NboWriter({ outDir: ".nbo", framework: { name: "nextjs", version: nextVersion } });
    const projectRoot = computeProjectRoot(config);

    addStaticOutputs(nbo, outputs, projectDir);

    if (config.output !== "export") {
      assertSlice2Scope(outputs);
      addSsrFunction(nbo, outputs, repoRoot, projectRoot);
      if (outputs.middleware) {
        addMiddlewareFunction(nbo, outputs, projectRoot, repoRoot);
      }
      addPrerenderSeeds(nbo, outputs.prerenders ?? []);
      for (const prerenderConfig of translatePrerenders(outputs.prerenders ?? [])) {
        nbo.addPrerender(prerenderConfig);
      }
      if (config.images) {
        nbo.setImages(fromNextImages(config.images));
      }
      nbo.setEnv(fromNextEnv(process.env));
      nbo.setRoutes({
        version: 1,
        beforeFiles: outputs.middleware ? translateMiddleware(routing.middlewareMatchers) : undefined,
        afterFiles: translateRoutes(outputs),
      });
    }

    const t0 = Date.now();
    const { contentId } = await nbo.write();
    console.error(`nbo: wrote .nbo/ in ${Date.now() - t0}ms (content id ${contentId})`);
  },
};
