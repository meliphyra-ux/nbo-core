// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { NboWriter } from "@nbo/writer";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { listPublicFiles } from "./public-files.js";
import { fromNextEnv } from "./env.js";

const shimPath = join(dirname(fileURLToPath(import.meta.url)), "legacy-entry-shim.mjs");

// Next.js 14 and 15 have no adapter API, so after `next build` NBO reads .next/ itself and ships the
// app as one function running Next's own server (legacy-entry-shim.mjs). Routing, middleware, dynamic
// routes, the Pages Router, images and ISR all stay inside that server, as under `next start`.
// shortcut: ISR is Next's own per-instance cache, not NBO's shared one, and middleware never sees
// public/ or /_next/static files (NBO serves them first); a native mapping needs a per-version manifest reader.
export async function produceLegacyNext(appDir, { root = appDir, env = process.env } = {}) {
  const distDir = join(appDir, ".next");
  const requiredServerFiles = JSON.parse(readFileSync(join(distDir, "required-server-files.json"), "utf8"));
  const { config } = requiredServerFiles;
  if (config.output === "export") {
    throw new Error('this Next.js app uses output: "export": set the framework to Static with output directory "out"');
  }
  const appRequire = createRequire(join(appDir, "package.json"));
  const version = JSON.parse(readFileSync(appRequire.resolve("next/package.json"), "utf8")).version;

  const nbo = new NboWriter({ outDir: join(appDir, ".nbo"), framework: { name: "nextjs", version } });
  const base = config.basePath ?? "";
  for (const f of listPublicFiles(join(distDir, "static"))) {
    nbo.addStatic(`${base}/_next/static${f.pathname}`, f.filePath, { cache: "immutable" });
  }
  for (const f of listPublicFiles(join(appDir, "public"))) {
    nbo.addStatic(base + f.pathname, f.filePath, { cache: "revalidate" });
  }

  const fn = nbo.addFunction("ssr", {
    runtime: { kind: "node", version: `>=${process.versions.node.split(".")[0]}` },
    entryFilePath: shimPath,
    capabilities: ["fn.streaming"],
  });
  const traced = await traceNextServer(appRequire, appDir, root);
  fn.addFiles(bundleFiles(appDir, root, requiredServerFiles.files, traced));
  fn.addFile("next-server.json", JSON.stringify({ appDir: toKey(relative(root, appDir)) }));
  nbo.setEnv(fromNextEnv(env));
  nbo.setRoutes({
    version: 1,
    afterFiles: [{ id: "next", match: { path: "^/.*$" }, action: { type: "rewrite", function: "ssr" } }],
  });
  return nbo.write();
}

// traceNextServer traces the server `next start` runs, with the tracer Next ships. Next traces it
// into .next/ only for output: "standalone"; doing it here leaves the app's next.config untouched.
async function traceNextServer(appRequire, appDir, root) {
  const { nodeFileTrace } = appRequire("next/dist/compiled/@vercel/nft");
  const entries = [
    "next",
    "next/dist/server/lib/start-server",
    "next/dist/server/next",
    "next/dist/server/require-hook",
  ];
  const { fileList } = await nodeFileTrace(
    entries.map((e) => appRequire.resolve(e)),
    {
      base: root,
      processCwd: appDir,
      // The same build-only files Next leaves out of its standalone output.
      ignore: (p) => /webpack\/bundle[45]\.js$|node_modules\/webpack5\/|next-server\/.*\.dev\.js$/.test(p),
    },
  );
  return [...fileList].map((f) => join(root, f));
}

// bundleFiles lists every file the server needs: the manifests Next names, everything under
// .next/server and .next/static (the server lists the latter on start), what each .nft.json trace
// in them names, and `extra`, placed by placeFiles.
export function bundleFiles(appDir, root, requiredFiles, extra = []) {
  const distDir = join(appDir, ".next");
  const files = new Set([...requiredFiles.map((f) => join(appDir, f)), join(distDir, "required-server-files.json")]);
  for (const f of extra) files.add(f);
  const serverFiles = [
    join(distDir, "next-server.js.nft.json"),
    ...["server", "static"].flatMap((d) => listPublicFiles(join(distDir, d)).map((f) => f.filePath)),
  ];
  for (const file of serverFiles) {
    if (!file.endsWith(".nft.json")) {
      files.add(file);
    } else if (existsSync(file)) {
      for (const f of JSON.parse(readFileSync(file, "utf8")).files) files.add(join(dirname(file), f));
    }
  }
  return placeFiles([...files].sort(), appDir, root);
}

