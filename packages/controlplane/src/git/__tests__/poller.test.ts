// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { forgetPolledStage, pollOnce } from "../poller.js";
import { startHarness, deployedProject, type Harness } from "../../__tests__/v2-harness.js";
import { rewriteGitUrl } from "../../testing.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const deps = () => ({ store: h.store, queue: h.v2.queue, edgeSync: h.v2.edgeSync });

describe("pollOnce", () => {
  it("enqueues a build when the branch head moves and records it", async () => {
    const id = await deployedProject(h);
    const next = await h.commit("second");
    await pollOnce(deps());
    expect(h.store.getProject(id).lastSeenSha).toBe(next);
    await h.v2.queue.idle(id);
    const builds = h.store.listBuilds(id);
    expect(builds.map((b) => b.revision)).toEqual([h.head, next]);
    expect(builds[1]!.status).toBe("succeeded");
  });

  it("does nothing when the head is unchanged", async () => {
    const id = await deployedProject(h);
    await pollOnce(deps());
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id)).toHaveLength(1);
  });

  it("does not retry a failed head", async () => {
    h.deploys.failTargets.add("kubernetes");
    const id = await deployedProject(h);
    expect(h.store.listBuilds(id)[0]!.status).toBe("failed");
    await pollOnce(deps());
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id)).toHaveLength(1);
  });

  it("skips projects with polling disabled or not ready", async () => {
    const id = await deployedProject(h);
    h.store.updateProject(id, { pollingEnabled: false });
    await h.commit("second");
    await pollOnce(deps());
    expect(h.store.listBuilds(id)).toHaveLength(1);
    h.store.updateProject(id, { pollingEnabled: true, setupStatus: "needs-setup" });
    await pollOnce(deps());
    expect(h.store.listBuilds(id)).toHaveLength(1);
  });

  it("keeps going when one repo is unreachable", async () => {
    // The URL is rewritten to a path that isn't a repository, so git fails
    // at once (a refused TCP port takes ~2s to give up on Windows).
    const unrewrite = rewriteGitUrl("https://github.com/acme/nope.git", join(tmpdir(), "nbo-no-such-repo"));
    try {
      const broken = h.store.createProject("aaa-broken");
      h.store.setGitConfig(broken.id, {
        repo: "https://github.com/acme/nope.git",
        productionBranch: "main",
        framework: "static",
        buildCommand: "x",
      });
      const id = await deployedProject(h);
      const next = await h.commit("second");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await pollOnce(deps());
        expect(errors).toHaveBeenCalledWith(expect.stringContaining("polling aaa-broken failed"));
      } finally {
        errors.mockRestore();
      }
      expect(h.store.getProject(id).lastSeenSha).toBe(next);
      await h.v2.queue.idle(id);
    } finally {
      unrewrite();
    }
  });

  it("reconciles the edge", async () => {
    await deployedProject(h);
    h.registry.set("storefront.127.0.0.1.sslip.io", [
      { url: "https://elsewhere.example", weight: 100, insecureSkipVerify: false },
    ]);
    await pollOnce(deps());
    expect(h.registry.get("storefront.127.0.0.1.sslip.io")?.backends[0]?.url).toMatch(/sslip\.io$/);
  });

  it("skips a project with no git config without logging an error", async () => {
    h.store.createProject("legacy");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pollOnce(deps());
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("pollOnce with environments", () => {
  const sha = (c: string) => c.repeat(40);

  // A deployed project plus a staging environment on the "staging" branch,
  // and a fake ls-remote that counts its calls.
  async function withStaging(autoDeploy = true) {
    const id = await deployedProject(h);
    const staging = h.store.createStage(id, { name: "staging", branch: "staging", autoDeploy, host: "" });
    h.store.createEnvironment(id, "s-staging-k8s", "kubernetes", undefined, staging.id);
    const heads = new Map<string, string>([["main", h.head]]);
    const calls: string[] = [];
    const lsRemoteHeads = async (repo: string) => {
      calls.push(repo);
      return new Map(heads);
    };
    return { id, staging, heads, calls, run: () => pollOnce({ ...deps(), lsRemoteHeads }) };
  }

  it("asks the remote once per project per tick, however many environments it has", async () => {
    const { id, calls, run } = await withStaging();
    h.store.createStage(id, { name: "qat", branch: "qa", host: "" });
    await run();
    expect(calls).toHaveLength(1);
  });

  it("a new head on the staging branch enqueues a staging build and records it on the stage", async () => {
    const { id, staging, heads, run } = await withStaging();
    heads.set("staging", sha("c"));
    await run();
    const build = h.store.listBuilds(id).find((b) => b.revision === sha("c"));
    expect(build).toMatchObject({ stageId: staging.id, revision: sha("c") });
    expect(h.store.getStage(staging.id).lastSeenSha).toBe(sha("c"));
    // Production is untouched.
    expect(h.store.getProject(id).lastSeenSha).toBe(h.head);
    await h.v2.queue.idle(id);
    await run();
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id).filter((b) => b.revision === sha("c"))).toHaveLength(1);
  });

  it("builds Production and staging in the same tick", async () => {
    const { id, staging, heads, run } = await withStaging();
    const next = await h.commit("second");
    heads.set("main", next);
    heads.set("staging", sha("d"));
    await run();
    const builds = h.store.listBuilds(id);
    expect(builds.find((b) => b.revision === next)?.stageId).toBe(h.store.productionStage(id).id);
    expect(builds.find((b) => b.revision === sha("d"))?.stageId).toBe(staging.id);
    await h.v2.queue.idle(id);
  });

  it("skips a staging environment with auto-deploy off", async () => {
    const { id, staging, heads, run } = await withStaging(false);
    heads.set("staging", sha("c"));
    await run();
    expect(h.store.listBuilds(id).some((b) => b.revision === sha("c"))).toBe(false);
    expect(h.store.getStage(staging.id).lastSeenSha).toBe("");
  });

  it("logs a missing branch once until it changes", async () => {
    const { heads, run } = await withStaging();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run();
      await run();
      const missing = () =>
        errors.mock.calls.filter((c) => String(c[0]).includes('"staging"') && String(c[0]).includes("not found"));
      expect(missing()).toHaveLength(1);
      heads.set("staging", sha("c"));
      await run();
      heads.delete("staging");
      await run();
      expect(missing()).toHaveLength(2);
    } finally {
      errors.mockRestore();
    }
  });

  it("a stage on the production branch never builds as well (Production does)", async () => {
    const { id, staging, heads, run } = await withStaging();
    h.store.updateStage(staging.id, { branch: "main" });
    const next = await h.commit("second");
    heads.set("main", next);
    await run();
    const builds = h.store.listBuilds(id).filter((b) => b.revision === next);
    expect(builds.map((b) => b.stageId)).toEqual([h.store.productionStage(id).id]);
    expect(h.store.getStage(staging.id).lastSeenSha).toBe("");
    await h.v2.queue.idle(id);
  });

  it("forgetPolledStage drops a deleted stage's missing-branch memory", async () => {
    const { id, staging, run } = await withStaging();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const missing = () =>
        errors.mock.calls.filter((c) => String(c[0]).includes('"staging"') && String(c[0]).includes("not found"));
      await run();
      await run();
      expect(missing()).toHaveLength(1);
      forgetPolledStage(id, staging.id);
      await run();
      expect(missing()).toHaveLength(2);
    } finally {
      errors.mockRestore();
    }
  });
});

