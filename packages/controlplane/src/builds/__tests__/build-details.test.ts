// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { produce } from "@nbo/producer-static";
import { contentId } from "@nbo/digest";
import {
  listFunctions,
  parseCommit,
  buildInput,
  summarizeOutput,
  parseSubStep,
  createTimeline,
} from "../build-details.js";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

describe("parseCommit", () => {
  it("takes the separator line and ignores stderr noise around it", () => {
    const out =
      "warning: some git noise\n" +
      "a".repeat(40) +
      "\x1fFix the header\x1fAda Lovelace\x1f2026-11-03T10:00:00+01:00\n" +
      "trailing noise\n";
    expect(parseCommit(out)).toEqual({
      sha: "a".repeat(40),
      message: "Fix the header",
      author: "Ada Lovelace",
      committedAt: "2026-11-03T10:00:00+01:00",
    });
  });

  it("caps the message at 200 characters", () => {
    const out = `${"b".repeat(40)}\x1f${"m".repeat(300)}\x1fA\x1f2026-11-03T10:00:00Z`;
    expect(parseCommit(out)!.message).toHaveLength(200);
  });

  it("returns null without a separator line", () => {
    expect(parseCommit("fatal: not a git repository\n")).toBeNull();
  });
});

describe("buildInput", () => {
  it("records settings and variable names with their kind, never values", () => {
    const input = buildInput(
      {
        repo: "https://github.com/a/b",
        productionBranch: "main",
        framework: "static",
        buildCommand: "npm run build",
        outputDir: "dist",
        rootDirectory: "web",
        ignoredBuildStepCommand: "exit 1",
      },
      true,
      { vars: { B_PLAIN: "plain-value", A_SECRET: "s3cr3t-value" }, secretNames: ["A_SECRET"] },
      "fp-0123456789abcdef",
    );
    expect(input).toEqual({
      repo: "https://github.com/a/b",
      productionBranch: "main",
      framework: "static",
      rootDirectory: "web",
      buildCommand: "npm run build",
      outputDir: "dist",
      ignoredBuildStepCommand: "exit 1",
      manual: true,
      envFingerprint: "fp-0123456789abcdef",
      variables: [
        { name: "A_SECRET", secret: true },
        { name: "B_PLAIN", secret: false },
      ],
    });
    const json = JSON.stringify(input);
    expect(json).not.toContain("plain-value");
    expect(json).not.toContain("s3cr3t-value");
  });
});

describe("parseSubStep", () => {
  it("reads done, failed and skipped sub-step messages", () => {
    expect(parseSubStep("image built in 3.5s", 10_000)).toEqual({
      name: "image built",
      startedAt: new Date(6_500).toISOString(),
      durationMs: 3500,
      status: "succeeded",
    });
    expect(parseSubStep("function ssr: image push failed after 1.0s", 5_000)).toMatchObject({
      name: "function ssr: image push",
      durationMs: 1000,
      status: "failed",
    });
    expect(parseSubStep("unchanged, skipped", 5_000)).toMatchObject({
      name: "unchanged",
      durationMs: 0,
      status: "skipped",
    });
    expect(parseSubStep("content id sha256:x is already live, skipped", 5_000)).toMatchObject({
      name: "content id sha256:x is already live",
      status: "skipped",
    });
    expect(parseSubStep("pushing layers", 5_000)).toBeNull();
  });
});

describe("createTimeline", () => {
  it("records entries in begin order with nested children", () => {
    let t = 1000;
    const tl = createTimeline(() => t);
    const a = tl.begin("clone and checkout");
    t = 3000;
    tl.end(a, "succeeded");
    const d = tl.begin("deploy k8s");
    d.children!.push({
      name: "image built",
      startedAt: new Date(3000).toISOString(),
      durationMs: 500,
      status: "succeeded",
    });
    t = 4000;
    tl.end(d, "failed");
    expect(tl.entries).toEqual([
      { name: "clone and checkout", startedAt: new Date(1000).toISOString(), durationMs: 2000, status: "succeeded" },
      {
        name: "deploy k8s",
        startedAt: new Date(3000).toISOString(),
        durationMs: 1000,
        status: "failed",
        children: [expect.objectContaining({ name: "image built" })],
      },
    ]);
  });
});

