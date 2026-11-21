// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../../store/store.js";
import { createArtifactStore, retainedBuildIds, resolveArtifactsDir } from "../artifacts.js";

const scratch: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}
async function fakeNbo(): Promise<string> {
  const nbo = join(await tmp("art-src-"), ".nbo");
  await mkdir(join(nbo, "static"), { recursive: true });
  await writeFile(join(nbo, "manifest.json"), "{}");
  await writeFile(join(nbo, "static", "index.html"), "hi");
  return nbo;
}

describe("resolveArtifactsDir", () => {
  it("defaults to artifacts/ next to the database and honours NBO_ARTIFACTS_DIR", () => {
    expect(resolveArtifactsDir({}, join("data", "cp.db"))).toBe(join("data", "artifacts"));
    expect(resolveArtifactsDir({ NBO_ARTIFACTS_DIR: "/srv/art" }, "x.db")).toBe("/srv/art");
  });
});

describe("artifact store", () => {
  it("copies .nbo/ to <dir>/<buildId> without leaving a .tmp, and removes it", async () => {
    const dir = await tmp("art-dir-");
    const art = createArtifactStore(dir, () => []);
    await art.save("build_1", await fakeNbo());
    expect(art.path("build_1")).toBe(join(dir, "build_1"));
    expect(await readFile(join(dir, "build_1", "static", "index.html"), "utf8")).toBe("hi");
    expect(await readdir(dir)).toEqual(["build_1"]);
    expect(art.path("build_2")).toBeNull();
    await art.remove("build_1");
    expect(art.path("build_1")).toBeNull();
  });

  it("rejects build ids that are not plain names", async () => {
    const art = createArtifactStore(await tmp("art-dir-"), () => []);
    await expect(art.save("../evil", await fakeNbo())).rejects.toThrow(/build id/);
    expect(art.path("../evil")).toBeNull();
  });

  it("prune removes only the project's artifacts that keep() rejects", async () => {
    const dir = await tmp("art-dir-");
    const art = createArtifactStore(dir, (p) => (p === "proj_a" ? ["b1", "b2", "b3"] : ["other"]));
    for (const id of ["b1", "b2", "b3", "other"]) await art.save(id, await fakeNbo());
    const removed = await art.prune("proj_a", (id) => id === "b2");
    expect(removed.sort()).toEqual(["b1", "b3"]);
    expect(art.path("b2")).not.toBeNull();
    expect(art.path("other")).not.toBeNull();
  });
});

async function openStore(artifactsDir?: string): Promise<Store> {
  const dir = await tmp("art-db-");
  const s = createStore(join(dir, "t.db"), { artifactsDir });
  stores.push(s);
  return s;
}

describe("retainedBuildIds", () => {
  it("keeps the newest N succeeded builds with artifacts plus any build live on an environment", async () => {
    const store = await openStore();
    const p = store.createProject("acme");
    const env = store.createEnvironment(p.id, "k8s", "kubernetes");
    const ids: string[] = [];
    // The oldest build is live: its deployment is the env's latest succeeded one.
    const dep = store.createDeployment(env.id);
    store.completeDeployment(dep.id, "sha256:x", "https://x");
    for (let i = 0; i < 4; i++) {
      const b = store.createQueuedBuild(p.id, "a".repeat(40));
      store.completeBuild(b.id, "succeeded", i === 0 ? [dep.id] : [`dep_other_${i}`]);
      store.setBuildDetails(b.id, { artifact: true });
      ids.push(b.id);
    }
    // A later failed deployment does not change which build is live.
    const failed = store.createDeployment(env.id);
    store.failDeployment(failed.id, "boom");
    const noArtifact = store.createQueuedBuild(p.id, "a".repeat(40));
    store.completeBuild(noArtifact.id, "succeeded", []);
    const failedBuild = store.createQueuedBuild(p.id, "a".repeat(40));
    store.completeBuild(failedBuild.id, "failed", [failed.id], "boom");
    store.setBuildDetails(failedBuild.id, { artifact: true });

    const keep = retainedBuildIds(store, p.id, 2);
    expect([...keep].sort()).toEqual([ids[0]!, ids[2]!, ids[3]!].sort());
  });

  it("keeps the build live on a staging cloud", async () => {
    const store = await openStore();
    const p = store.createProject("acme");
    const staging = store.createStage(p.id, { name: "staging", branch: "staging", host: "" });
    const env = store.createEnvironment(p.id, "s-staging-k8s", "kubernetes", undefined, staging.id);
    const live = store.createQueuedBuild(p.id, "a".repeat(40), { stageId: staging.id });
    store.setBuildDetails(live.id, { artifact: true });
    const dep = store.createDeployment(env.id, { buildId: live.id });
    store.completeDeployment(dep.id, "sha256:x", "https://x");
    store.completeBuild(live.id, "succeeded", [dep.id]);
    const newer = store.createQueuedBuild(p.id, "b".repeat(40));
    store.setBuildDetails(newer.id, { artifact: true });
    store.completeBuild(newer.id, "succeeded", []);

    expect([...retainedBuildIds(store, p.id, 1)].sort()).toEqual([live.id, newer.id].sort());
  });

  it("keeps the output of a build still running (another stage's build may prune meanwhile)", async () => {
    const store = await openStore();
    const p = store.createProject("acme");
    const running = store.createQueuedBuild(p.id, "a".repeat(40));
    store.startBuild(running.id);
    store.setBuildDetails(running.id, { artifact: true });
    expect([...retainedBuildIds(store, p.id, 0)]).toEqual([running.id]);
  });
});