// Ephemeral environments build from their branch like custom ones, until
// their removal starts; any other branch builds nothing.
describe("pollOnce and ephemeral environments", () => {
  const sha = (c: string) => c.repeat(40);
  const ephemeral = (id: string, branch: string) =>
    h.store.createEphemeralStage(id, {
      branch,
      host: `${branch.replace(/\W+/g, "-")}--storefront.127.0.0.1.sslip.io`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      label: "",
    });

  it("a moved head of an ephemeral environment's branch builds it; one being removed builds nothing", async () => {
    const id = await deployedProject(h);
    const a = ephemeral(id, "feature/a");
    const b = ephemeral(id, "feature/b");
    h.store.updateStage(b.id, { removal: "removing" });
    const heads = new Map<string, string>([
      ["main", h.head],
      ["feature/a", h.head],
      ["feature/b", h.head],
      ["feature/c", h.head],
    ]);
    await pollOnce({ ...deps(), lsRemoteHeads: async () => new Map(heads) });
    await h.v2.queue.idle(id);
    const builds = h.store.listBuilds(id);
    expect(builds.filter((x) => x.stageId === a.id)).toHaveLength(1);
    expect(builds.filter((x) => x.stageId === b.id)).toHaveLength(0);
    expect(builds).toHaveLength(2);
    expect(h.store.getStage(a.id).lastSeenSha).toBe(h.head);
  });

  it("a branch no environment uses builds nothing", async () => {
    const id = await deployedProject(h);
    const before = h.store.listBuilds(id).length;
    await pollOnce({
      ...deps(),
      lsRemoteHeads: async () =>
        new Map([
          ["main", h.head],
          ["feature/x", sha("b")],
        ]),
    });
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id)).toHaveLength(before);
  });
});
