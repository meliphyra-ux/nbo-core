// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createStore, type Store } from "../store.js";
import type { GitConfig } from "../git.js";
import { createRunner } from "../runner.js";
import type { DeploymentTrigger } from "../handlers.js";

const openStores: Store[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  for (const s of openStores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed by the test itself — fine
    }
  }
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-runner-"));
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

// A real local git repo — git itself doesn't care where it's hosted,
// so this proves the real clone+checkout path with no GitHub needed.
async function makeTestRepo(): Promise<{ repoPath: string; revision: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "controlplane-runner-repo-"));
  scratchDirs.push(repoPath);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(repoPath, "package.json"), "{}");
  await mkdir(join(repoPath, "web"), { recursive: true });
  await writeFile(join(repoPath, "web", "package.json"), "{}");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  const revision = git("rev-parse", "HEAD").toString().trim();
  return { repoPath, revision };
}

function okDep(id: string) {
  return { id, environmentId: "e", contentId: "sha256:x", status: "succeeded", url: "https://x", error: "", createdAt: "" };
}

function fixtureGitConfig(overrides: Partial<GitConfig> = {}): GitConfig {
  return {
    repo: "placeholder",
    productionBranch: "main",
    framework: "static",
    buildCommand: "mkdir dist && echo hi > dist/index.html",
    outputDir: "dist",
    ...overrides,
  };
}

