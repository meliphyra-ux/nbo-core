// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createStore, type Store } from "../store.js";
import type { GitConfig } from "../git.js";
import { createRunner } from "../runner.js";
import { validateEnvName } from "../env-vars.js";

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

async function openStore(keyed: boolean): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-runner-env-"));
  scratchDirs.push(dir);
  const s = createStore(join(dir, "test.db"), keyed ? { secretKey: randomBytes(32) } : undefined);
  openStores.push(s);
  return s;
}

async function makeTestRepo(): Promise<{ repoPath: string; revision: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "controlplane-runner-env-repo-"));
  scratchDirs.push(repoPath);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(repoPath, "package.json"), "{}");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  return { repoPath, revision: git("rev-parse", "HEAD").toString().trim() };
}

function okDep(id: string) {
  return { id, environmentId: "e", contentId: "sha256:x", status: "succeeded", url: "https://x", error: "", createdAt: "" };
}

function cfg(overrides: Partial<GitConfig> = {}): GitConfig {
  return { repo: "placeholder", productionBranch: "main", framework: "static", buildCommand: "mkdir dist && echo hi > dist/index.html", outputDir: "dist", ...overrides };
}

const printVar = (name: string) => (process.platform === "win32" ? `echo VAL_${name}=%${name}%` : `echo VAL_${name}=$${name}`);