describe("deleteProject", () => {
  it("removes the project's artifacts", async () => {
    const artDir = await tmp("art-dir-");
    const store = await openStore(artDir);
    const p = store.createProject("acme");
    const other = store.createProject("other");
    const b = store.createQueuedBuild(p.id, "a".repeat(40));
    const ob = store.createQueuedBuild(other.id, "a".repeat(40));
    const art = createArtifactStore(artDir, (pid) => store.listBuilds(pid).map((x) => x.id));
    await art.save(b.id, await fakeNbo());
    await art.save(ob.id, await fakeNbo());
    store.deleteProject(p.id);
    expect(existsSync(join(artDir, b.id))).toBe(false);
    expect(existsSync(join(artDir, ob.id))).toBe(true);
  });
});

describe("build details columns", () => {
  it("a new build reads as no details until they are captured", async () => {
    const store = await openStore();
    const p = store.createProject("acme");
    const b = store.getBuild(store.createQueuedBuild(p.id, "a".repeat(40)).id);
    expect(b).toMatchObject({
      commit: null,
      input: null,
      timeline: null,
      outputSummary: null,
      contentId: "",
      artifact: false,
    });
    store.setBuildDetails(b.id, {
      commit: { sha: "s", message: "m", author: "a", committedAt: "t" },
      contentId: "sha256:c",
      artifact: true,
    });
    expect(store.getBuild(b.id)).toMatchObject({
      commit: { sha: "s" },
      contentId: "sha256:c",
      artifact: true,
      input: null,
    });
  });
});

