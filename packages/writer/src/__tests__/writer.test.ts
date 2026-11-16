// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { NboWriter } from "../writer.js";
import * as nboDigest from "@nbo/digest";

let srcDir: string;
let outDir: string;

beforeEach(() => {
  srcDir = mkdtempSync(join(tmpdir(), "nbo-src-"));
  outDir = mkdtempSync(join(tmpdir(), "nbo-out-"));
  writeFileSync(join(srcDir, "index.html"), "<h1>home</h1>");
  mkdirSync(join(srcDir, "blog"));
  writeFileSync(join(srcDir, "blog", "hello.html"), "<h1>hello</h1>");
  mkdirSync(join(srcDir, "_assets"));
  writeFileSync(join(srcDir, "_assets", "app.js"), "console.log('hi');");
});

afterEach(() => {
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

describe("NboWriter", () => {
  it("writes manifest.json, static.index.json, routes.json and the static files", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "static" } });
    writer.addStatic("/", join(srcDir, "index.html"), { cache: "revalidate" });
    writer.addStatic("/blog/hello", join(srcDir, "blog", "hello.html"), { cache: "revalidate" });
    await writer.write();

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    const specVersionFile = JSON.parse(
      readFileSync(createRequire(import.meta.url).resolve("@nbo/spec/version.json"), "utf8"),
    );
    expect(manifest.specVersion).toBe(specVersionFile.specVersion);
    expect(manifest.functions).toEqual([]);
    expect(Object.keys(manifest.digests).sort()).toEqual(["routes.json", "static.index.json"]);

    const index = JSON.parse(readFileSync(join(outDir, "static.index.json"), "utf8"));
    expect(index.files["/"].contentType).toBe("text/html; charset=utf-8");
    expect(index.files["/"].cache).toBe("revalidate");
    expect(index.files["/blog/hello"].file).toBe("blog/hello.html");

    const staticFileContents = readFileSync(join(outDir, "static", "blog", "hello.html"), "utf8");
    expect(staticFileContents).toBe("<h1>hello</h1>");
  });

  it("computes contentId via @nbo/digest's own contentId, not an inline copy", async () => {
    const spy = vi.spyOn(nboDigest, "contentId");
    try {
      const writer = new NboWriter({ outDir, framework: { name: "static" } });
      writer.addStatic("/", join(srcDir, "index.html"), { cache: "revalidate" });
      const result = await writer.write();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.results[0]!.value).toBe(result.contentId);
    } finally {
      spy.mockRestore();
    }
  });

  it("computes the same content id for two identical builds", async () => {
    async function build(dir: string) {
      const writer = new NboWriter({ outDir: dir, framework: { name: "static" } });
      writer.addStatic("/", join(srcDir, "index.html"), { cache: "revalidate" });
      return writer.write();
    }
    const outDir2 = mkdtempSync(join(tmpdir(), "nbo-out2-"));
    try {
      const a = await build(outDir);
      const b = await build(outDir2);
      expect(a.contentId).toBe(b.contentId);
    } finally {
      rmSync(outDir2, { recursive: true, force: true });
    }
  });

  it("adds a fallback-to-root rule when setFallbackToRoot is called", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "static" } });
    writer.addStatic("/", join(srcDir, "index.html"), { cache: "revalidate" });
    writer.setFallbackToRoot();
    await writer.write();

    const routes = JSON.parse(readFileSync(join(outDir, "routes.json"), "utf8"));
    expect(routes.fallback).toHaveLength(1);
    expect(routes.fallback[0].action).toEqual({ type: "rewrite", path: "/" });
  });

  it("supports non-html static files without double-appending the extension", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "static" } });
    writer.addStatic("/_assets/app.js", join(srcDir, "_assets", "app.js"), { cache: "immutable" });
    await writer.write();

    const index = JSON.parse(readFileSync(join(outDir, "static.index.json"), "utf8"));
    expect(index.files["/_assets/app.js"].file).toBe("_assets/app.js");
    expect(index.files["/_assets/app.js"].contentType).toBe("text/javascript; charset=utf-8");

    const contents = readFileSync(join(outDir, "static", "_assets", "app.js"), "utf8");
    expect(contents).toBe("console.log('hi');");
  });

  it("throws when two sources map to the same url path", () => {
    mkdirSync(join(srcDir, "foo"));
    writeFileSync(join(srcDir, "foo.html"), "a");
    writeFileSync(join(srcDir, "foo", "index.html"), "b");
    const writer = new NboWriter({ outDir, framework: { name: "static" } });
    writer.addStatic("/foo", join(srcDir, "foo.html"));
    let message = "";
    try {
      writer.addStatic("/foo", join(srcDir, "foo", "index.html"));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('urlPath "/foo"');
    expect(message).toContain(JSON.stringify(join(srcDir, "foo", "index.html")));
    expect(message).toContain(JSON.stringify(join(srcDir, "foo.html")));
  });

  it("throws when two sources map to the same output file", () => {
    writeFileSync(join(srcDir, "foo"), "a");
    writeFileSync(join(srcDir, "foo.html"), "b");
    const writer = new NboWriter({ outDir, framework: { name: "static" } });
    // "/foo.html" (a literal non-clean path) and "/foo" (clean URL of
    // foo.html) differ as URL paths but both land in static/foo.html.
    writer.addStatic("/foo.html", join(srcDir, "foo"));
    expect(() => writer.addStatic("/foo", join(srcDir, "foo.html"))).toThrow(/relativeFile "foo\.html"/);
  });

  it("normalizes url paths to NFC", async () => {
    writeFileSync(join(srcDir, "page.html"), "x");
    const writer = new NboWriter({ outDir, framework: { name: "static" } });
    writer.addStatic("/café", join(srcDir, "page.html"));
    await writer.write();
    const index = JSON.parse(readFileSync(join(outDir, "static.index.json"), "utf8"));
    expect(Object.keys(index.files)).toEqual(["/café"]);
    expect(index.files["/café"].file).toBe("café.html");
  });

  it("clears stale files from a previous write", async () => {
    const first = new NboWriter({ outDir, framework: { name: "static" } });
    first.addStatic("/_assets/app.js", join(srcDir, "_assets", "app.js"));
    await first.write();
    expect(existsSync(join(outDir, "static", "_assets", "app.js"))).toBe(true);

    const second = new NboWriter({ outDir, framework: { name: "static" } });
    second.addStatic("/", join(srcDir, "index.html"));
    await second.write();
    expect(existsSync(join(outDir, "static", "_assets", "app.js"))).toBe(false);
  });

  it("writes a function's bundle, function.json, bundle.index.json, and wires the manifest", async () => {
    mkdirSync(join(srcDir, "entry"));
    writeFileSync(join(srcDir, "entry", "index.mjs"), "export default { fetch() {} };");
    mkdirSync(join(srcDir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(srcDir, "node_modules", "left-pad", "index.js"), "module.exports = {};");

    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    const fn = writer.addFunction("ssr", {
      runtime: { kind: "node", version: ">=22" },
      entryFilePath: join(srcDir, "entry", "index.mjs"),
      capabilities: ["fn.streaming"],
    });
    fn.addRoute("app-page-/", "/", join(srcDir, "entry", "index.mjs"));
    fn.addFiles({ "node_modules/left-pad/index.js": join(srcDir, "node_modules", "left-pad", "index.js") });
    await writer.write();

    const fnJson = JSON.parse(readFileSync(join(outDir, "functions", "ssr", "function.json"), "utf8"));
    expect(fnJson.handler).toEqual({ style: "fetch", entry: "index.mjs", export: "default" });
    expect(fnJson.artifact.type).toBe("bundle");
    expect(fnJson.concurrency).toBe("multi");

    const bundleIndex = JSON.parse(
      readFileSync(join(outDir, "functions", "ssr", "bundle", "bundle.index.json"), "utf8"),
    );
    expect(Object.keys(bundleIndex.files).sort()).toEqual([
      "dispatch.json",
      "index.mjs",
      "node_modules/left-pad/index.js",
    ]);
    expect(existsSync(join(outDir, "functions", "ssr", "bundle", "node_modules", "left-pad", "index.js"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.functions).toEqual(["ssr"]);
    expect(manifest.requires.capabilities).toEqual(["fn.streaming"]);
    expect(Object.keys(manifest.digests)).toContain("functions/ssr/function.json");
  });

  it("copies a directory-shaped asset entry recursively and indexes every file inside it individually", async () => {
    mkdirSync(join(srcDir, "entry"));
    writeFileSync(join(srcDir, "entry", "index.mjs"), "export default { fetch() {} };");
    mkdirSync(join(srcDir, "helpers", "nested"), { recursive: true });
    writeFileSync(join(srcDir, "helpers", "a.js"), "a");
    writeFileSync(join(srcDir, "helpers", "nested", "b.js"), "b");

    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    const fn = writer.addFunction("ssr", {
      runtime: { kind: "node" },
      entryFilePath: join(srcDir, "entry", "index.mjs"),
    });
    fn.addFiles({ "node_modules/helpers": join(srcDir, "helpers") });
    await writer.write();

    expect(existsSync(join(outDir, "functions", "ssr", "bundle", "node_modules", "helpers", "a.js"))).toBe(true);
    expect(existsSync(join(outDir, "functions", "ssr", "bundle", "node_modules", "helpers", "nested", "b.js"))).toBe(
      true,
    );

    const bundleIndex = JSON.parse(
      readFileSync(join(outDir, "functions", "ssr", "bundle", "bundle.index.json"), "utf8"),
    );
    expect(Object.keys(bundleIndex.files).sort()).toEqual([
      "dispatch.json",
      "index.mjs",
      "node_modules/helpers/a.js",
      "node_modules/helpers/nested/b.js",
    ]);
  });

  it("dereferences a symlinked directory asset instead of recreating the symlink (pnpm's node_modules layout, no symlinks allowed in NBO output)", async () => {
    mkdirSync(join(srcDir, "entry"));
    writeFileSync(join(srcDir, "entry", "index.mjs"), "export default { fetch() {} };");
    const realDir = join(srcDir, "real-helpers");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "a.js"), "a");
    // A directory junction, same technique producer-static's own symlink
    // test uses: needs no elevated Windows privileges, unlike a plain
    // symlink, and is exactly pnpm's own node_modules linking shape.
    symlinkSync(realDir, join(srcDir, "linked-helpers"), "junction");

    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    const fn = writer.addFunction("ssr", {
      runtime: { kind: "node" },
      entryFilePath: join(srcDir, "entry", "index.mjs"),
    });
    fn.addFiles({ "node_modules/helpers": join(srcDir, "linked-helpers") });
    await writer.write();

    const destPath = join(outDir, "functions", "ssr", "bundle", "node_modules", "helpers");
    expect(lstatSync(destPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(destPath, "a.js"), "utf8")).toBe("a");
  });

  it("also hoists a directory-shaped node_modules asset to bundle/node_modules/<name>, so Node's own ancestor-walk resolution finds it even when the nested virtual-store path pnpm relies on didn't survive tracing", async () => {
    mkdirSync(join(srcDir, "entry"));
    writeFileSync(join(srcDir, "entry", "index.mjs"), "export default { fetch() {} };");
    mkdirSync(join(srcDir, "store", "@swc", "helpers"), { recursive: true });
    writeFileSync(join(srcDir, "store", "@swc", "helpers", "index.js"), "module.exports = {};");

    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    const fn = writer.addFunction("ssr", {
      runtime: { kind: "node" },
      entryFilePath: join(srcDir, "entry", "index.mjs"),
    });
    fn.addFiles({
      "node_modules/.pnpm/next@16.4.2/node_modules/@swc/helpers": join(srcDir, "store", "@swc", "helpers"),
    });
    await writer.write();

    const hoisted = join(outDir, "functions", "ssr", "bundle", "node_modules", "@swc", "helpers", "index.js");
    expect(existsSync(hoisted)).toBe(true);
    expect(readFileSync(hoisted, "utf8")).toBe("module.exports = {};");
  });

  it("hoists only once when two different traced entries resolve to the same package name (first wins, second is skipped rather than erroring)", async () => {
    mkdirSync(join(srcDir, "entry"));
    writeFileSync(join(srcDir, "entry", "index.mjs"), "export default { fetch() {} };");
    mkdirSync(join(srcDir, "real-helpers"), { recursive: true });
    writeFileSync(join(srcDir, "real-helpers", "index.js"), "real");
    // A second entry under a *different* declared relPath that also
    // resolves to package name "helpers" — mirrors pnpm's own internal
    // .pnpm/node_modules/<pkg> virtual-store view, a second real
    // (symlinked) path to logically the same package content — that
    // must not crash the second hoist attempt once the first one
    // already succeeded.
    mkdirSync(join(srcDir, "other-real-helpers"), { recursive: true });
    writeFileSync(join(srcDir, "other-real-helpers", "index.js"), "other");

    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    const fn = writer.addFunction("ssr", {
      runtime: { kind: "node" },
      entryFilePath: join(srcDir, "entry", "index.mjs"),
    });
    fn.addFiles({
      "node_modules/.pnpm/pkg-a/node_modules/helpers": join(srcDir, "real-helpers"),
      "node_modules/.pnpm/node_modules/helpers": join(srcDir, "other-real-helpers"),
    });
    await expect(writer.write()).resolves.toBeDefined();

    const hoisted = join(outDir, "functions", "ssr", "bundle", "node_modules", "helpers", "index.js");
    expect(readFileSync(hoisted, "utf8")).toBe("real");
  });

  it("merges a symlinked directory source into an already-existing destination directory (built up from an earlier entry) rather than erroring", async () => {
    mkdirSync(join(srcDir, "entry"));
    writeFileSync(join(srcDir, "entry", "index.mjs"), "export default { fetch() {} };");
    // Mirrors Next's own tracer, which can give both individual file
    // entries under a package AND a separate whole-package-directory
    // entry for the SAME package (e.g. many files under
    // "node_modules/next/<path>" plus one entry for the whole
    // "node_modules/next" directory itself) — the whole-directory entry's
    // source is a real pnpm symlink, and by the time it's processed,
    // bundle/node_modules/next already exists as a real directory from
    // the earlier individual-file entries.
    writeFileSync(join(srcDir, "package-file-a.js"), "a");
    mkdirSync(join(srcDir, "real-package"), { recursive: true });
    writeFileSync(join(srcDir, "real-package", "package-file-a.js"), "a");
    writeFileSync(join(srcDir, "real-package", "package-file-b.js"), "b");
    symlinkSync(join(srcDir, "real-package"), join(srcDir, "linked-package"), "junction");

    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    const fn = writer.addFunction("ssr", {
      runtime: { kind: "node" },
      entryFilePath: join(srcDir, "entry", "index.mjs"),
    });
    fn.addFiles({
      "node_modules/next/package-file-a.js": join(srcDir, "package-file-a.js"),
      "node_modules/next": join(srcDir, "linked-package"),
    });
    await expect(writer.write()).resolves.toBeDefined();

    const pkgDir = join(outDir, "functions", "ssr", "bundle", "node_modules", "next");
    expect(readFileSync(join(pkgDir, "package-file-a.js"), "utf8")).toBe("a");
    expect(readFileSync(join(pkgDir, "package-file-b.js"), "utf8")).toBe("b");
  });

  it("writes an addFile's inline content into the function's bundle and indexes it", async () => {
    mkdirSync(join(srcDir, "entry"));
    writeFileSync(join(srcDir, "entry", "index.mjs"), "export default { fetch() {} };");

    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    const fn = writer.addFunction("ssr", {
      runtime: { kind: "node" },
      entryFilePath: join(srcDir, "entry", "index.mjs"),
    });
    fn.addFile("next-dispatch.json", JSON.stringify({ home: "routes/home.js" }));
    await writer.write();

    const written = readFileSync(join(outDir, "functions", "ssr", "bundle", "next-dispatch.json"), "utf8");
    expect(JSON.parse(written)).toEqual({ home: "routes/home.js" });

    const bundleIndex = JSON.parse(
      readFileSync(join(outDir, "functions", "ssr", "bundle", "bundle.index.json"), "utf8"),
    );
    expect(Object.keys(bundleIndex.files).sort()).toEqual(["dispatch.json", "index.mjs", "next-dispatch.json"]);
  });

  it("setRoutes replaces the auto-built routes.json wholesale", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    writer.setRoutes({
      version: 1,
      afterFiles: [{ id: "ssr-home", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } }],
    });
    await writer.write();
    const routes = JSON.parse(readFileSync(join(outDir, "routes.json"), "utf8"));
    expect(routes.afterFiles[0].action.function).toBe("ssr");
  });

  it("addPrerender writes prerender.json and registers its digest in manifest.json", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    writer.addPrerender({
      id: "blog-detail",
      match: "^/blog/(?P<slug>[^/]+)$",
      function: "ssr",
      revalidateSec: 300,
      expireSec: 86400,
      onMiss: "blocking",
      bypassToken: { env: "NBO_PRERENDER_BYPASS" },
    });
    await writer.write();

    const prerender = JSON.parse(readFileSync(join(outDir, "prerender.json"), "utf8"));
    expect(prerender.version).toBe(1);
    expect(prerender.prerenders).toHaveLength(1);
    expect(prerender.prerenders[0].id).toBe("blog-detail");
    expect(prerender.prerenders[0].onMiss).toBe("blocking");

    const prerenderRaw = readFileSync(join(outDir, "prerender.json"), "utf8");
    const expectedDigest = `sha256:${createHash("sha256").update(prerenderRaw).digest("hex")}`;
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.digests["prerender.json"]).toBe(expectedDigest);
  });

  it("omits prerender.json entirely when no prerender routes were added", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "static" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    await writer.write();

    expect(existsSync(join(outDir, "prerender.json"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.digests["prerender.json"]).toBeUndefined();
  });

  it("declares the x-nbo-ppr extension when a prerender config carries it", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    writer.addPrerender({
      id: "/ppr-demo",
      match: "^/ppr-demo$",
      function: "ssr",
      revalidateSec: 0,
      expireSec: 0,
      onMiss: "blocking",
      bypassToken: { env: "NBO_PRERENDER_BYPASS" },
      "x-nbo-ppr": { postponedState: "abc" },
    });
    await writer.write();
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.requires.extensions).toEqual([{ id: "x-nbo-ppr", version: "1", critical: true }]);
  });

  it("declares no extensions for a plain ISR prerender config with no x-nbo-ppr", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    writer.addPrerender({
      id: "blog-detail",
      match: "^/blog/(?P<slug>[^/]+)$",
      function: "ssr",
      revalidateSec: 300,
      expireSec: 86400,
      onMiss: "blocking",
      bypassToken: { env: "NBO_PRERENDER_BYPASS" },
    });
    await writer.write();
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.requires.extensions).toEqual([]);
  });

  it("setImages writes the images block into manifest.json and adds the images.optimize capability", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    writer.setImages({
      widths: [640, 750],
      formats: ["image/webp"],
      qualities: [75],
      remotePatterns: [],
      localPatterns: [{ pathname: "^/assets/" }],
      minimumCacheTTLSec: 3600,
      allowSvg: false,
    });
    await writer.write();

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.images).toEqual({
      widths: [640, 750],
      formats: ["image/webp"],
      qualities: [75],
      remotePatterns: [],
      localPatterns: [{ pathname: "^/assets/" }],
      minimumCacheTTLSec: 3600,
      allowSvg: false,
    });
    expect(manifest.requires.capabilities).toContain("images.optimize");
  });

  it("omits the images block and capability entirely when setImages was never called", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "static" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    await writer.write();

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.images).toBeUndefined();
    expect(manifest.requires.capabilities).not.toContain("images.optimize");
  });

  it("setEnv writes the env block into manifest.json", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    writer.setEnv({
      required: ["DATABASE_URL"],
      optional: ["FEATURE_FLAG"],
      inlinedAtBuild: ["NEXT_PUBLIC_API_BASE"],
      inlinedEnvDigest: "sha256:abc",
    });
    await writer.write();

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.env).toEqual({
      required: ["DATABASE_URL"],
      optional: ["FEATURE_FLAG"],
      inlinedAtBuild: ["NEXT_PUBLIC_API_BASE"],
      inlinedEnvDigest: "sha256:abc",
    });
  });

  it("addBinding appends to manifest.bindings in call order", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    writer.addBinding({ name: "db", type: "postgres" });
    writer.addBinding({ name: "cache", type: "redis" });
    await writer.write();

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.bindings).toEqual([
      { name: "db", type: "postgres" },
      { name: "cache", type: "redis" },
    ]);
  });

  it("omits env and bindings entirely when neither was called", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "static" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    await writer.write();

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.env).toBeUndefined();
    expect(manifest.bindings).toBeUndefined();
  });

  it("addCron appends to manifest.crons in call order", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    writer.addCron({
      id: "nightly-sync",
      schedule: "0 3 * * *",
      timezone: "UTC",
      target: { function: "ssr", path: "/api/cron/sync", method: "POST" },
      overlap: "skip",
      timeoutSec: 300,
    });
    writer.addCron({
      id: "hourly-ping",
      schedule: "0 * * * *",
      target: { function: "ssr", path: "/api/cron/ping", method: "POST" },
      overlap: "allow",
      timeoutSec: 30,
    });
    await writer.write();

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.crons.map((c: { id: string }) => c.id)).toEqual(["nightly-sync", "hourly-ping"]);
    expect(manifest.crons[0]).toEqual({
      id: "nightly-sync",
      schedule: "0 3 * * *",
      timezone: "UTC",
      target: { function: "ssr", path: "/api/cron/sync", method: "POST" },
      overlap: "skip",
      timeoutSec: 300,
    });
  });

  it("omits crons entirely when addCron was never called", async () => {
    const writer = new NboWriter({ outDir, framework: { name: "static" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    await writer.write();

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.crons).toBeUndefined();
  });

  it("two writes of the same function produce byte-identical bundle.index.json", async () => {
    mkdirSync(join(srcDir, "entry"));
    writeFileSync(join(srcDir, "entry", "index.mjs"), "export default { fetch() {} };");
    mkdirSync(join(srcDir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(srcDir, "node_modules", "left-pad", "index.js"), "module.exports = {};");

    async function build() {
      const out = mkdtempSync(join(tmpdir(), "nbo-fn-out-"));
      const w = new NboWriter({ outDir: out, framework: { name: "nextjs" } });
      const fn = w.addFunction("ssr", { runtime: { kind: "node" }, entryFilePath: join(srcDir, "entry", "index.mjs") });
      fn.addFiles({ "node_modules/left-pad/index.js": join(srcDir, "node_modules", "left-pad", "index.js") });
      await w.write();
      return readFileSync(join(out, "functions", "ssr", "bundle", "bundle.index.json"));
    }
    const [a, b] = [await build(), await build()];
    expect(a.equals(b)).toBe(true);
  });

  it("lists dispatch.json in bundle.index.json, so it is inside the bundle digest", async () => {
    mkdirSync(join(srcDir, "entry"));
    writeFileSync(join(srcDir, "entry", "index.mjs"), "export default { fetch() {} };");
    const writer = new NboWriter({ outDir, framework: { name: "nextjs" } });
    const fn = writer.addFunction("ssr", {
      runtime: { kind: "node" },
      entryFilePath: join(srcDir, "entry", "index.mjs"),
    });
    fn.addRoute("app-page-/", "/", join(srcDir, "entry", "index.mjs"));
    await writer.write();

    const bundleDir = join(outDir, "functions", "ssr", "bundle");
    const bundleIndex = JSON.parse(readFileSync(join(bundleDir, "bundle.index.json"), "utf8"));
    const dispatchBytes = readFileSync(join(bundleDir, "dispatch.json"));
    expect(bundleIndex.files["dispatch.json"]).toEqual({
      digest: `sha256:${createHash("sha256").update(dispatchBytes).digest("hex")}`,
      size: dispatchBytes.length,
    });
  });

  it("two functions whose routes differ only in one pathname give different function.json digests and content ids", async () => {
    mkdirSync(join(srcDir, "entry"));
    writeFileSync(join(srcDir, "entry", "index.mjs"), "export default { fetch() {} };");
    async function build(dir: string, pathname: string) {
      const w = new NboWriter({ outDir: dir, framework: { name: "nextjs" } });
      const fn = w.addFunction("ssr", { runtime: { kind: "node" }, entryFilePath: join(srcDir, "entry", "index.mjs") });
      fn.addRoute("app-page-/about", pathname, join(srcDir, "entry", "index.mjs"));
      const { contentId } = await w.write();
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      return { contentId, fnDigest: manifest.digests["functions/ssr/function.json"] as string };
    }
    const outDir2 = mkdtempSync(join(tmpdir(), "nbo-out2-"));
    try {
      const a = await build(outDir, "/about");
      const b = await build(outDir2, "/about-us");
      expect(a.fnDigest).not.toBe(b.fnDigest);
      expect(a.contentId).not.toBe(b.contentId);
    } finally {
      rmSync(outDir2, { recursive: true, force: true });
    }
  });

  describe("replay: the same inputs written twice give byte-identical trees", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function readTree(root: string, dir: string = root): Map<string, Buffer> {
      const out = new Map<string, Buffer>();
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          for (const [k, v] of readTree(root, full)) out.set(k, v);
        } else {
          out.set(relative(root, full).split(sep).join("/"), readFileSync(full));
        }
      }
      return out;
    }

    async function replay(configure: (w: NboWriter) => void): Promise<void> {
      const outDir2 = mkdtempSync(join(tmpdir(), "nbo-out2-"));
      try {
        const w1 = new NboWriter({ outDir, framework: { name: "nextjs" } });
        configure(w1);
        const a = await w1.write();
        const w2 = new NboWriter({ outDir: outDir2, framework: { name: "nextjs" } });
        configure(w2);
        const b = await w2.write();
        expect(a.contentId).toBe(b.contentId);
        const treeA = readTree(outDir);
        const treeB = readTree(outDir2);
        expect([...treeA.keys()].sort()).toEqual([...treeB.keys()].sort());
        expect(treeA.size).toBeGreaterThan(0);
        for (const [path, bytes] of treeA) {
          expect(bytes.equals(treeB.get(path)!), path).toBe(true);
        }
      } finally {
        rmSync(outDir2, { recursive: true, force: true });
      }
    }

    it("for a static build", async () => {
      await replay((w) => {
        w.addStatic("/", join(srcDir, "index.html"), { cache: "revalidate" });
        w.addStatic("/blog/hello", join(srcDir, "blog", "hello.html"), { cache: "revalidate" });
        w.addStatic("/_assets/app.js", join(srcDir, "_assets", "app.js"), { cache: "immutable" });
      });
    });

    it("for a function build", async () => {
      mkdirSync(join(srcDir, "entry"));
      writeFileSync(join(srcDir, "entry", "index.mjs"), "export default { fetch() {} };");
      mkdirSync(join(srcDir, "node_modules", "left-pad"), { recursive: true });
      writeFileSync(join(srcDir, "node_modules", "left-pad", "index.js"), "module.exports = {};");
      await replay((w) => {
        w.addStatic("/", join(srcDir, "index.html"), { cache: "revalidate" });
        const fn = w.addFunction("ssr", {
          runtime: { kind: "node", version: ">=22" },
          entryFilePath: join(srcDir, "entry", "index.mjs"),
          capabilities: ["fn.streaming"],
        });
        fn.addRoute("app-page-/about", "/about", join(srcDir, "entry", "index.mjs"));
        fn.addRoute("app-page-/blog", "/blog", join(srcDir, "entry", "index.mjs"));
        fn.addFiles({ "node_modules/left-pad/index.js": join(srcDir, "node_modules", "left-pad", "index.js") });
        fn.addFile("next-dispatch.json", JSON.stringify({ home: "routes/home.js" }));
      });
    });
  });
});