describe("summarizeOutput", () => {
  it("rejects a corrupt manifest and a missing one", async () => {
    const nbo = await tmp("bd-corrupt-");
    await expect(summarizeOutput(nbo)).rejects.toThrow(/manifest/);
    await writeFile(join(nbo, "manifest.json"), "{not json");
    await expect(summarizeOutput(nbo)).rejects.toThrow();
  });

  it("summarizes a static site's .nbo/", async () => {
    const src = await tmp("bd-static-src-");
    await writeFile(join(src, "index.html"), "<h1>hi</h1>");
    await mkdir(join(src, "assets"));
    await writeFile(join(src, "assets", "app.js"), "console.log(1)");
    const nbo = join(await tmp("bd-static-out-"), ".nbo");
    const { contentId: cid } = await produce(src, nbo);
    const s = await summarizeOutput(nbo);
    expect(s).toEqual({
      framework: { name: "static" },
      contentId: cid,
      staticFiles: 2,
      staticBytes: "<h1>hi</h1>".length + "console.log(1)".length,
      functions: [],
      prerenders: 0,
      images: false,
      crons: 0,
    });
  });

  it("summarizes a Next-like .nbo/ with a function, routes, prerenders, images and crons", async () => {
    const nbo = join(await tmp("bd-next-"), ".nbo");
    await mkdir(join(nbo, "functions", "ssr", "bundle"), { recursive: true });
    const manifest = {
      specVersion: "0.1",
      build: { id: "b", createdAt: "2026-11-03T00:00:00Z", framework: { name: "nextjs", version: "16.0.0" } },
      requires: [],
      functions: ["ssr"],
      digests: {},
      images: { widths: [640] },
      crons: [{ id: "c1", schedule: "* * * * *", target: { path: "/api/cron" } }],
    };
    await writeFile(join(nbo, "manifest.json"), JSON.stringify(manifest));
    await writeFile(
      join(nbo, "static.index.json"),
      JSON.stringify({
        files: {
          "/a.js": { file: "a.js", digest: "sha256:x", size: 10, contentType: "text/javascript", cache: "immutable" },
        },
      }),
    );
    await writeFile(
      join(nbo, "routes.json"),
      JSON.stringify({
        version: 1,
        beforeFiles: [{ id: "mw", match: { path: "^/.*$" }, action: { type: "middleware", function: "ssr" } }],
        afterFiles: [
          { id: "/", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } },
          { id: "/x", match: { path: "^/x$" }, action: { type: "rewrite", function: "other" } },
          { id: "/dup", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } },
        ],
      }),
    );
    await writeFile(
      join(nbo, "functions", "ssr", "function.json"),
      JSON.stringify({
        name: "ssr",
        runtime: { kind: "node", version: "22" },
        handler: { style: "fetch", entry: "index.mjs", export: "default" },
        artifact: { type: "bundle", path: "bundle", digest: "sha256:x", files: "bundle.index.json" },
        resources: { memoryMb: 512, maxDurationSec: 30 },
        concurrency: "multi",
      }),
    );
    await writeFile(
      join(nbo, "functions", "ssr", "bundle", "bundle.index.json"),
      JSON.stringify({
        files: { "index.mjs": { digest: "sha256:x", size: 100 }, "lib.js": { digest: "sha256:y", size: 23 } },
      }),
    );
    await writeFile(join(nbo, "prerender.json"), JSON.stringify({ version: 1, prerenders: [{}, {}] }));

    const s = await summarizeOutput(nbo);
    expect(s).toEqual({
      framework: { name: "nextjs", version: "16.0.0" },
      contentId: contentId(manifest as unknown as Record<string, unknown>),
      staticFiles: 1,
      staticBytes: 10,
      functions: [
        {
          name: "ssr",
          runtime: "node 22",
          bundleBytes: 123,
          memoryMb: 512,
          maxDurationSec: 30,
          routes: ["^/.*$", "^/$"],
        },
      ],
      prerenders: 2,
      images: true,
      crons: 1,
    });
  });
});