describe("runner environment variables", () => {
  it("the build command receives project variables; NBO's NEXT_ADAPTER_PATH wins", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openStore(true);
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, cfg({ repo: repoPath, buildCommand: `${printVar("API_URL")} && ${printVar("NEXT_ADAPTER_PATH")} && mkdir dist && echo hi > dist/index.html` }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    store.setEnv({ projectId: proj.id }, "API_URL", "https://api.example.com", false);
    const runner = createRunner(store, { triggerDeploy: vi.fn().mockResolvedValue(okDep("dep_1")) }, { nextAdapterPath: "/adapter/path.js" });

    const build = store.createQueuedBuild(proj.id, revision);
    await runner.runBuild(build.id);

    const log = store.getBuild(build.id).log;
    expect(log).toMatch(/^VAL_API_URL=https:\/\/api\.example\.com/m);
    expect(log).toMatch(/^VAL_NEXT_ADAPTER_PATH=\/adapter\/path\.js/m);
  }, 30000);

  it("NEXT_ADAPTER_PATH is a reserved variable name", () => {
    expect(validateEnvName("NEXT_ADAPTER_PATH")).toMatch(/reserved/);
  });

  it("secret values printed by the build never reach the log; plain ones do", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openStore(true);
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, cfg({ repo: repoPath, buildCommand: `${printVar("TOKEN")} && ${printVar("PUBLIC_NAME")} && mkdir dist && echo hi > dist/index.html` }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    store.setEnv({ projectId: proj.id }, "TOKEN", "s3cr3t-value-123", true);
    store.setEnv({ projectId: proj.id }, "PUBLIC_NAME", "plain-value", false);
    const runner = createRunner(store, { triggerDeploy: vi.fn().mockResolvedValue(okDep("dep_1")) });

    const build = store.createQueuedBuild(proj.id, revision);
    await runner.runBuild(build.id);

    const log = store.getBuild(build.id).log;
    expect(log).not.toContain("s3cr3t-value-123");
    expect(log).toContain("VAL_TOKEN=[redacted]");
    expect(log).toContain("VAL_PUBLIC_NAME=plain-value");
  }, 30000);

  it("a failing build with a secret in its error output keeps it out of the build error", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openStore(true);
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, cfg({ repo: repoPath, buildCommand: "exit 3" }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    store.setEnv({ projectId: proj.id }, "TOKEN", "s3cr3t-value-123", true);
    const trigger = vi.fn().mockRejectedValue(new Error("boom s3cr3t-value-123"));
    const build = store.createQueuedBuild(proj.id, revision);
    await createRunner(store, { triggerDeploy: trigger }).runBuild(build.id);
    const got = store.getBuild(build.id);
    expect(got.status).toBe("failed");
    expect(got.error).not.toContain("s3cr3t-value-123");
    expect(got.log).not.toContain("s3cr3t-value-123");
  }, 30000);

  it("a manual build skips the ignored build step; a normal one is skipped by it", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openStore(false);
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, cfg({ repo: repoPath, ignoredBuildStepCommand: "exit 0" }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    const triggerDeploy = vi.fn().mockResolvedValue(okDep("dep_1"));
    const runner = createRunner(store, { triggerDeploy });

    const normal = store.createQueuedBuild(proj.id, revision);
    expect(normal.manual).toBe(false);
    await runner.runBuild(normal.id);
    expect(store.getBuild(normal.id).status).toBe("skipped");
    expect(triggerDeploy).not.toHaveBeenCalled();

    const manual = store.createQueuedBuild(proj.id, revision, { manual: true });
    expect(store.getBuild(manual.id).manual).toBe(true);
    await runner.runBuild(manual.id);
    expect(store.getBuild(manual.id).status).toBe("succeeded");
    expect(store.getBuild(manual.id).log).not.toContain("$ exit 0");
    expect(triggerDeploy).toHaveBeenCalledTimes(1);
  }, 30000);

  it("every environment receives the identical snapshot and fingerprint", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openStore(true);
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, cfg({ repo: repoPath }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    store.createEnvironment(proj.id, "cr", "cloudrun");
    store.setEnv({ projectId: proj.id }, "TOKEN", "abc", true);
    store.setEnv({ projectId: proj.id }, "MODE", "prod", false);
    const triggerDeploy = vi.fn().mockResolvedValue(okDep("dep_1"));

    await createRunner(store, { triggerDeploy }).runBuild(store.createQueuedBuild(proj.id, revision).id);

    expect(triggerDeploy).toHaveBeenCalledTimes(2);
    const optsOf = (i: number) => triggerDeploy.mock.calls[i]![2] as { env: unknown; fingerprint: unknown; progress: unknown };
    expect(optsOf(0).env).toEqual({ vars: { MODE: "prod", TOKEN: "abc" }, secretNames: ["TOKEN"] });
    expect(optsOf(0).fingerprint).toEqual(expect.any(String));
    expect(optsOf(1).env).toEqual(optsOf(0).env);
    expect(optsOf(1).fingerprint).toBe(optsOf(0).fingerprint);
    expect(optsOf(0).progress).toEqual(expect.any(Function));
  }, 30000);

  it("a project without variables passes an empty snapshot and a null fingerprint", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openStore(false);
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, cfg({ repo: repoPath }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    const triggerDeploy = vi.fn().mockResolvedValue(okDep("dep_1"));
    await createRunner(store, { triggerDeploy }).runBuild(store.createQueuedBuild(proj.id, revision).id);
    const opts = triggerDeploy.mock.calls[0]![2] as { env: unknown; fingerprint: unknown };
    expect(opts.env).toEqual({ vars: {}, secretNames: [] });
    expect(opts.fingerprint).toBeNull();
  }, 30000);
});