describe("createArtifactStore with a relative directory", () => {
  it("resolves the directory to an absolute path once", async () => {
    const { relative, isAbsolute } = await import("node:path");
    const { createArtifactStore } = await import("../artifacts.js");
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "art-rel-"));
    try {
      await mkdir(join(root, "b1"), { recursive: true });
      const store = createArtifactStore(relative(process.cwd(), root), () => []);
      const p = store.path("b1");
      expect(p && isAbsolute(p)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("retainedBuildIds: live builds", () => {
  it("keeps the build a cloud runs, found by the deployment's build id", async () => {
    const store = await openStore();
    const p = store.createProject("acme");
    const k8s = store.createEnvironment(p.id, "k8s", "kubernetes");
    const cr = store.createEnvironment(p.id, "cloudrun", "cloudrun");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const b = store.createQueuedBuild(p.id, "a".repeat(40));
      store.completeBuild(b.id, "succeeded", []);
      store.setBuildDetails(b.id, { artifact: true, contentId: `sha256:c${i}` });
      ids.push(b.id);
    }
    // k8s runs the oldest build (a promote: the build's deploymentIds do not list it).
    const dep = store.createDeployment(k8s.id, { buildId: ids[0]! });
    store.completeDeployment(dep.id, "sha256:c0", "https://k");
    // cloudrun runs the second build; a later failed deploy changes nothing.
    const crDep = store.createDeployment(cr.id, { buildId: ids[1]! });
    store.completeDeployment(crDep.id, "sha256:c1", "https://c");
    const crFailed = store.createDeployment(cr.id, { buildId: ids[3]! });
    store.failDeployment(crFailed.id, "boom");

    const keep = retainedBuildIds(store, p.id, 1);
    expect([...keep].sort()).toEqual([ids[0]!, ids[1]!, ids[3]!].sort());
  });

  it("falls back to matching the content id for deployments made before build ids were recorded", async () => {
    const store = await openStore();
    const p = store.createProject("acme");
    const env = store.createEnvironment(p.id, "k8s", "kubernetes");
    const old = store.createQueuedBuild(p.id, "a".repeat(40));
    store.completeBuild(old.id, "succeeded", []);
    store.setBuildDetails(old.id, { artifact: true, contentId: "sha256:old" });
    const newer = store.createQueuedBuild(p.id, "b".repeat(40));
    store.completeBuild(newer.id, "succeeded", []);
    store.setBuildDetails(newer.id, { artifact: true, contentId: "sha256:new" });
    const dep = store.createDeployment(env.id);
    store.completeDeployment(dep.id, "sha256:old", "https://k");

    expect([...retainedBuildIds(store, p.id, 1)].sort()).toEqual([old.id, newer.id].sort());
  });

  it("an archived environment's build is not kept as live", async () => {
    const store = await openStore();
    const p = store.createProject("acme");
    const env = store.createEnvironment(p.id, "k8s", "kubernetes");
    store.createEnvironment(p.id, "cloudrun", "cloudrun");
    const old = store.createQueuedBuild(p.id, "a".repeat(40));
    store.completeBuild(old.id, "succeeded", []);
    store.setBuildDetails(old.id, { artifact: true });
    const newer = store.createQueuedBuild(p.id, "b".repeat(40));
    store.completeBuild(newer.id, "succeeded", []);
    store.setBuildDetails(newer.id, { artifact: true });
    const dep = store.createDeployment(env.id, { buildId: old.id });
    store.completeDeployment(dep.id, "sha256:x", "https://k");
    store.archiveEnvironment(env.id);
    expect([...retainedBuildIds(store, p.id, 1)]).toEqual([newer.id]);
  });
});

describe("artifact holds", () => {
  it("prune never removes a held build, and removes it once released", async () => {
    const dir = await tmp("art-dir-");
    const art = createArtifactStore(dir, () => ["b1", "b2"]);
    await art.save("b1", await fakeNbo());
    await art.save("b2", await fakeNbo());
    const release = art.hold("b1");
    expect(await art.prune("proj", () => false)).toEqual(["b2"]);
    expect(art.path("b1")).not.toBeNull();
    release();
    release(); // releasing twice is harmless
    expect(await art.prune("proj", () => false)).toEqual(["b1"]);
    expect(art.path("b1")).toBeNull();
  });

  it("two holds on one build keep it until both are released", async () => {
    const dir = await tmp("art-dir-");
    const art = createArtifactStore(dir, () => ["b1"]);
    await art.save("b1", await fakeNbo());
    const a = art.hold("b1");
    const b = art.hold("b1");
    a();
    expect(await art.prune("proj", () => false)).toEqual([]);
    b();
    expect(await art.prune("proj", () => false)).toEqual(["b1"]);
  });
});

describe("liveBuild content-id fallback", () => {
  it("never returns a promote job", async () => {
    const store = await openStore();
    const p = store.createProject("acme");
    const env = store.createEnvironment(p.id, "k8s", "kubernetes");
    const b = store.createQueuedBuild(p.id, "a".repeat(40));
    store.completeBuild(b.id, "succeeded", []);
    store.setBuildDetails(b.id, { contentId: "sha256:same" });
    const job = store.createQueuedPromote(p.id, b.id, env.id); // copies contentId, newer
    store.completeBuild(job.id, "succeeded", []);
    const dep = store.createDeployment(env.id);
    store.completeDeployment(dep.id, "sha256:same", "https://k");
    const { liveBuild } = await import("../artifacts.js");
    expect(liveBuild(store, env)?.id).toBe(b.id);
  });
});
