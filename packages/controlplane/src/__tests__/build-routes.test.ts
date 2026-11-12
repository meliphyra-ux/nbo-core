// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createStore } from "../store.js";
import { createMux } from "../handlers.js";
import { wireV2 } from "../v2.js";
import { createArtifactStore } from "../artifacts.js";
import { fakeCloudSetup, fakeCloudTeardown, fakeDeploymentTrigger } from "../testing.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const SECRET = "s3cr3t-value-XYZ";
const PLAIN = "plain-value-ABC";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-build-routes-"));
  const artifactsDir = join(dir, "artifacts");
  const store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32), artifactsDir });
  cleanups.push(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const artifacts = createArtifactStore(artifactsDir, (p) => store.listBuilds(p).map((b) => b.id));
  const deploys = fakeDeploymentTrigger(store);
  const v2 = wireV2(store, {
    deploymentTrigger: deploys,
    cloudSetup: fakeCloudSetup(),
    cloudTeardown: fakeCloudTeardown(),
    edgeAdminUrl: "http://127.0.0.1:1",
    edgePublicPort: 9443,
    artifacts,
  });
  const mux = createMux(store, deploys, v2.queue, v2);
  const call = async (path: string) => {
    const res = await mux(new Request(`http://cp${path}`));
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, json, text };
  };
  const project = store.createProject("shop");
  store.setEnv({ projectId: null }, "PLAIN_VAR", PLAIN, false);
  store.setEnv({ projectId: project.id }, "SECRET_VAR", SECRET, true);
  const build = store.createBuild(project.id, "a".repeat(40));
  store.setBuildDetails(build.id, {
    input: {
      repo: "https://github.com/a/b",
      productionBranch: "main",
      framework: "static",
      buildCommand: "x",
      manual: false,
      variables: [
        { name: "SECRET_VAR", secret: true },
        { name: "PLAIN_VAR", secret: false },
      ],
    },
    commit: { sha: "a".repeat(40), message: "hi", author: "Ada", committedAt: "2026-11-03T10:00:00Z" },
    contentId: "sha256:abc",
  });
  store.completeBuild(build.id, "succeeded");
  return { store, artifacts, artifactsDir, call, build };
}

async function writeNbo(dir: string, n = 5) {
  await mkdir(join(dir, "functions", "ssr", "bundle"), { recursive: true });
  const files: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) files[`/f${String(i).padStart(2, "0")}.js`] = { contentType: "text/javascript", size: 10 + i, cache: "immutable", file: `f${i}.js` };
  files["/docs/a.html"] = { contentType: "text/html", size: 3, cache: "revalidate", file: "a.html" };
  await writeFile(join(dir, "static.index.json"), JSON.stringify({ files }));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ functions: ["ssr", "../evil"] }));
  await writeFile(join(dir, "routes.json"), JSON.stringify({ afterFiles: [{ match: { path: "^/api$" }, action: { function: "ssr" } }] }));
  await writeFile(
    join(dir, "functions", "ssr", "function.json"),
    JSON.stringify({
      name: "ssr",
      runtime: { kind: "node", version: ">=24" },
      handler: { entry: "index.mjs", export: "default", style: "fetch" },
      artifact: { type: "bundle", path: "bundle/", files: "bundle.index.json" },
      resources: { memoryMb: 256 },
    }),
  );
  await writeFile(join(dir, "functions", "ssr", "bundle", "bundle.index.json"), JSON.stringify({ files: { "index.mjs": { size: 100 }, "x.js": { size: 23 } } }));
}

async function withOutput(s: Awaited<ReturnType<typeof setup>>, n?: number) {
  const src = join(s.artifactsDir, "..", "src-nbo");
  await writeNbo(src, n);
  await s.artifacts.save(s.build.id, src);
  s.store.setBuildDetails(s.build.id, { artifact: true });
}

describe("build routes", () => {
  it("GET /builds/{id} includes the captured details", async () => {
    const s = await setup();
    const res = await s.call(`/builds/${s.build.id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ commit: { author: "Ada" }, contentId: "sha256:abc", artifact: false, manual: false });
    expect(res.json.input.variables).toEqual([
      { name: "SECRET_VAR", secret: true },
      { name: "PLAIN_VAR", secret: false },
    ]);
  });

  it("pages files sorted by path with a cursor, and filters by prefix", async () => {
    const s = await setup();
    await withOutput(s);
    const first = await s.call(`/builds/${s.build.id}/files?limit=4`);
    expect(first.status).toBe(200);
    expect(first.json.files.map((f: any) => f.path)).toEqual(["/docs/a.html", "/f00.js", "/f01.js", "/f02.js"]);
    expect(first.json.files[1]).toEqual({ path: "/f00.js", contentType: "text/javascript", size: 10, cache: "immutable" });
    expect(first.json.nextCursor).toBe("/f02.js");
    const second = await s.call(`/builds/${s.build.id}/files?limit=4&cursor=${encodeURIComponent(first.json.nextCursor)}`);
    expect(second.json.files.map((f: any) => f.path)).toEqual(["/f03.js", "/f04.js"]);
    expect(second.json.nextCursor).toBeNull();
    const filtered = await s.call(`/builds/${s.build.id}/files?prefix=/docs`);
    expect(filtered.json.files.map((f: any) => f.path)).toEqual(["/docs/a.html"]);
    expect((await s.call(`/builds/${s.build.id}/files?prefix=${encodeURIComponent("../../etc")}`)).json.files).toEqual([]);
  });

  it("caps limit at 500 and rejects a bad one", async () => {
    const s = await setup();
    await withOutput(s);
    expect((await s.call(`/builds/${s.build.id}/files?limit=100000`)).status).toBe(200);
    expect((await s.call(`/builds/${s.build.id}/files?limit=abc`)).status).toBe(400);
  });

  it("lists functions with size from the declared bundle index and mapped routes, skipping unsafe names", async () => {
    const s = await setup();
    await withOutput(s);
    const res = await s.call(`/builds/${s.build.id}/functions`);
    expect(res.status).toBe(200);
    expect(res.json.functions).toEqual([{ name: "ssr", runtime: "node >=24", entry: "index.mjs", bundleBytes: 123, memoryMb: 256, routes: ["^/api$"] }]);
  });

  it("404s for an unknown build and for output that was cleaned up", async () => {
    const s = await setup();
    const missing = await s.call(`/builds/nope/files`);
    expect(missing.status).toBe(404);
    expect(missing.json.error).toMatch(/build/);
    for (const path of ["files", "functions"]) {
      const gone = await s.call(`/builds/${s.build.id}/${path}`);
      expect(gone.status).toBe(404);
      expect(gone.json.error).toBe("This build's output was cleaned up: redeploy to rebuild it");
    }
  });

  it("never returns an environment variable value", async () => {
    const s = await setup();
    await withOutput(s);
    for (const path of ["", "/files", "/functions"]) {
      const res = await s.call(`/builds/${s.build.id}${path}`);
      expect(res.text).not.toContain(SECRET);
      expect(res.text).not.toContain(PLAIN);
    }
  });
});
