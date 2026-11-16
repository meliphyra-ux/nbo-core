// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, ErrNotFound, ErrDuplicateName, ErrInvalidEnvironmentConfig, type Store } from "../store.js";

const openStores: Store[] = [];

afterEach(() => {
  for (const s of openStores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed by the test itself — fine
    }
  }
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-store-"));
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

describe("createProject / getProject", () => {
  it("creates and gets a project", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    expect(p.id).not.toBe("");
    expect(p.name).toBe("acme");

    const got = s.getProject(p.id);
    expect(got).toEqual(p);
  });

  it("getProject throws ErrNotFound for an unknown id", async () => {
    const s = await openTestStore();
    expect(() => s.getProject("nope")).toThrow(ErrNotFound);
  });
});

describe("createEnvironment", () => {
  it("rejects a duplicate name within the same project", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    s.createEnvironment(p.id, "production", "kubernetes");
    expect(() => s.createEnvironment(p.id, "production", "kubernetes")).toThrow(ErrDuplicateName);
  });

  it("rejects an unknown project", async () => {
    const s = await openTestStore();
    expect(() => s.createEnvironment("nope", "production", "kubernetes")).toThrow(ErrNotFound);
  });

  it("rejects an unknown target", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    expect(() => s.createEnvironment(p.id, "production", "not-a-real-target")).toThrow(ErrInvalidEnvironmentConfig);
  });

  // Guards against a real, already-proven-necessary fix in the Go
  // source: an environment name reaches Kubernetes manifest YAML and
  // `kubectl apply` verbatim, so arbitrary content (confirmed by a
  // real past regression there with a name containing a newline and
  // YAML) must never reach that point unchecked.
  it("rejects an unsafe name", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    expect(() => s.createEnvironment(p.id, "x\n---\nkind: Pod", "kubernetes")).toThrow(ErrInvalidEnvironmentConfig);
  });

  it("accepts an ordinary DNS-1123-shaped name", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    expect(() => s.createEnvironment(p.id, "production", "kubernetes")).not.toThrow();
  });
});

describe("listEnvironments", () => {
  it("is scoped to one project", async () => {
    const s = await openTestStore();
    const p1 = s.createProject("acme");
    const p2 = s.createProject("other");
    s.createEnvironment(p1.id, "production", "kubernetes");
    s.createEnvironment(p2.id, "production", "kubernetes");

    const envs = s.listEnvironments(p1.id);
    expect(envs).toHaveLength(1);
  });
});

describe("createDeployment", () => {
  it("starts pending", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    const dep = s.createDeployment(env.id);
    expect(dep.status).toBe("pending");
  });

  it("rejects an unknown environment", async () => {
    const s = await openTestStore();
    expect(() => s.createDeployment("nope")).toThrow(ErrNotFound);
  });
});

describe("completeDeployment / failDeployment / getDeployment", () => {
  it("completeDeployment records the content id and URL", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    const dep = s.createDeployment(env.id);
    s.completeDeployment(dep.id, "sha256:abc", "https://example.com");

    const deps = s.listDeployments(env.id);
    expect(deps[0]?.status).toBe("succeeded");
    expect(deps[0]?.contentId).toBe("sha256:abc");
    expect(deps[0]?.url).toBe("https://example.com");
  });

  it("failDeployment records the error", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    const dep = s.createDeployment(env.id);
    s.failDeployment(dep.id, "adapter exploded");

    const deps = s.listDeployments(env.id);
    expect(deps[0]?.status).toBe("failed");
    expect(deps[0]?.error).toBe("adapter exploded");
  });

  it("getDeployment returns the current row", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    const dep = s.createDeployment(env.id);
    s.completeDeployment(dep.id, "sha256:abc", "https://example.com");

    const got = s.getDeployment(dep.id);
    expect(got.status).toBe("succeeded");
  });

  it("getDeployment throws ErrNotFound for an unknown id", async () => {
    const s = await openTestStore();
    expect(() => s.getDeployment("nope")).toThrow(ErrNotFound);
  });
});