describe("streaming redaction", () => {
  // Writes $TOKEN in two stdout writes (split in the middle) with a gap between.
  const nodeScript = async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-split-"));
    scratchDirs.push(dir);
    const file = join(dir, "split.js");
    await writeFile(
      file,
      "const s=process.env.TOKEN;const h=Math.floor(s.length/2);process.stdout.write('pre '+s.slice(0,h));setTimeout(()=>process.stdout.write(s.slice(h)+' post\\n'),150);",
    );
    return `node "${file}"`;
  };

  async function buildWith(secret: string, buildCommand: string) {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openStore(true);
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, cfg({ repo: repoPath, buildCommand: `${buildCommand} && mkdir dist && echo hi > dist/index.html` }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    store.setEnv({ projectId: proj.id }, "TOKEN", secret, true);
    const build = store.createQueuedBuild(proj.id, revision);
    await createRunner(store, { triggerDeploy: vi.fn().mockResolvedValue(okDep("dep_1")) }).runBuild(build.id);
    return store.getBuild(build.id);
  }

  it("redacts a secret split across two output chunks", async () => {
    const got = await buildWith("split-secret-value-98765", await nodeScript());
    expect(got.status).toBe("succeeded");
    expect(got.log).not.toContain("split-secret-value-98765");
    expect(got.log).not.toContain("split-secret");
    expect(got.log).toContain("pre [redacted] post");
  }, 30000);

  it("redacts a secret with multibyte characters split next to a chunk boundary", async () => {
    const secret = "tökén-日本語-secret";
    const got = await buildWith(secret, await nodeScript());
    expect(got.log).not.toContain(secret);
    expect(got.log).not.toContain("日本語");
    expect(got.log).toContain("pre [redacted] post");
  }, 30000);

  it("leaves ordinary output without secrets byte-identical", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openStore(false);
    const proj = store.createProject("acme");
    const dir = await mkdtemp(join(tmpdir(), "controlplane-plain-"));
    scratchDirs.push(dir);
    const file = join(dir, "plain.js");
    await writeFile(file, "process.stdout.write('h\\u00e9llo \\u65e5\\u672c\\u8a9e ');setTimeout(()=>process.stdout.write('world\\n'),100);");
    store.setGitConfig(proj.id, cfg({ repo: repoPath, buildCommand: `node "${file}" && mkdir dist && echo hi > dist/index.html` }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    const build = store.createQueuedBuild(proj.id, revision);
    await createRunner(store, { triggerDeploy: vi.fn().mockResolvedValue(okDep("dep_1")) }).runBuild(build.id);
    expect(store.getBuild(build.id).log).toContain("héllo 日本語 world\n");
  }, 30000);
});

describe("runner when variables cannot be resolved", () => {
  it("fails readably, never deploys and never clones when sealed secrets have no key", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const dir = await mkdtemp(join(tmpdir(), "controlplane-runner-env-nokey-"));
    scratchDirs.push(dir);
    const dbPath = join(dir, "test.db");
    const keyed = createStore(dbPath, { secretKey: randomBytes(32) });
    const proj = keyed.createProject("acme");
    keyed.setGitConfig(proj.id, cfg({ repo: repoPath }));
    keyed.createEnvironment(proj.id, "k8s", "kubernetes");
    keyed.setEnv({ projectId: proj.id }, "TOKEN", "never-show-this-value", true);
    const queued = keyed.createQueuedBuild(proj.id, revision);
    // Simulate the key being unavailable: a store whose env methods cannot decrypt.
    const store = Object.assign(keyed, {
      resolveEnv() {
        throw new Error("no secret key loaded");
      },
    });
    openStores.push(keyed);
    const triggerDeploy = vi.fn();
    await createRunner(store, { triggerDeploy }).runBuild(queued.id);

    const got = store.getBuild(queued.id);
    expect(got.status).toBe("failed");
    expect(got.error).toMatch(/no secret key loaded/);
    expect(got.error + got.log).not.toContain("never-show-this-value");
    expect(triggerDeploy).not.toHaveBeenCalled();
    expect(got.log).not.toContain("$ git clone");
  }, 30000);
});

