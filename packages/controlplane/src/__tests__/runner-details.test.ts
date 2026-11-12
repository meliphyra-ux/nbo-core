// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createStore, type Store } from "../store.js";
import type { GitConfig } from "../git.js";
import { createRunner } from "../runner.js";
import { createArtifactStore } from "../artifacts.js";
import type { TimelineEntry } from "../build-details.js";

const openStores: Store[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  for (const s of openStores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(d);
  return d;
}

async function setup() {
  const dbDir = await tmp("controlplane-runner-details-");
  const artifactsDir = join(dbDir, "artifacts");
  const store = createStore(join(dbDir, "test.db"), { secretKey: randomBytes(32), artifactsDir });
  openStores.push(store);
  const artifacts = createArtifactStore(artifactsDir, (p) => store.listBuilds(p).map((b) => b.id));
  const repoPath = await tmp("controlplane-runner-details-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Grace Hopper");
  await writeFile(join(repoPath, "package.json"), "{}");
  git("add", ".");
  git("commit", "-q", "-m", "Add the landing page");
  const revision = git("rev-parse", "HEAD").toString().trim();
  return { store, artifacts, artifactsDir, repoPath, revision };
}

function cfg(repo: string, overrides: Partial<GitConfig> = {}): GitConfig {
  return { repo, productionBranch: "main", framework: "static", buildCommand: "mkdir dist && echo hi > dist/index.html", outputDir: "dist", ...overrides };
}

const names = (entries: TimelineEntry[] | null | undefined) => (entries ?? []).map((e) => [e.name, e.status]);

describe("runner build details", () => {
  it("captures commit, input, timeline and output, and keeps the build output", async () => {
    const { store, artifacts, artifactsDir, repoPath, revision } = await setup();
    const p = store.createProject("acme");
    store.setGitConfig(p.id, cfg(repoPath));
    store.createEnvironment(p.id, "k8s", "kubernetes");
    store.setEnv({ projectId: p.id }, "API_TOKEN", "tok-very-secret", true);
    store.setEnv({ projectId: p.id }, "PUBLIC_NAME", "plain-visible", false);

    const triggerDeploy = vi.fn().mockImplementation(async (environmentId: string, _nbo: string, opts?: { progress?: (m: string) => void }) => {
      opts?.progress?.("build validated in 0.1s");
      opts?.progress?.("image built in 2.0s");
      opts?.progress?.("some chatter");
      return { id: "dep_1", environmentId, contentId: "sha256:x", status: "succeeded", url: "https://x", error: "", createdAt: "" };
    });
    const runner = createRunner(store, { triggerDeploy }, { artifacts });
    const build = store.createQueuedBuild(p.id, revision);
    await runner.runBuild(build.id);

    const b = store.getBuild(build.id);
    expect(b.status).toBe("succeeded");
    expect(b.commit).toMatchObject({ sha: revision, message: "Add the landing page", author: "Grace Hopper" });
    expect(b.commit!.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(b.log).toContain(`Commit ${revision.slice(0, 7)} Add the landing page`);
    expect(b.log).not.toContain("\x1f");
    expect(b.input).toMatchObject({ repo: repoPath, framework: "static", buildCommand: "mkdir dist && echo hi > dist/index.html", manual: false });
    expect(b.input!.variables).toEqual([
      { name: "API_TOKEN", secret: true },
      { name: "PUBLIC_NAME", secret: false },
    ]);
    expect(b.input!.envFingerprint).toMatch(/^[0-9a-f]{8,}/);
    expect(b.input!.envFingerprint).not.toContain("tok-very-secret");
    expect(b.input!.envFingerprint).not.toContain("plain-visible");
    expect(JSON.stringify(b)).not.toContain("tok-very-secret");
    expect(JSON.stringify(b.input)).not.toContain("plain-visible");

    expect(names(b.timeline)).toEqual([
      ["clone and checkout", "succeeded"],
      ["build command", "succeeded"],
      ["produce .nbo", "succeeded"],
      ["deploy k8s", "succeeded"],
    ]);
    expect(names(b.timeline![3]!.children)).toEqual([
      ["build validated", "succeeded"],
      ["image built", "succeeded"],
    ]);
    expect(b.timeline![3]!.children![1]!.durationMs).toBe(2000);
    // The log keeps its existing wording.
    expect(b.log).toMatch(/\] build command done in \d+\.\ds/);

    expect(b.outputSummary).toMatchObject({ framework: { name: "static" }, staticFiles: 1, functions: [] });
    expect(b.contentId).toMatch(/^sha256:/);
    expect(b.contentId).toBe(b.outputSummary!.contentId);
    expect(b.artifact).toBe(true);
    expect(artifacts.path(build.id)).toBe(join(artifactsDir, build.id));
    expect(existsSync(join(artifactsDir, build.id, "manifest.json"))).toBe(true);
  }, 30000);

  it("records the timeline up to a failing build command and keeps no output", async () => {
    const { store, artifacts, repoPath, revision } = await setup();
    const p = store.createProject("acme");
    store.setGitConfig(p.id, cfg(repoPath, { buildCommand: "exit 3" }));
    store.createEnvironment(p.id, "k8s", "kubernetes");
    const runner = createRunner(store, { triggerDeploy: vi.fn() }, { artifacts });
    const build = store.createQueuedBuild(p.id, revision);
    await runner.runBuild(build.id);

    const b = store.getBuild(build.id);
    expect(b.status).toBe("failed");
    expect(names(b.timeline)).toEqual([
      ["clone and checkout", "succeeded"],
      ["build command", "failed"],
    ]);
    expect(b.commit).toMatchObject({ sha: revision });
    expect(b.outputSummary).toBeNull();
    expect(b.artifact).toBe(false);
    expect(artifacts.path(build.id)).toBeNull();
  }, 30000);

  it("a failed deploy is recorded in the timeline with its sub-steps", async () => {
    const { store, artifacts, repoPath, revision } = await setup();
    const p = store.createProject("acme");
    store.setGitConfig(p.id, cfg(repoPath));
    store.createEnvironment(p.id, "k8s", "kubernetes");
    const triggerDeploy = vi.fn().mockImplementation(async (environmentId: string, _nbo: string, opts?: { progress?: (m: string) => void }) => {
      opts?.progress?.("image push failed after 1.5s");
      return { id: "dep_1", environmentId, contentId: "", status: "failed", url: "", error: "denied", createdAt: "" };
    });
    const runner = createRunner(store, { triggerDeploy }, { artifacts });
    const build = store.createQueuedBuild(p.id, revision);
    await runner.runBuild(build.id);
    const b = store.getBuild(build.id);
    expect(b.timeline![3]).toMatchObject({ name: "deploy k8s", status: "failed", children: [{ name: "image push", status: "failed", durationMs: 1500 }] });
  }, 30000);

  it("prunes old artifacts after each build but keeps the one still live", async () => {
    const { store, artifacts, repoPath, revision } = await setup();
    const p = store.createProject("acme");
    store.setGitConfig(p.id, cfg(repoPath));
    const env = store.createEnvironment(p.id, "k8s", "kubernetes");
    let n = 0;
    const triggerDeploy = vi.fn().mockImplementation(async (environmentId: string) => {
      n++;
      const dep = store.createDeployment(environmentId);
      // Only the first build's deploy succeeds; later ones fail, so the first stays live.
      if (n === 1) store.completeDeployment(dep.id, "sha256:x", "https://x");
      else store.failDeployment(dep.id, "nope");
      return store.getDeployment(dep.id);
    });
    const runner = createRunner(store, { triggerDeploy }, { artifacts, keepBuilds: 0 });
    const first = store.createQueuedBuild(p.id, revision);
    await runner.runBuild(first.id);
    const second = store.createQueuedBuild(p.id, revision);
    await runner.runBuild(second.id);

    expect(env.id).toBeTruthy();
    expect(artifacts.path(first.id)).not.toBeNull();
    expect(store.getBuild(first.id).artifact).toBe(true);
    expect(artifacts.path(second.id)).toBeNull();
    expect(store.getBuild(second.id).artifact).toBe(false);
  }, 60000);

  it("a failing artifact save does not fail the build", async () => {
    const { store, artifacts, repoPath, revision } = await setup();
    const p = store.createProject("acme");
    store.setGitConfig(p.id, cfg(repoPath));
    store.createEnvironment(p.id, "k8s", "kubernetes");
    const failing = { ...artifacts, save: vi.fn().mockRejectedValue(new Error("disk full and more")) };
    const triggerDeploy = vi
      .fn()
      .mockImplementation(async (environmentId: string) => ({
        id: "dep_1",
        environmentId,
        contentId: "sha256:x",
        status: "succeeded",
        url: "https://x",
        error: "",
        createdAt: "",
      }));
    const runner = createRunner(store, { triggerDeploy }, { artifacts: failing });
    const build = store.createQueuedBuild(p.id, revision);
    await runner.runBuild(build.id);
    const b = store.getBuild(build.id);
    expect(b.status).toBe("succeeded");
    expect(b.artifact).toBe(false);
    expect(b.log).toContain("Keeping the build output failed: disk full and more");
  }, 30000);

  it("a failing details write for input or output summary does not fail the build", async () => {
    const { store, artifacts, repoPath, revision } = await setup();
    const p = store.createProject("acme");
    store.setGitConfig(p.id, cfg(repoPath));
    store.createEnvironment(p.id, "k8s", "kubernetes");
    const real = store.setBuildDetails.bind(store);
    const flaky = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "setBuildDetails") {
          return (id: string, patch: Parameters<Store["setBuildDetails"]>[1]) => {
            if (patch.input || patch.outputSummary) throw new Error("db locked");
            real(id, patch);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Store;
    const triggerDeploy = vi
      .fn()
      .mockImplementation(async (environmentId: string) => ({
        id: "dep_1",
        environmentId,
        contentId: "sha256:x",
        status: "succeeded",
        url: "https://x",
        error: "",
        createdAt: "",
      }));
    const runner = createRunner(flaky, { triggerDeploy }, { artifacts });
    const build = store.createQueuedBuild(p.id, revision);
    await runner.runBuild(build.id);
    const b = store.getBuild(build.id);
    expect(b.status).toBe("succeeded");
    expect(b.input).toBeNull();
    expect(b.log).toContain("Recording the build input failed: db locked");
    expect(b.log).toContain("Reading the build output failed: db locked");
  }, 30000);
});