// placeFiles keys each file by where it goes in the bundle, relative to root (the cloned
// repository). pnpm links packages into place with symlinks, which .nbo/ can't hold, and a package
// copied once per link is loaded once per copy (two Reacts break every hook). So each real package
// directory gets one place, as npm lays packages out: node_modules/<name>, or, where another version
// has that, node_modules/<name> inside each package linking it. Other files keep their paths. A file
// resolving outside root is refused, so a build can't ship the host's files.
export function placeFiles(paths, appDir, root) {
  const realRoot = realpathSync(root);
  const packages = new Map(); // real package dir -> { name, linkedFrom: real dirs whose node_modules link it }
  const files = [];
  for (const path of paths) {
    if (!existsSync(path)) continue; // traces name optional files a build may not have
    const real = realpathSync(path);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error(`the build's file ${toKey(relative(root, path))} resolves outside the repository`);
    }
    if (!statSync(real).isDirectory()) {
      files.push(real);
      continue;
    }
    const at = path.lastIndexOf(`${sep}node_modules${sep}`);
    if (at < 0 || !lstatSync(path).isSymbolicLink()) continue; // a plain directory: its files are listed
    const name = toKey(path.slice(at + 14));
    const pkg = packages.get(real) ?? { name, linkedFrom: new Set() };
    pkg.linkedFrom.add(realpathSync(path.slice(0, at)));
    packages.set(real, pkg);
  }

  // One version per name sits at the top, as Node resolves from the app: the version the app links,
  // else one a workspace folder links, else the first by path.
  const realApp = realpathSync(appDir);
  const rank = (real) => {
    const from = [...packages.get(real).linkedFrom];
    if (from.includes(realApp)) return 0;
    return from.some((d) => !packages.has(d) && !d.includes(`${sep}.pnpm${sep}`)) ? 1 : 2;
  };
  const top = new Map();
  for (const real of [...packages.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))) {
    if (!top.has(packages.get(real).name)) top.set(packages.get(real).name, real);
  }
  // The package that owns a directory's node_modules: that directory itself, or (pnpm's
  // .pnpm/<id>/node_modules/<name>) the one real package inside it.
  const ownerOf = (dir) =>
    packages.has(dir)
      ? dir
      : [...packages.keys()].find(
          (r) => r.startsWith(`${dir}${sep}node_modules${sep}`) && !r.slice(dir.length + 14).includes(`node_modules`),
        );
  const placed = new Map();
  const placesOf = (real, seen = new Set()) => {
    if (placed.has(real)) return placed.get(real);
    const { name, linkedFrom } = packages.get(real);
    let places;
    if (top.get(name) === real) {
      places = [`node_modules/${name}`];
    } else if (seen.has(real)) {
      places = [toKey(relative(realRoot, real))]; // a cycle of nested versions: leave it where pnpm put it
    } else {
      seen.add(real);
      places = [...linkedFrom].flatMap((dir) => {
        const owner = ownerOf(dir);
        const bases = owner ? placesOf(owner, seen) : [toKey(relative(realRoot, dir))];
        return bases.map((b) => `${b === "" ? "" : `${b}/`}node_modules/${name}`);
      });
      // A root link to another version than the app's: the app never resolves it, and its place is taken.
      places = places.filter((p) => p !== `node_modules/${name}`);
    }
    placed.set(real, places);
    return places;
  };

  const assets = {};
  for (const file of files) {
    let pkg = dirname(file);
    while (!packages.has(pkg) && pkg !== realRoot && dirname(pkg) !== pkg) pkg = dirname(pkg);
    if (!packages.has(pkg)) {
      assets[toKey(relative(realRoot, file))] = file;
      continue;
    }
    const rest = toKey(file.slice(pkg.length));
    for (const place of placesOf(pkg)) assets[place + rest] = file;
  }
  return assets;
}

const toKey = (p) => p.split(sep).join("/");