describe("builds per stage", () => {
  const printAs = (prefix: string, name: string) => (process.platform === "win32" ? `echo ${prefix}_${name}=%${name}%` : `echo ${prefix}_${name}=$${name}`);
  const printAll = (prefix: string) => ["NBO_ENV", "NBO_GIT_COMMIT_REF", "NBO_GIT_COMMIT_SHA", "API_URL"].map((n) => printAs(prefix, n)).join(" && ");

  it("a staging build resolves staging variables, deploys only to staging clouds with auto-deploy on, and tells the build which stage it is", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openStore(true);
    const proj = store.createProject("acme");
    store.setGitConfig(
      proj.id,
      cfg({ repo: repoPath, ignoredBuildStepCommand: `${printAll("IGN")} && exit 1`, buildCommand: `${printAll("BUILD")} && mkdir dist && echo hi > dist/index.html` }),
    );
    const staging = store.createStage(proj.id, { name: "staging", branch: "stage-branch", host: "" });
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    const stagingK8s = store.createEnvironment(proj.id, "s-staging-k8s", "kubernetes", undefined, staging.id);
    const stagingCr = store.createEnvironment(proj.id, "s-staging-cr", "cloudrun", undefined, staging.id);
    store.setEnvironmentAutoDeploy(stagingCr.id, false);
    store.setEnv({ projectId: proj.id }, "API_URL", "https://prod.example.com", false);
    store.setEnv({ projectId: proj.id }, "API_URL", "https://staging.example.com", false, "staging");
    const triggerDeploy = vi.fn().mockResolvedValue(okDep("dep_1"));

    const build = store.createQueuedBuild(proj.id, revision, { stageId: staging.id });
    await createRunner(store, { triggerDeploy }).runBuild(build.id);

    const got = store.getBuild(build.id);
    expect(got.status).toBe("succeeded");
    for (const prefix of ["IGN", "BUILD"]) {
      expect(got.log).toMatch(new RegExp(`^${prefix}_NBO_ENV=staging`, "m"));
      expect(got.log).toMatch(new RegExp(`^${prefix}_NBO_GIT_COMMIT_REF=stage-branch`, "m"));
      expect(got.log).toMatch(new RegExp(`^${prefix}_NBO_GIT_COMMIT_SHA=${revision}`, "m"));
    }
    expect(got.log).toMatch(/^BUILD_API_URL=https:\/\/staging\.example\.com/m);
    expect(triggerDeploy).toHaveBeenCalledTimes(1);
    expect(triggerDeploy.mock.calls[0]![0]).toBe(stagingK8s.id);
    expect((triggerDeploy.mock.calls[0]![2] as { env: { vars: Record<string, string> } }).env.vars).toEqual({ API_URL: "https://staging.example.com" });
  }, 30000);

  it("a staging build redacts staging secrets from its log", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openStore(true);
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, cfg({ repo: repoPath, buildCommand: `${printVar("TOKEN")} && mkdir dist && echo hi > dist/index.html` }));
    const staging = store.createStage(proj.id, { name: "staging", branch: "stage-branch", host: "" });
    store.createEnvironment(proj.id, "s-staging-k8s", "kubernetes", undefined, staging.id);
    store.setEnv({ projectId: proj.id }, "TOKEN", "staging-secret-4567", true, "staging");
    const build = store.createQueuedBuild(proj.id, revision, { stageId: staging.id });
    await createRunner(store, { triggerDeploy: vi.fn().mockResolvedValue(okDep("dep_1")) }).runBuild(build.id);
    const log = store.getBuild(build.id).log;
    expect(log).toContain("VAL_TOKEN=[redacted]");
    expect(log).not.toContain("staging-secret-4567");
  }, 30000);

  it("a Production build gets NBO_ENV=production and the production branch", async () => {
    const { repoPath, revision } = await makeTestRepo();
    const store = await openStore(false);
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, cfg({ repo: repoPath, buildCommand: `${printAll("BUILD")} && mkdir dist && echo hi > dist/index.html` }));
    store.createEnvironment(proj.id, "k8s", "kubernetes");
    const build = store.createQueuedBuild(proj.id, revision);
    await createRunner(store, { triggerDeploy: vi.fn().mockResolvedValue(okDep("dep_1")) }).runBuild(build.id);
    const log = store.getBuild(build.id).log;
    expect(log).toMatch(/^BUILD_NBO_ENV=production/m);
    expect(log).toMatch(/^BUILD_NBO_GIT_COMMIT_REF=main/m);
    expect(log).toMatch(new RegExp(`^BUILD_NBO_GIT_COMMIT_SHA=${revision}`, "m"));
  }, 30000);
});
