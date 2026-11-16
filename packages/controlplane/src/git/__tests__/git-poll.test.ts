// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach } from "vitest";
import { startHarness, deployedProject, type Harness } from "../../__tests__/v2-harness.js";
import { startFakeGitHub } from "../../__tests__/fake-github.js";
import { createProjectPoller } from "../poller.js";
import { lsRemoteHeads as realHeads, type GitRemoteOptions } from "../gitremote.js";

let h: Harness;
afterEach(async () => {
  await h.close();
});

const poll = (id: string, body?: unknown) => h.call("POST", `/projects/${id}/git/poll`, body);

// counting wraps the real ls-remote; with gate set, every call waits for it.
function counting() {
  const state = { calls: 0, gate: null as Promise<void> | null };
  const fn = async (repo: string, opts?: GitRemoteOptions) => {
    state.calls++;
    if (state.gate) await state.gate;
    return realHeads(repo, opts);
  };
  return { state, fn };
}

describe("POST /projects/{id}/git/poll", () => {
  it("a nudge after a push queues one build of the new head and answers it", async () => {
    h = await startHarness();
    const id = await deployedProject(h);
    const next = await h.commit("second");
    const res = await poll(id);
    expect(res.status).toBe(200);
    expect(res.json.setupStatus).toBe("ready");
    expect(res.json.queued).toHaveLength(1);
    expect(res.json.queued[0]).toMatchObject({ stageName: "production", revision: next });
    expect(typeof res.json.queued[0].buildId).toBe("string");
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id).filter((b) => b.revision === next)).toHaveLength(1);
  });

  it("a nudge with nothing new queues nothing", async () => {
    h = await startHarness();
    const id = await deployedProject(h);
    const res = await poll(id, {});
    expect(res.status).toBe(200);
    expect(res.json.queued).toEqual([]);
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id)).toHaveLength(1);
  });

  it("a nudge racing pollOnce builds the push once", async () => {
    h = await startHarness();
    const id = await deployedProject(h);
    const next = await h.commit("second");
    const { pollOnce } = await import("../poller.js");
    const deps = { store: h.store, queue: h.v2.queue, edgeSync: h.v2.edgeSync, poller: h.v2.poller };
    const [, res] = await Promise.all([pollOnce(deps), poll(id)]);
    expect(res.status).toBe(200);
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id).filter((b) => b.revision === next)).toHaveLength(1);
  });

  it("a nudge racing the per-project webhook of a legacy-linked project builds once", async () => {
    const fake = await startFakeGitHub();
    try {
      h = await startHarness({ v2: { githubApiUrl: fake.url } });
      h.store.setSecretKey(randomBytes(32));
      const app = fake.createApp();
      const raw = new DatabaseSync(h.dbPath);
      raw
        .prepare("INSERT INTO server_settings (key, value) VALUES ('github_app', ?)")
        .run(JSON.stringify({ appId: app.id }));
      raw.close();
      h.store.setServerSecret("github_private_key", app.pem);
      const installationId = fake.addInstallation({ account: "acme" });
      const repo = await fake.addRepo([installationId], { name: "storefront", owner: "acme", private: true });
      const id = await deployedProject(h);
      h.store.setGitConfig(id, {
        ...h.store.getGitConfig(id),
        github: { installationId, repoId: repo.id, fullName: "acme/storefront" },
      });
      const next = await h.commit("second");
      const payload = JSON.stringify({ ref: "refs/heads/main", before: h.head, after: next });
      const signature = `sha256=${createHmac("sha256", h.store.ensureWebhookSecret(id)).update(payload).digest("hex")}`;
      const hook = h.mux(
        new Request(`http://cp/projects/${id}/webhooks/github`, {
          method: "POST",
          body: payload,
          headers: { "x-hub-signature-256": signature, "x-github-event": "push" },
        }),
      );
      const [, res] = await Promise.all([hook, poll(id)]);
      expect(res.status).toBe(200);
      await h.v2.queue.idle(id);
      expect(h.store.listBuilds(id).filter((b) => b.revision === next)).toHaveLength(1);
    } finally {
      await fake.stop();
    }
  }, 60_000);

  it("polling off: 200, queued [], the note, no ls-remote", async () => {
    const c = counting();
    h = await startHarness({ v2: { lsRemoteHeads: c.fn } });
    const id = await deployedProject(h);
    h.store.updateProject(id, { pollingEnabled: false });
    const res = await poll(id);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      queued: [],
      setupStatus: "ready",
      note: "deploying automatically is off for this project",
    });
    expect(c.state.calls).toBe(0);
  });

  it("five concurrent nudges make at most two ls-remote calls", async () => {
    const c = counting();
    h = await startHarness({ v2: { lsRemoteHeads: c.fn } });
    const id = await deployedProject(h);
    let open!: () => void;
    c.state.gate = new Promise<void>((r) => (open = r));
    const all = Promise.all([1, 2, 3, 4, 5].map(() => poll(id)));
    await new Promise((r) => setTimeout(r, 200));
    open();
    const results = await all;
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(c.state.calls).toBeLessThanOrEqual(2);
    expect(c.state.calls).toBeGreaterThanOrEqual(1);
  });

  it("a body key is refused with 400", async () => {
    h = await startHarness();
    const id = await deployedProject(h);
    const res = await poll(id, { revision: "x" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("this route takes no body");
  });

  it("an unknown project is 404", async () => {
    h = await startHarness();
    expect((await poll("prj_nope")).status).toBe(404);
  });

  it("a provisioning project is 409", async () => {
    h = await startHarness();
    const id = await deployedProject(h);
    h.store.updateProject(id, { setupStatus: "provisioning" });
    const res = await poll(id);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("setup is still provisioning");
  });

  it("an unreadable remote is 502 naming the repo", async () => {
    const c = {
      fn: async () => {
        throw new Error("fatal: repository not found\nmore");
      },
    };
    h = await startHarness({ v2: { lsRemoteHeads: c.fn } });
    const id = await deployedProject(h);
    const res = await poll(id);
    expect(res.status).toBe(502);
    expect(res.json.error).toBe(
      `could not read the heads of ${h.store.getGitConfig(id).repo}: fatal: repository not found`,
    );
  });

  it("two pollers on a custom stage build a push exactly once", async () => {
    h = await startHarness();
    const id = await deployedProject(h);
    const staging = h.store.createStage(id, { name: "staging", branch: "staging", autoDeploy: true, host: "" });
    h.store.createEnvironment(id, "s-staging-k8s", "kubernetes", undefined, staging.id);
    const pushed = "c".repeat(40);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const heads = async () => {
      await gate;
      return new Map([
        ["main", h.head],
        ["staging", pushed],
      ]);
    };
    // Two separate pollers (no shared coalescing): only advanceHead stops the second.
    const deps = { store: h.store, queue: h.v2.queue, edgeSync: h.v2.edgeSync, lsRemoteHeads: heads };
    const a = createProjectPoller(deps).pollProject(id);
    const b = createProjectPoller(deps).pollProject(id);
    await new Promise((r) => setTimeout(r, 100));
    open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.queued.length + rb.queued.length).toBe(1);
    expect(h.store.listBuilds(id).filter((x) => x.revision === pushed)).toHaveLength(1);
  });

  it("a caller arriving mid-run joins one more run and sees the push that landed meanwhile", async () => {
    let read!: () => void;
    const firstRead = new Promise<void>((r) => (read = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let calls = 0;
    const fn = async (repo: string, opts?: GitRemoteOptions) => {
      const n = ++calls;
      const heads = await realHeads(repo, opts);
      if (n === 1) {
        read();
        await gate;
      }
      return heads;
    };
    h = await startHarness({ v2: { lsRemoteHeads: fn } });
    const id = await deployedProject(h);
    calls = 0;
    const a = poll(id);
    await firstRead;
    const next = await h.commit("lands while the first run is in flight");
    const b = poll(id);
    await new Promise((r) => setTimeout(r, 100));
    open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.json.queued).toEqual([]);
    expect(rb.json.queued.map((q: { revision: string }) => q.revision)).toEqual([next]);
    expect(calls).toBe(2);
  });
});
