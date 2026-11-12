// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, ErrNotFound, type Store } from "../store.js";
import type { GitConfig } from "../git.js";

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
  const dir = await mkdtemp(join(tmpdir(), "controlplane-git-"));
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

function gitConfigFixture(): GitConfig {
  return { repo: "https://example.com/acme/web.git", productionBranch: "main", framework: "static", buildCommand: "npm run build", outputDir: "dist" };
}

describe("git config storage", () => {
  it("round-trips setGitConfig/getGitConfig", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");

    store.setGitConfig(proj.id, gitConfigFixture());
    const got = store.getGitConfig(proj.id);

    expect(got).toEqual(gitConfigFixture());
  });

  it("throws ErrNotFound when no git config has been set", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");

    expect(() => store.getGitConfig(proj.id)).toThrow(ErrNotFound);
  });
});

describe("webhook secrets", () => {
  it("generates a stable secret for the same project", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");

    const first = store.ensureWebhookSecret(proj.id);
    const second = store.ensureWebhookSecret(proj.id);

    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it("gives different projects different secrets", async () => {
    const store = await openTestStore();
    const projA = store.createProject("acme-a");
    const projB = store.createProject("acme-b");

    expect(store.ensureWebhookSecret(projA.id)).not.toBe(store.ensureWebhookSecret(projB.id));
  });
});

describe("builds", () => {
  it("createBuild starts running with empty deploymentId/error", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");

    const build = store.createBuild(proj.id, "abc123");

    expect(build.status).toBe("running");
    expect(build.deploymentId).toBe("");
    expect(build.error).toBe("");
    expect(build.revision).toBe("abc123");
  });

  it("completeBuild(succeeded) updates status and deploymentId", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const build = store.createBuild(proj.id, "abc123");

    store.completeBuild(build.id, "succeeded", ["dep_xyz"]);

    const got = store.getBuild(build.id);
    expect(got.status).toBe("succeeded");
    expect(got.deploymentId).toBe("dep_xyz");
  });

  it("completeBuild(failed) updates status and error", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const build = store.createBuild(proj.id, "abc123");

    store.completeBuild(build.id, "failed", undefined, "boom");

    const got = store.getBuild(build.id);
    expect(got.status).toBe("failed");
    expect(got.error).toBe("boom");
  });

  it("listBuilds returns a project's own builds ordered by createdAt", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const b1 = store.createBuild(proj.id, "rev1");
    const b2 = store.createBuild(proj.id, "rev2");

    const builds = store.listBuilds(proj.id);

    expect(builds.map((b) => b.id)).toEqual([b1.id, b2.id]);
  });
});