const canFileSymlink = await (async () => {
  const d = await mkdtemp(join(tmpdir(), "lf-probe-"));
  try {
    await writeFile(join(d, "t"), "x");
    await symlink(join(d, "t"), join(d, "l"), "file");
    return true;
  } catch {
    return false;
  } finally {
    await rm(d, { recursive: true, force: true });
  }
})();

const canSymlink = await (async () => {
  const d = await mkdtemp(join(tmpdir(), "lf-probe-"));
  try {
    await mkdir(join(d, "t"));
    await symlink(join(d, "t"), join(d, "l"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    await rm(d, { recursive: true, force: true });
  }
})();

describe("listFunctions path handling", () => {
  async function nbo(root: string, artifact: { path: string; files: string }) {
    await mkdir(join(root, "nbo", "functions", "ssr", "bundle"), { recursive: true });
    await writeFile(join(root, "nbo", "manifest.json"), JSON.stringify({ functions: ["ssr", "bad"] }));
    await writeFile(
      join(root, "nbo", "functions", "ssr", "function.json"),
      JSON.stringify({ runtime: { kind: "node" }, handler: { entry: "i.mjs" }, artifact }),
    );
    await mkdir(join(root, "nbo", "functions", "bad"), { recursive: true });
    await writeFile(join(root, "nbo", "functions", "bad", "function.json"), "{not json");
    await writeFile(
      join(root, "nbo", "functions", "ssr", "bundle", "bundle.index.json"),
      JSON.stringify({ files: { a: { size: 7 } } }),
    );
    return join(root, "nbo");
  }

  it("sums the bundle size from a relative .nbo/ directory", async () => {
    const root = await tmp("lf-rel-");
    await nbo(root, { path: "bundle/", files: "bundle.index.json" });
    const { relative } = await import("node:path");
    const fns = await listFunctions(relative(process.cwd(), join(root, "nbo")));
    expect(fns.find((f) => f.name === "ssr")!.bundleBytes).toBe(7);
  });

  it("does not follow artifact.files out of the function directory", async () => {
    const root = await tmp("lf-esc-");
    // bundle/ + ../../../../ resolves to <root>, outside .nbo/
    const dir = await nbo(root, { path: "bundle/", files: "../../../../idx.json" });
    await writeFile(join(root, "idx.json"), JSON.stringify({ files: { a: { size: 999 } } }));
    expect((await listFunctions(dir)).find((f) => f.name === "ssr")!.bundleBytes).toBe(0);
  });

  it("does not follow artifact.path out of the function directory", async () => {
    const root = await tmp("lf-esc2-");
    const dir = await nbo(root, { path: "../../x", files: "idx.json" });
    await mkdir(join(dir, "x"), { recursive: true });
    await writeFile(join(dir, "x", "idx.json"), JSON.stringify({ files: { a: { size: 999 } } }));
    expect((await listFunctions(dir)).find((f) => f.name === "ssr")!.bundleBytes).toBe(0);
  });

  it("skips a function whose function.json is corrupt instead of failing", async () => {
    const root = await tmp("lf-bad-");
    const dir = await nbo(root, { path: "bundle/", files: "bundle.index.json" });
    expect((await listFunctions(dir)).map((f) => f.name)).toEqual(["ssr"]);
  });

  it.skipIf(!canFileSymlink)("ignores a bundle index that is a symlink", async () => {
    const root = await tmp("lf-sym-");
    const dir = await nbo(root, { path: "bundle/", files: "link.json" });
    await writeFile(join(root, "real.json"), JSON.stringify({ files: { a: { size: 50 } } }));
    await symlink(join(root, "real.json"), join(dir, "functions", "ssr", "bundle", "link.json"));
    expect((await listFunctions(dir)).find((f) => f.name === "ssr")!.bundleBytes).toBe(0);
  });

  it.skipIf(!canSymlink)("ignores a bundle directory that is a symlink out of the function directory", async () => {
    const root = await tmp("lf-dsym-");
    const dir = await nbo(root, { path: "linked/", files: "bundle.index.json" });
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(join(root, "outside", "bundle.index.json"), JSON.stringify({ files: { a: { size: 50 } } }));
    await symlink(join(root, "outside"), join(dir, "functions", "ssr", "linked"), "junction");
    expect((await listFunctions(dir)).find((f) => f.name === "ssr")!.bundleBytes).toBe(0);
  });
});
