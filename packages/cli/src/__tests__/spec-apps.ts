// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NboWriter } from "@nbo/writer";
import type { FetchHandler } from "@nbo/funcproxy";

// Small apps for the spec 1.0 conformance suite (spec-conformance.test.ts),
// built with @nbo/writer so they are real producer output. Each build
// writes into dir (the .nbo/ directory); the sources live in a temp
// directory removed afterwards, since write() empties dir first.

async function withSources(files: Record<string, string>, build: (src: string) => Promise<{ contentId: string }>): Promise<{ contentId: string }> {
  const src = mkdtempSync(join(tmpdir(), "nbo-spec-src-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(src, rel)), { recursive: true });
      writeFileSync(join(src, rel), body);
    }
    return await build(src);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
}

// buildStaticApp: a home page, an about page, an immutable asset, a
// no-store file, a 404 page and an images block (so /_nbo/image checks
// w and q instead of answering 500 for a build without images).
export function buildStaticApp(dir: string): Promise<{ contentId: string }> {
  return withSources(
    {
      "index.html": "<h1>static home</h1>",
      "about.html": "<h1>about page</h1>",
      "404.html": "<h1>custom not found page</h1>",
      "app-3f9a1c.js": "console.log('immutable asset');",
      "live.json": '{"live":true}',
      "a.png": "not really a png",
    },
    async (src) => {
      const writer = new NboWriter({ outDir: dir, framework: { name: "static" } });
      writer.addStatic("/", join(src, "index.html"));
      writer.addStatic("/about", join(src, "about.html"));
      writer.addStatic("/404", join(src, "404.html"));
      writer.addStatic("/assets/app-3f9a1c.js", join(src, "app-3f9a1c.js"), { cache: "immutable" });
      writer.addStatic("/live.json", join(src, "live.json"), { cache: "no-store" });
      writer.addStatic("/img/a.png", join(src, "a.png"));
      writer.setRoutes({ version: 1, error: { "404": { file: "/404" } } });
      writer.setImages({
        widths: [64],
        formats: ["image/webp"],
        qualities: [75],
        localPatterns: [{ pathname: "^/img/.*$" }],
        minimumCacheTTLSec: 60,
        allowSvg: false,
      });
      return writer.write();
    },
  );
}

// buildSpaApp: a root document, one hashed asset and the SPA fallback.
export function buildSpaApp(dir: string): Promise<{ contentId: string }> {
  return withSources(
    {
      "index.html": '<div id="root">spa root document</div>',
      "app-abc123.js": "console.log('spa');",
    },
    async (src) => {
      const writer = new NboWriter({ outDir: dir, framework: { name: "vite" } });
      writer.addStatic("/", join(src, "index.html"));
      writer.addStatic("/assets/app-abc123.js", join(src, "app-abc123.js"), { cache: "immutable" });
      writer.setFallbackToRoot();
      return writer.write();
    },
  );
}

// buildFunctionApp: one function, "echo", reached under /echo. The test
// serves it in-process with echoFunction, so the bundle's entry is never run.
export function buildFunctionApp(dir: string): Promise<{ contentId: string }> {
  return withSources(
    {
      "index.html": "<h1>function app</h1>",
      "fn/index.mjs": "export default { fetch() { return new Response('echo'); } };",
    },
    async (src) => {
      const writer = new NboWriter({ outDir: dir, framework: { name: "static" } });
      writer.addStatic("/", join(src, "index.html"));
      writer.addFunction("echo", { runtime: { kind: "node", version: ">=22" }, entryFilePath: join(src, "fn", "index.mjs") });
      writer.setRoutes({
        version: 1,
        afterFiles: [{ id: "echo", match: { path: "^/echo(/.*)?$" }, action: { type: "rewrite", function: "echo" } }],
      });
      return writer.write();
    },
  );
}

// buildCarryApp: build A ("old": old.js and shared.js) and build B ("new":
// shared.js with new bytes), all immutable. A deploy of B carries A files.
export const carryFiles = {
  old: { "/assets/old.js": "console.log('old from A');", "/assets/shared.js": "console.log('shared from A');" },
  new: { "/assets/shared.js": "console.log('shared from B');" },
} as const;

export function buildCarryApp(dir: string, which: "old" | "new"): Promise<{ contentId: string }> {
  const assets: Record<string, string> = carryFiles[which];
  const sources: Record<string, string> = { "index.html": `<h1>build ${which}</h1>` };
  for (const [urlPath, body] of Object.entries(assets)) sources[urlPath.slice(1)] = body;
  return withSources(sources, async (src) => {
    const writer = new NboWriter({ outDir: dir, framework: { name: "vite" } });
    writer.addStatic("/", join(src, "index.html"));
    for (const urlPath of Object.keys(assets)) writer.addStatic(urlPath, join(src, urlPath.slice(1)), { cache: "immutable" });
    return writer.write();
  });
}

// writeCarry writes a carry directory in the format @nbo/deploy bakes into
// an app image: <dir>/index.json plus each file under <dir>/static/.
export async function writeCarry(dir: string, fromContentId: string, files: Record<string, { body: string; contentType: string }>): Promise<void> {
  const index: { version: 1; contentId: string; files: Record<string, { file: string; contentType: string }> } = { version: 1, contentId: fromContentId, files: {} };
  for (const [urlPath, f] of Object.entries(files)) {
    const rel = urlPath.replace(/^\/+/, "");
    await mkdir(dirname(join(dir, "static", rel)), { recursive: true });
    await writeFile(join(dir, "static", rel), f.body);
    index.files[urlPath] = { file: rel, contentType: f.contentType };
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.json"), JSON.stringify(index));
}

// echoFunction reports what the app server forwarded to the function. It
// also sets a wrong x-nbo-deployment-id on its own response, which the app
// server must replace.
export const echoFunction: FetchHandler = async (request: Request) => {
  const echo = (name: string): string => request.headers.get(name) ?? "absent";
  return new Response("echo", {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-nbo-deployment-id": "sha256:" + "f".repeat(64),
      "x-echo-deployment-id": echo("x-nbo-deployment-id"),
      "x-echo-next-resume": echo("next-resume"),
      "x-echo-x-matched-path": echo("x-matched-path"),
      "x-echo-forwarded-host": echo("x-forwarded-host"),
    },
  });
};