describe("createStore", () => {
  it("fails clearly against a missing parent directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-store-"));
    const path = join(dir, "nonexistent-subdir", "test.db");
    expect(() => createStore(path)).toThrow(/does not exist/);
  });

  // 8 concurrent createProject calls, the async-interleaving
  // equivalent of Go's own goroutines. node:sqlite's DatabaseSync is
  // synchronous with no connection pool, so this can't fail the way
  // Go's own SQLITE_BUSY regression once did — confirmed directly
  // during this plan's own research — but the real-world property
  // Go's test proves still deserves its own proof here.
  it("handles concurrent createProject calls without failing", async () => {
    const s = await openTestStore();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => Promise.resolve().then(() => s.createProject(`proj-${i}`))),
    );
    expect(results).toHaveLength(8);
  });
});

describe("v2 store methods", () => {
  it("updateProject persists edgeHost/polling/setup fields", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    expect(p).toMatchObject({
      edgeHost: "",
      pollingEnabled: true,
      lastSeenSha: "",
      setupStatus: "ready",
      setupError: "",
    });
    const updated = s.updateProject(p.id, {
      edgeHost: "acme.127.0.0.1.sslip.io",
      pollingEnabled: false,
      lastSeenSha: "a".repeat(40),
      setupStatus: "needs-setup",
      setupError: "boom",
    });
    expect(updated).toMatchObject({
      edgeHost: "acme.127.0.0.1.sslip.io",
      pollingEnabled: false,
      lastSeenSha: "a".repeat(40),
      setupStatus: "needs-setup",
      setupError: "boom",
    });
    expect(s.getProject(p.id)).toEqual(updated);
    expect(s.listProjects()[0]).toEqual(updated);
  });

  it("setTrafficWeights stores weights and rejects an archived environment", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const a = s.createEnvironment(p.id, "k8s", "kubernetes");
    const b = s.createEnvironment(p.id, "cloudrun", "cloudrun");
    s.setTrafficWeights(p.id, { [a.id]: 90, [b.id]: 10 });
    expect(s.listEnvironments(p.id).map((e) => e.trafficWeight)).toEqual([90, 10]);
    s.setTrafficWeights(p.id, { [a.id]: 100, [b.id]: 0 });
    s.archiveEnvironment(b.id);
    expect(() => s.setTrafficWeights(p.id, { [b.id]: 5 })).toThrow(ErrNotFound);
  });

  it("archived environments are hidden from listEnvironments unless includeArchived", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const a = s.createEnvironment(p.id, "k8s", "kubernetes");
    s.createEnvironment(p.id, "cloudrun", "cloudrun");
    s.archiveEnvironment(a.id);
    expect(s.listEnvironments(p.id).map((e) => e.name)).toEqual(["cloudrun"]);
    const all = s.listEnvironments(p.id, { includeArchived: true });
    expect(all.map((e) => [e.name, e.archived])).toEqual([
      ["k8s", true],
      ["cloudrun", false],
    ]);
  });

  it("appendBuildLog caps at 256 KiB and appends the truncation marker exactly once", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const b = s.createQueuedBuild(p.id, "a".repeat(40));
    s.appendBuildLog(b.id, "x".repeat(200 * 1024));
    s.appendBuildLog(b.id, "y".repeat(100 * 1024));
    s.appendBuildLog(b.id, "z".repeat(10));
    const log = s.getBuild(b.id).log;
    expect(log.length).toBeLessThanOrEqual(256 * 1024 + 32);
    expect(log.split("[log truncated]").length - 1).toBe(1);
    expect(log.endsWith("\n[log truncated]\n")).toBe(true);
    expect(log).not.toContain("z");
  });

  it("queued → running → succeeded records startedAt, finishedAt and deploymentIds", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const b = s.createQueuedBuild(p.id, "a".repeat(40));
    expect(b.status).toBe("queued");
    expect(s.findQueuedBuild(p.id, s.productionStage(p.id).id)?.id).toBe(b.id);
    s.startBuild(b.id);
    expect(s.findRunningBuild(p.id)?.id).toBe(b.id);
    expect(s.findQueuedBuild(p.id, s.productionStage(p.id).id)).toBeUndefined();
    expect(s.getBuild(b.id).startedAt).not.toBe("");
    s.completeBuild(b.id, "succeeded", ["dep_1", "dep_2"]);
    const done = s.getBuild(b.id);
    expect(done).toMatchObject({ status: "succeeded", deploymentIds: ["dep_1", "dep_2"], deploymentId: "dep_1" });
    expect(done.finishedAt).not.toBe("");
    expect(s.findRunningBuild(p.id)).toBeUndefined();
  });

  it("getActiveTransfer ignores done/failed/cancelled transfers", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const a = s.createEnvironment(p.id, "k8s", "kubernetes");
    const b = s.createEnvironment(p.id, "cloudrun", "cloudrun");
    const t = s.createTransfer(p.id, a.id, b.id);
    expect(t.status).toBe("provisioning");
    expect(s.getActiveTransfer(p.id)?.id).toBe(t.id);
    for (const status of ["done", "failed", "cancelled"] as const) {
      s.updateTransfer(t.id, { status });
      expect(s.getActiveTransfer(p.id)).toBeUndefined();
    }
    s.updateTransfer(t.id, { status: "shifting", weight: 10, error: "" });
    expect(s.getTransfer(t.id)).toMatchObject({ status: "shifting", weight: 10 });
  });
});