describe("createRunner", () => {
  it("clones, builds, produces, and deploys for real, recording a succeeded build", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath }));
    const env = store.createEnvironment(proj.id, "k8s", "kubernetes");

    // Reads the manifest from inside the mock itself, while nboDir is
    // still live — the real triggerDeploy's own deploy() call reads
    // it the same way, before ever returning; runBuild's own cleanup
    // removes the clone (nboDir included) right after triggerDeploy
    // resolves, so inspecting it afterward would always ENOENT.
    let manifestFramework: unknown;
    const triggerDeploy = vi.fn().mockImplementation(async (environmentId: string, nboDir: string) => {
      const manifestRaw = await readFile(join(nboDir, "manifest.json"), "utf8");
      manifestFramework = JSON.parse(manifestRaw).build.framework.name;
      return { id: "dep_fake", environmentId, contentId: "sha256:x", status: "succeeded", url: "https://x", error: "", createdAt: "" };
    });
    const trigger: DeploymentTrigger = { triggerDeploy };
    const runner = createRunner(store, trigger);

    await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);

    const builds = store.listBuilds(proj.id);
    expect(builds).toHaveLength(1);
    expect(builds[0]!.status).toBe("succeeded");
    expect(builds[0]!.deploymentId).toBe("dep_fake");

    expect(triggerDeploy).toHaveBeenCalledWith(env.id, expect.any(String), expect.objectContaining({ progress: expect.any(Function) }));
    expect(manifestFramework).toBe("static");
  }, 30000);

  // Final-review finding: triggerDeploy's own real implementation
  // (deploy.ts) does not throw on a deploy failure — it returns a
  // Deployment with status: "failed" (recordDeployFailure). The
  // runner must check that, not blindly record "succeeded" whenever
  // triggerDeploy's promise merely resolves.
  it("a deploy that resolves with status: failed is recorded as a failed build, not succeeded", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");

    const triggerDeploy = vi.fn().mockResolvedValue({ id: "dep_fake", environmentId: "e", contentId: "", status: "failed", url: "", error: "docker push denied", createdAt: "" });
    const runner = createRunner(store, { triggerDeploy });

    await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);

    const build = store.listBuilds(proj.id)[0]!;
    expect(build.status).toBe("failed");
    expect(build.error).toContain("docker push denied");
    expect(build.deploymentId).toBe("dep_fake");
  }, 30000);

  it("an ignored-build-step command that exits 0 skips the build and never deploys", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, ignoredBuildStepCommand: "exit 0" }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");

    const triggerDeploy = vi.fn();
    const runner = createRunner(store, { triggerDeploy });

    await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);

    const builds = store.listBuilds(proj.id);
    expect(builds[0]!.status).toBe("skipped");
    expect(triggerDeploy).not.toHaveBeenCalled();
  }, 30000);

  it("an ignored-build-step command that exits 1 proceeds to the real build", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, ignoredBuildStepCommand: "exit 1" }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");

    const triggerDeploy = vi.fn().mockResolvedValue({ id: "dep_fake", environmentId: "e", contentId: "c", status: "succeeded", url: "u", error: "", createdAt: "" });
    const runner = createRunner(store, { triggerDeploy });

    await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);

    expect(store.listBuilds(proj.id)[0]!.status).toBe("succeeded");
    expect(triggerDeploy).toHaveBeenCalledTimes(1);
  }, 30000);

  it("a build command that exits non-zero fails the build naming the exit code, and never deploys", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, buildCommand: "exit 7" }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");

    const triggerDeploy = vi.fn();
    const runner = createRunner(store, { triggerDeploy });

    await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);

    const build = store.listBuilds(proj.id)[0]!;
    expect(build.status).toBe("failed");
    expect(build.error).toContain("7");
    expect(triggerDeploy).not.toHaveBeenCalled();
  }, 30000);

  it("a static build whose command never creates outputDir fails naming the expected path", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, buildCommand: "exit 0", outputDir: "dist" }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");

    const triggerDeploy = vi.fn();
    const runner = createRunner(store, { triggerDeploy });

    await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);

    const build = store.listBuilds(proj.id)[0]!;
    expect(build.status).toBe("failed");
    expect(build.error).toContain("dist");
    expect(triggerDeploy).not.toHaveBeenCalled();
  }, 30000);

  // Final-review finding: framework: "nextjs" was never exercised by
  // any test (success or failure) — this plan's own Review Focus
  // item 5 explicitly named it.
  it("a nextjs build that never produces .nbo/ fails naming what was expected", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, framework: "nextjs", buildCommand: "exit 0" }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");

    const triggerDeploy = vi.fn();
    const runner = createRunner(store, { triggerDeploy });

    await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);

    const build = store.listBuilds(proj.id)[0]!;
    expect(build.status).toBe("failed");
    expect(build.error).toContain(".nbo");
    expect(triggerDeploy).not.toHaveBeenCalled();
  }, 30000);

  it("a nextjs build whose command produces a real .nbo/ deploys it directly, with no producer call", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const buildCommand = process.platform === "win32" ? "mkdir .nbo && echo {} > .nbo\\manifest.json" : "mkdir .nbo && echo {} > .nbo/manifest.json";
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, framework: "nextjs", buildCommand, outputDir: undefined }));
    const env = store.createEnvironment(proj.id, "k8s", "kubernetes");

    const triggerDeploy = vi.fn().mockResolvedValue({ id: "dep_fake", environmentId: env.id, contentId: "c", status: "succeeded", url: "u", error: "", createdAt: "" });
    const runner = createRunner(store, { triggerDeploy });

    await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);

    expect(store.listBuilds(proj.id)[0]!.status).toBe("succeeded");
    expect(triggerDeploy).toHaveBeenCalledWith(env.id, expect.stringContaining(".nbo"), expect.objectContaining({ progress: expect.any(Function) }));
  }, 30000);

  // Final-review finding: an outputDir of "." or a path escaping the
  // clone (e.g. "../..") would otherwise publish the whole clone —
  // .git/ (history, any secret ever committed) and node_modules
  // included — as the deployed static site. Defense in depth here,
  // even though webhooks.ts's own PUT validation (Task 3) also
  // rejects this at config time.
  it("rejects an outputDir that escapes the clone directory", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, outputDir: "../../../etc" }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");

    const triggerDeploy = vi.fn();
    const runner = createRunner(store, { triggerDeploy });

    await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);

    const build = store.listBuilds(proj.id)[0]!;
    expect(build.status).toBe("failed");
    expect(triggerDeploy).not.toHaveBeenCalled();
  }, 30000);

  it("a project with no environments fails the build saying so plainly", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath }));

    const triggerDeploy = vi.fn();
    const runner = createRunner(store, { triggerDeploy });

    await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);

    const build = store.listBuilds(proj.id)[0]!;
    expect(build.status).toBe("failed");
    expect(build.error).toContain("has no environments to deploy to");
    expect(triggerDeploy).not.toHaveBeenCalled();
  }, 30000);

  it("the build log captures the build command's output and each step's command line", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, buildCommand: "echo building-the-site && mkdir dist && echo hi > dist/index.html" }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    const runner = createRunner(store, { triggerDeploy: vi.fn().mockResolvedValue(okDep("dep_1")) });

    const build = store.createQueuedBuild(proj.id, revision);
    await runner.runBuild(build.id);

    const got = store.getBuild(build.id);
    expect(got.status).toBe("succeeded");
    expect(got.log).toContain("$ git clone");
    expect(got.log).toContain("$ echo building-the-site");
    expect(got.log).toMatch(/^building-the-site/m);
    expect(got.startedAt).not.toBe("");
    expect(got.finishedAt).not.toBe("");
  }, 30000);

  it("the build command sees NEXT_ADAPTER_PATH pointing at the workspace next-adapter", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const printEnv = process.platform === "win32" ? "echo ADAPTER=%NEXT_ADAPTER_PATH%" : "echo ADAPTER=$NEXT_ADAPTER_PATH";
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, buildCommand: `${printEnv} && mkdir dist && echo hi > dist/index.html` }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    const runner = createRunner(store, { triggerDeploy: vi.fn().mockResolvedValue(okDep("dep_1")) });

    const build = store.createQueuedBuild(proj.id, revision);
    await runner.runBuild(build.id);

    const log = store.getBuild(build.id).log;
    expect(log).toMatch(/^ADAPTER=.*next-adapter.*adapter\.js/m);
  }, 30000);

  it("fan-out deploys to every environment and records each deployment id", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath }));
    const k8s = store.createEnvironment(proj.id, "k8s", "kubernetes");
    const cr = store.createEnvironment(proj.id, "cloudrun", "cloudrun");
    const triggerDeploy = vi.fn().mockImplementation(async (envId: string) => okDep(`dep_${envId}`));
    const deployed: string[] = [];
    const runner = createRunner(store, { triggerDeploy }, { onDeployed: async (_p, envId) => void deployed.push(envId) });

    const build = store.createQueuedBuild(proj.id, revision);
    await runner.runBuild(build.id);

    const got = store.getBuild(build.id);
    expect(got.status).toBe("succeeded");
    expect(got.deploymentIds).toEqual([`dep_${k8s.id}`, `dep_${cr.id}`]);
    expect(triggerDeploy.mock.calls.map((c) => c[0])).toEqual([k8s.id, cr.id]);
    expect(deployed).toEqual([k8s.id, cr.id]);
    // Each deployment is told which build it runs.
    expect(triggerDeploy.mock.calls.map((c) => c[2]?.buildId)).toEqual([build.id, build.id]);
  }, 30000);

  it("fan-out where one environment fails marks the build failed and records both deployments", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath }));
    const k8s = store.createEnvironment(proj.id, "k8s", "kubernetes");
    const cr = store.createEnvironment(proj.id, "cloudrun", "cloudrun");
    const triggerDeploy = vi
      .fn()
      .mockImplementation(async (envId: string) => (envId === cr.id ? { ...okDep("dep_cr"), status: "failed", error: "docker push denied" } : okDep("dep_k8s")));
    const deployed: string[] = [];
    const runner = createRunner(store, { triggerDeploy }, { onDeployed: async (_p, envId) => void deployed.push(envId) });

    const build = store.createQueuedBuild(proj.id, revision);
    await runner.runBuild(build.id);

    const got = store.getBuild(build.id);
    expect(got.status).toBe("failed");
    expect(got.deploymentIds).toEqual(["dep_k8s", "dep_cr"]);
    expect(got.error).toBe("cloudrun: docker push denied");
    expect(deployed).toEqual([k8s.id]);
  }, 30000);

  it("archived environments are not deployed to", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath }));
    const k8s = store.createEnvironment(proj.id, "k8s", "kubernetes");
    const cr = store.createEnvironment(proj.id, "cloudrun", "cloudrun");
    store.archiveEnvironment(cr.id);
    const triggerDeploy = vi.fn().mockResolvedValue(okDep("dep_k8s"));
    const runner = createRunner(store, { triggerDeploy });

    await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);

    expect(triggerDeploy.mock.calls.map((c) => c[0])).toEqual([k8s.id]);
  }, 30000);

  it("an onDeployed hook that throws is logged, not a failed build", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    const runner = createRunner(
      store,
      { triggerDeploy: vi.fn().mockResolvedValue(okDep("dep_k8s")) },
      {
        onDeployed: async () => {
          throw new Error("edge down");
        },
      },
    );

    const build = store.createQueuedBuild(proj.id, revision);
    await runner.runBuild(build.id);

    const got = store.getBuild(build.id);
    expect(got.status).toBe("succeeded");
    expect(got.log).toContain("edge down");
  }, 30000);

  it("a nextjs app in a subfolder builds there and deploys its .nbo/ when rootDirectory is set", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const buildCommand = process.platform === "win32" ? "mkdir .nbo && echo {} > .nbo\\manifest.json" : "mkdir .nbo && echo {} > .nbo/manifest.json";
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, framework: "nextjs", buildCommand, outputDir: undefined, rootDirectory: "web" }));
    const env = store.createEnvironment(proj.id, "k8s", "kubernetes");
    let deployedDir = "";
    const triggerDeploy = vi.fn().mockImplementation(async (_envId: string, nboDir: string) => {
      deployedDir = nboDir;
      await readFile(join(nboDir, "manifest.json"), "utf8");
      return okDep("dep_1");
    });
    const runner = createRunner(store, { triggerDeploy });

    const build = store.createQueuedBuild(proj.id, revision);
    await runner.runBuild(build.id);

    expect(store.getBuild(build.id).status).toBe("succeeded");
    expect(triggerDeploy).toHaveBeenCalledWith(env.id, expect.any(String), expect.objectContaining({ progress: expect.any(Function) }));
    expect(deployedDir).toMatch(/[\\/]web[\\/]\.nbo$/);
  }, 30000);

  it("a static app's outputDir is relative to rootDirectory", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, rootDirectory: "web", buildCommand: "mkdir dist && echo hi > dist/index.html", outputDir: "dist" }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    const runner = createRunner(store, { triggerDeploy: vi.fn().mockResolvedValue(okDep("dep_1")) });

    const build = store.createQueuedBuild(proj.id, revision);
    await runner.runBuild(build.id);

    expect(store.getBuild(build.id).status).toBe("succeeded");
  }, 30000);

  it("a nextjs build whose .nbo/ landed in a subfolder says which Root Directory to set", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const buildCommand = process.platform === "win32" ? "cd web && mkdir .nbo && echo {} > .nbo\\manifest.json" : "cd web && mkdir .nbo && echo {} > .nbo/manifest.json";
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, framework: "nextjs", buildCommand, outputDir: undefined }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    const triggerDeploy = vi.fn();
    const runner = createRunner(store, { triggerDeploy });

    const build = store.createQueuedBuild(proj.id, revision);
    await runner.runBuild(build.id);

    const got = store.getBuild(build.id);
    expect(got.status).toBe("failed");
    expect(got.error).toContain('found web/.nbo — set Root Directory to "web"');
    expect(triggerDeploy).not.toHaveBeenCalled();
  }, 30000);

  it("a rootDirectory that doesn't exist in the repository fails saying so", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, rootDirectory: "nope" }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    const runner = createRunner(store, { triggerDeploy: vi.fn() });
    const build = store.createQueuedBuild(proj.id, revision);
    await runner.runBuild(build.id);
    expect(store.getBuild(build.id)).toMatchObject({ status: "failed", error: 'Root Directory "nope" does not exist in the repository' });
  }, 30000);

  describe("parallel environments", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    async function twoEnvProject() {
      const { repoPath, revision } = await makeTestRepo();
      const store = await openTestStore();
      const proj = store.createProject("acme");
      store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath }));
      const k8s = store.createEnvironment(proj.id, "k8s", "kubernetes");
      const cr = store.createEnvironment(proj.id, "cloudrun", "cloudrun");
      return { store, proj, k8s, cr, revision };
    }

    it("deploys every environment concurrently, keeping deployment ids in environment order", async () => {
      const { store, proj, k8s, cr, revision } = await twoEnvProject();
      let inFlight = 0;
      let max = 0;
      // Both deploys wait until both have started (a sequential runner
      // would never get there), and the first environment finishes last —
      // forced with promises, not timers, so load can't reorder it.
      let bothStarted!: () => void;
      const started = new Promise<void>((r) => (bothStarted = r));
      let crFinished!: () => void;
      const crDone = new Promise<void>((r) => (crFinished = r));
      const triggerDeploy = vi.fn().mockImplementation(async (envId: string) => {
        inFlight++;
        max = Math.max(max, inFlight);
        if (inFlight === 2) bothStarted();
        await started;
        if (envId === k8s.id) await crDone;
        inFlight--;
        if (envId === cr.id) crFinished();
        return okDep(`dep_${envId}`);
      });
      const runner = createRunner(store, { triggerDeploy }, { holdSharedWork: () => ({ release: async () => {} }) });
      const build = store.createQueuedBuild(proj.id, revision);
      await runner.runBuild(build.id);

      expect(max).toBe(2);
      const got = store.getBuild(build.id);
      expect(got.status).toBe("succeeded");
      expect(got.deploymentIds).toEqual([`dep_${k8s.id}`, `dep_${cr.id}`]);
    }, 30000);

    it("aggregates a rejected and a failed environment in environment order", async () => {
      const { store, proj, k8s, revision } = await twoEnvProject();
      const triggerDeploy = vi.fn().mockImplementation(async (envId: string) => {
        if (envId === k8s.id) {
          await sleep(30);
          throw new Error("kubectl exploded");
        }
        return { ...okDep("dep_cr"), status: "failed", error: "docker push denied" };
      });
      const runner = createRunner(store, { triggerDeploy }, { holdSharedWork: () => ({ release: async () => {} }) });
      const build = store.createQueuedBuild(proj.id, revision);
      await runner.runBuild(build.id);

      const got = store.getBuild(build.id);
      expect(got.status).toBe("failed");
      expect(got.deploymentIds).toEqual(["dep_cr"]);
      expect(got.error).toBe("k8s: kubectl exploded; cloudrun: docker push denied");
    }, 30000);

    it("runs onDeployed per environment, one at a time", async () => {
      const { store, proj, k8s, cr, revision } = await twoEnvProject();
      let inEdge = 0;
      let maxEdge = 0;
      const deployed: string[] = [];
      const runner = createRunner(
        store,
        { triggerDeploy: vi.fn().mockImplementation(async (envId: string) => okDep(`dep_${envId}`)) },
        {
          holdSharedWork: () => ({ release: async () => {} }),
          onDeployed: async (_p, envId) => {
            inEdge++;
            maxEdge = Math.max(maxEdge, inEdge);
            await sleep(20);
            inEdge--;
            deployed.push(envId);
          },
        },
      );
      await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);
      expect(maxEdge).toBe(1);
      expect(deployed.sort()).toEqual([k8s.id, cr.id].sort());
    }, 30000);

    // Mirrors edge-sync's onDeployed: the first successful deploy of a
    // project (every weight still 0) takes 100% of the traffic.
    function edgeLike(store: Store, calls: string[]) {
      return async (projectId: string, envId: string) => {
        calls.push(envId);
        if (store.listEnvironments(projectId).every((e) => e.trafficWeight === 0)) store.setTrafficWeights(projectId, { [envId]: 100 });
      };
    }
    const weights = (store: Store, projectId: string) => Object.fromEntries(store.listEnvironments(projectId).map((e) => [e.name, e.trafficWeight]));

    it("first deploy: 100% goes to the first environment in order even when the second finishes first", async () => {
      const { store, proj, k8s, cr, revision } = await twoEnvProject();
      const calls: string[] = [];
      const triggerDeploy = vi.fn().mockImplementation(async (envId: string) => {
        await sleep(envId === k8s.id ? 60 : 5);
        return okDep(`dep_${envId}`);
      });
      const runner = createRunner(store, { triggerDeploy }, { holdSharedWork: () => ({ release: async () => {} }), onDeployed: edgeLike(store, calls) });
      await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);
      expect(weights(store, proj.id)).toEqual({ k8s: 100, cloudrun: 0 });
      expect(calls).toEqual([k8s.id, cr.id]);
    }, 30000);

    it("first deploy: when the first environment fails, 100% goes to the first one that succeeded", async () => {
      const { store, proj, k8s, cr, revision } = await twoEnvProject();
      const calls: string[] = [];
      const triggerDeploy = vi.fn().mockImplementation(async (envId: string) => {
        await sleep(envId === k8s.id ? 30 : 5);
        return envId === k8s.id ? { ...okDep("dep_k8s"), status: "failed", error: "nope" } : okDep("dep_cr");
      });
      const runner = createRunner(store, { triggerDeploy }, { holdSharedWork: () => ({ release: async () => {} }), onDeployed: edgeLike(store, calls) });
      await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);
      expect(weights(store, proj.id)).toEqual({ k8s: 0, cloudrun: 100 });
      expect(calls).toEqual([cr.id]);
    }, 30000);

    it("later deploys update the edge as each environment finishes", async () => {
      const { store, proj, k8s, cr, revision } = await twoEnvProject();
      store.setTrafficWeights(proj.id, { [k8s.id]: 100 });
      const calls: string[] = [];
      // k8s finishes only after Cloud Run's edge update has happened: the
      // order is forced, not left to timers (which raced under load).
      let crEdgeUpdated!: () => void;
      const crUpdated = new Promise<void>((r) => (crEdgeUpdated = r));
      const edge = edgeLike(store, calls);
      const onDeployed = async (projectId: string, envId: string) => {
        await edge(projectId, envId);
        if (envId === cr.id) crEdgeUpdated();
      };
      const triggerDeploy = vi.fn().mockImplementation(async (envId: string) => {
        if (envId === k8s.id) await crUpdated;
        return okDep(`dep_${envId}`);
      });
      const runner = createRunner(store, { triggerDeploy }, { holdSharedWork: () => ({ release: async () => {} }), onDeployed });
      await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);
      expect(calls).toEqual([cr.id, k8s.id]);
      expect(weights(store, proj.id)).toEqual({ k8s: 100, cloudrun: 0 });
    }, 30000);

    it("holds the build's shared deploy work across every environment and releases it once all finish", async () => {
      const { store, proj, k8s, revision } = await twoEnvProject();
      const events: string[] = [];
      const holdSharedWork = vi.fn().mockImplementation((nboDir: string) => {
        events.push(`hold ${nboDir.endsWith(".nbo") ? ".nbo" : nboDir}`);
        return { release: async () => void events.push("release") };
      });
      // k8s finishes only after Cloud Run has (forced order, no timers).
      let crFinished!: () => void;
      const crDone = new Promise<void>((r) => (crFinished = r));
      const triggerDeploy = vi.fn().mockImplementation(async (envId: string) => {
        if (envId === k8s.id) await crDone;
        events.push(`done ${envId === k8s.id ? "k8s" : "cloudrun"}`);
        if (envId !== k8s.id) crFinished();
        return okDep(`dep_${envId}`);
      });
      const runner = createRunner(store, { triggerDeploy }, { holdSharedWork });
      await runner.runBuild(store.createQueuedBuild(proj.id, revision).id);
      expect(events).toEqual(["hold .nbo", "done cloudrun", "done k8s", "release"]);
    }, 30000);
  });

  describe("step timings", () => {
    it("logs a [mm:ss] done-in line for every phase, and forwards per-environment deploy progress", async () => {
      const { repoPath, revision } = await makeTestRepo();
      const store = await openTestStore();
      const proj = store.createProject("acme");
      store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, ignoredBuildStepCommand: "exit 1" }));
      store.createEnvironment(proj.id, "cloudrun", "kubernetes");
      // 1s per call: each phase takes some whole number of seconds.
      let t = 0;
      const triggerDeploy = vi.fn().mockImplementation(async (_id: string, _dir: string, o?: { progress?: (m: string) => void }) => {
        o?.progress?.("function ssr: image built in 34.1s");
        return okDep("dep_1");
      });
      const runner = createRunner(store, { triggerDeploy }, { now: () => (t += 1000) });
      const build = store.createQueuedBuild(proj.id, revision);
      await runner.runBuild(build.id);

      const log = store.getBuild(build.id).log;
      const lines = log.split("\n");
      const timing = (phase: string) => new RegExp(`^\\[\\d\\d:\\d\\d\\] ${phase} done in \\d+\\.\\ds$`);
      for (const phase of ["clone and checkout", "ignored build step", "build command", "produce \\.nbo", "deploy cloudrun"]) {
        expect(
          lines.some((l) => timing(phase).test(l)),
          `${phase} in:\n${log}`,
        ).toBe(true);
      }
      expect(lines).toContainEqual(expect.stringMatching(/^\[\d\d:\d\d\] cloudrun: function ssr: image built in 34\.1s$/));
      for (const l of lines.filter((l) => /^\[\d\d:\d\d\]/.test(l))) expect(l).toMatch(/^[\x20-\x7e]*$/);
      // Phases appear in execution order.
      const idx = (phase: string) => lines.findIndex((l) => timing(phase).test(l));
      expect(idx("clone and checkout")).toBeLessThan(idx("ignored build step"));
      expect(idx("ignored build step")).toBeLessThan(idx("build command"));
      expect(idx("build command")).toBeLessThan(idx("produce \\.nbo"));
      expect(idx("produce \\.nbo")).toBeLessThan(idx("deploy cloudrun"));
    }, 30000);

    it("measures elapsed time from the build start with an injected clock", async () => {
      const { repoPath, revision } = await makeTestRepo();
      const store = await openTestStore();
      const proj = store.createProject("acme");
      store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath }));
      store.createEnvironment(proj.id, "k8s", "kubernetes");
      // Frozen clock: everything is at 00:00 and takes 0.0s.
      const triggerDeploy = vi.fn().mockResolvedValue(okDep("dep_1"));
      const runner = createRunner(store, { triggerDeploy }, { now: () => 5000 });
      const build = store.createQueuedBuild(proj.id, revision);
      await runner.runBuild(build.id);
      expect(store.getBuild(build.id).log).toContain("[00:00] build command done in 0.0s\n");
    }, 30000);

    it("stamps minutes and seconds since the build start with a stepping clock", async () => {
      const { repoPath, revision } = await makeTestRepo();
      const store = await openTestStore();
      const proj = store.createProject("acme");
      store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath }));
      store.createEnvironment(proj.id, "k8s", "kubernetes");
      let t = 1_000_000;
      const triggerDeploy = vi.fn().mockImplementation(async (_id: string, _dir: string, o?: { progress?: (m: string) => void }) => {
        t += 65_000; // the deploy takes 65s, so minute rollover shows
        o?.progress?.("app: image pushed in 12.0s");
        return okDep("dep_1");
      });
      const runner = createRunner(store, { triggerDeploy }, { now: () => t });
      const build = store.createQueuedBuild(proj.id, revision);
      await runner.runBuild(build.id);
      const log = store.getBuild(build.id).log;
      expect(log).toContain("[00:00] build command done in 0.0s\n");
      expect(log).toContain("[01:05] k8s: app: image pushed in 12.0s\n");
      expect(log).toContain("[01:05] deploy k8s done in 65.0s\n");
    }, 30000);

    it("logs failed-after for a failing phase", async () => {
      const { repoPath, revision } = await makeTestRepo();
      const store = await openTestStore();
      const proj = store.createProject("acme");
      store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath, buildCommand: "exit 3" }));
      store.createEnvironment(proj.id, "k8s", "kubernetes");
      const runner = createRunner(store, { triggerDeploy: vi.fn() }, { now: () => 0 });
      const build = store.createQueuedBuild(proj.id, revision);
      await runner.runBuild(build.id);
      expect(store.getBuild(build.id).log).toContain("[00:00] build command failed after 0.0s\n");
    }, 30000);

    it("logs a deploy that resolves failed as failed after", async () => {
      const { repoPath, revision } = await makeTestRepo();
      const store = await openTestStore();
      const proj = store.createProject("acme");
      store.setGitConfig(proj.id, fixtureGitConfig({ repo: repoPath }));
      store.createEnvironment(proj.id, "k8s", "kubernetes");
      const triggerDeploy = vi.fn().mockResolvedValue({ ...okDep("d"), status: "failed", error: "nope" });
      const runner = createRunner(store, { triggerDeploy }, { now: () => 0 });
      const build = store.createQueuedBuild(proj.id, revision);
      await runner.runBuild(build.id);
      expect(store.getBuild(build.id).log).toContain("[00:00] deploy k8s failed after 0.0s\n");
    }, 30000);
  });
});
