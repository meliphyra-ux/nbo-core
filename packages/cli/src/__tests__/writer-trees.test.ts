// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NboWriter } from "@nbo/writer";
import { validate } from "@nbo/validate";

// Trees made by @nbo/writer, checked by @nbo/validate: the two packages
// don't depend on each other, so the cross-check lives here.

let srcDir: string;
let outDir: string;

beforeEach(() => {
  srcDir = mkdtempSync(join(tmpdir(), "nbo-cli-wt-src-"));
  outDir = mkdtempSync(join(tmpdir(), "nbo-cli-wt-out-"));
  writeFileSync(join(srcDir, "index.html"), "<h1>home</h1>");
});

afterEach(() => {
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

async function writeStaticTree(): Promise<void> {
  const writer = new NboWriter({ outDir, framework: { name: "static" } });
  writer.addStatic("/", join(srcDir, "index.html"), { cache: "revalidate" });
  await writer.write();
}

describe("writer trees", () => {
  it("a static writer tree validates", async () => {
    await writeStaticTree();
    expect(validate(outDir, { strict: true }).map((e) => e.message)).toEqual([]);
  });

  it("an SPA writer tree validates", async () => {
    writeFileSync(join(srcDir, "app-abc123.js"), "console.log(1)");
    const writer = new NboWriter({ outDir, framework: { name: "vite" } });
    writer.addStatic("/", join(srcDir, "index.html"), { cache: "revalidate" });
    writer.addStatic("/assets/app-abc123.js", join(srcDir, "app-abc123.js"), { cache: "immutable" });
    writer.setFallbackToRoot();
    await writer.write();
    expect(validate(outDir, { strict: true }).map((e) => e.message)).toEqual([]);
  });

  it("a functions tree with ISR and PPR prerenders, middleware, images and a cron validates", async () => {
    // Shapes as packages/next-adapter/src/translate-routing.js writes them.
    mkdirSync(join(srcDir, "fn"));
    writeFileSync(join(srcDir, "fn", "index.mjs"), "export default { fetch() { return new Response('ok'); } };");
    writeFileSync(join(srcDir, "fn", "mw.mjs"), "export default { fetch() { return new Response(null); } };");
    writeFileSync(join(srcDir, "isr.html"), "<p>isr</p>");
    writeFileSync(join(srcDir, "ppr.html"), "<p>ppr shell</p>");
    writeFileSync(join(srcDir, "404.html"), "<p>not found</p>");

    const writer = new NboWriter({ outDir, framework: { name: "nextjs", version: "16.0.0" } });
    writer.addStatic("/", join(srcDir, "index.html"));
    writer.addStatic("/isr", join(srcDir, "isr.html"));
    writer.addStatic("/ppr", join(srcDir, "ppr.html"));
    writer.addStatic("/404", join(srcDir, "404.html"));
    const ssr = writer.addFunction("ssr", {
      runtime: { kind: "node", version: ">=22" },
      entryFilePath: join(srcDir, "fn", "index.mjs"),
      capabilities: ["fn.streaming"],
    });
    ssr.addRoute("/api/hello", "/api/hello", "app/api/hello/route.js");
    ssr.addFile("server/page.js", "module.exports = {};");
    writer.addFunction("middleware", {
      runtime: { kind: "node", version: ">=22" },
      entryFilePath: join(srcDir, "fn", "mw.mjs"),
      capabilities: [],
    });
    writer.setRoutes({
      version: 1,
      beforeFiles: [
        { id: "middleware-0", match: { path: "^/dashboard" }, action: { type: "middleware", function: "middleware" } },
      ],
      afterFiles: [{ id: "/api/hello", match: { path: "^/api/hello$" }, action: { type: "rewrite", function: "ssr" } }],
      error: { "404": { file: "/404" } },
    });
    const common = {
      function: "ssr",
      tags: ["group:1"],
      allowQuery: [],
      varyHeaders: [],
      bypassToken: { env: "NBO_PRERENDER_BYPASS" },
    };
    writer.addPrerender({
      id: "/isr",
      match: "^/isr$",
      revalidateSec: 60,
      expireSec: 31536000,
      seeds: { "/isr": { file: "/isr" } },
      onMiss: "blocking",
      ...common,
    });
    writer.addPrerender({
      id: "/ppr",
      match: "^/ppr$",
      revalidateSec: 0,
      expireSec: 0,
      seeds: { "/ppr": { file: "/ppr" } },
      onMiss: "blocking",
      ...common,
      "x-nbo-ppr": { postponedState: "state" },
    });
    writer.setImages({
      widths: [640],
      formats: ["image/webp"],
      qualities: [75],
      remotePatterns: [],
      localPatterns: [{ pathname: "^/assets/" }],
      minimumCacheTTLSec: 60,
      allowSvg: false,
    });
    writer.setEnv({ required: [], optional: [], inlinedAtBuild: [] });
    writer.addCron({
      id: "nightly",
      schedule: "0 3 * * *",
      timezone: "UTC",
      target: { function: "ssr", path: "/api/hello", method: "POST" },
      overlap: "skip",
      timeoutSec: 60,
    });
    await writer.write();

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.requires.extensions).toEqual([{ id: "x-nbo-ppr", version: "1", critical: true }]);
    expect(validate(outDir, { strict: true }).map((e) => e.message)).toEqual([]);
  });

  it("validate refuses a writer tree patched to a newer spec minor", async () => {
    await writeStaticTree();
    // The manifest isn't in its own digests, so patching it leaves them valid.
    const p = join(outDir, "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.specVersion = "1.1";
    writeFileSync(p, JSON.stringify(m));
    expect(validate(outDir).map((e) => e.message)).toEqual([
      "manifest.json: built for NBO spec 1.1; this nbo reads spec 1.0 and older 1.x; upgrade NBO",
    ]);
  });
});