describe("deleteProject", () => {
  it("removes the project and everything under it, leaving other projects alone", async () => {
    const s = await openTestStore();
    const keep = s.createProject("keep");
    const keepEnv = s.createEnvironment(keep.id, "k8s", "kubernetes");
    const p = s.createProject("gone");
    s.setGitConfig(p.id, {
      repo: "https://github.com/a/b",
      productionBranch: "main",
      framework: "static",
      buildCommand: "x",
    });
    s.ensureWebhookSecret(p.id);
    const env = s.createEnvironment(p.id, "k8s", "kubernetes");
    const dep = s.createDeployment(env.id);
    s.completeDeployment(dep.id, "sha256:x", "https://x");
    s.setCronSigningSecret(env.id, "secret");
    const b = s.createQueuedBuild(p.id, "a".repeat(40));
    s.completeBuild(b.id, "succeeded", [dep.id]);
    s.createTransfer(p.id, env.id, "");

    s.deleteProject(p.id);

    expect(() => s.getProject(p.id)).toThrow(ErrNotFound);
    expect(() => s.getEnvironment(env.id)).toThrow(ErrNotFound);
    expect(() => s.getDeployment(dep.id)).toThrow(ErrNotFound);
    expect(() => s.getBuild(b.id)).toThrow(ErrNotFound);
    expect(() => s.getGitConfig(p.id)).toThrow(ErrNotFound);
    expect(s.getLatestTransfer(p.id)).toBeUndefined();
    expect(s.listProjects().map((x) => x.name)).toEqual(["keep"]);
    expect(s.getEnvironment(keepEnv.id).name).toBe("k8s");
    // The name is free again.
    expect(s.createProject("gone").name).toBe("gone");
  });

  it("deleteProject of an unknown id throws ErrNotFound", async () => {
    const s = await openTestStore();
    expect(() => s.deleteProject("proj_nope")).toThrow(ErrNotFound);
  });
});

describe("per-cloud auto-deploy and deployment build ids", () => {
  it("a new environment deploys new commits automatically until switched off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-autodeploy-"));
    const store = createStore(join(dir, "t.db"));
    try {
      const p = store.createProject("acme");
      const env = store.createEnvironment(p.id, "k8s", "kubernetes");
      expect(env.autoDeploy).toBe(true);
      expect(store.getEnvironment(env.id).autoDeploy).toBe(true);
      store.setEnvironmentAutoDeploy(env.id, false);
      expect(store.getEnvironment(env.id).autoDeploy).toBe(false);
      expect(store.listEnvironments(p.id)[0]!.autoDeploy).toBe(false);
      store.setEnvironmentAutoDeploy(env.id, true);
      expect(store.getEnvironment(env.id).autoDeploy).toBe(true);
      expect(() => store.setEnvironmentAutoDeploy("env_missing", true)).toThrow(/not found|env_missing/);
    } finally {
      store.close();
    }
  });

  it("a deployment records the build it came from", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-autodeploy-"));
    const store = createStore(join(dir, "t.db"));
    try {
      const p = store.createProject("acme");
      const env = store.createEnvironment(p.id, "k8s", "kubernetes");
      const withBuild = store.createDeployment(env.id, { buildId: "build_abc" });
      const without = store.createDeployment(env.id);
      expect(withBuild.buildId).toBe("build_abc");
      expect(store.getDeployment(withBuild.id).buildId).toBe("build_abc");
      expect(store.getDeployment(without.id).buildId).toBe("");
      expect(store.listDeployments(env.id).map((d) => d.buildId)).toEqual(["build_abc", ""]);
    } finally {
      store.close();
    }
  });
});
