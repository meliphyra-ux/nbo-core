// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { pollOnce } from "../git/poller.js";
import { createSetup, setupConfig } from "../deploys/setup.js";
import { startHarness, staticSetup, type Harness } from "./v2-harness.js";
import { keyGate, sshRepo, keyRefusal } from "./key-gate-fixture.js";

let h: Harness;
let g: ReturnType<typeof keyGate>["gate"];
const saved = { ...setupConfig };
const HOUR = 3_600_000;

beforeEach(async () => {
  const k = keyGate();
  g = k.gate;
  h = await startHarness({ secretKey: true, repoAliases: [sshRepo], v2: k.v2 });
});
afterEach(async () => {
  Object.assign(setupConfig, saved);
  await h.close();
});

const deps = () => ({
  store: h.store,
  queue: h.v2.queue,
  edgeSync: h.v2.edgeSync,
  poller: h.v2.poller,
  setup: h.v2.setup,
});

async function waitingProject(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await h.call(
    "POST",
    "/projects/setup",
    staticSetup({ repo: sshRepo, credential: { kind: "deploy-key" }, ...overrides }),
  );
  expect(res.status, res.text).toBe(201);
  const id = res.json.project.id as string;
  await h.v2.setup.settled(id);
  return id;
}

describe("waiting-for-key", () => {
  it("a refused first read of a deploy-key project lands in waiting-for-key, not needs-setup", async () => {
    const id = await waitingProject();
    expect(h.store.getProject(id)).toMatchObject({
      setupStatus: "waiting-for-key",
      setupError: expect.stringContaining(keyRefusal),
      keyWaitSince: new Date(g.clock).toISOString(),
    });
    expect(h.store.getProject(id).setupError).not.toContain("\n");
    expect(h.store.listEnvironments(id)).toHaveLength(1);
  });

  it("a public project's refused read still lands in needs-setup", async () => {
    const res = await h.call("POST", "/projects/setup", staticSetup({ name: "pub" }));
    const id = res.json.project.id as string;
    await h.v2.setup.settled(id);
    expect(h.store.getProject(id).setupStatus).toBe("needs-setup");
  });

  it("pollOnce completes it once the remote accepts, and builds the head once", async () => {
    const id = await waitingProject();
    await pollOnce(deps());
    expect(h.store.getProject(id).setupStatus).toBe("waiting-for-key");
    expect(h.store.listBuilds(id)).toEqual([]);

    g.open = true;
    await pollOnce(deps());
    await h.v2.queue.idle(id);
    expect(h.store.getProject(id)).toMatchObject({
      setupStatus: "ready",
      setupError: "",
      keyWaitSince: "",
      lastSeenSha: h.head,
    });
    await pollOnce(deps());
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id)).toHaveLength(1);
  });

  it("a nudge completes it at once (force), answering the first build", async () => {
    const id = await waitingProject();
    const refused = await h.call("POST", `/projects/${id}/git/poll`);
    expect(refused.status).toBe(200);
    expect(refused.json).toMatchObject({ queued: [], setupStatus: "waiting-for-key" });

    // Past the fast hour and just tried: only force reads again.
    g.clock += 2 * HOUR;
    await pollOnce(deps());
    g.open = true;
    const res = await h.call("POST", `/projects/${id}/git/poll`);
    expect(res.status).toBe(200);
    expect(res.json.setupStatus).toBe("ready");
    expect(res.json.queued).toHaveLength(1);
    expect(res.json.queued[0]).toMatchObject({ revision: h.head, stageName: "production" });
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id)).toHaveLength(1);
  });

  it("after the fast hour pollOnce tries at most every keyWaitEveryMs", async () => {
    await waitingProject();
    const reads = () => g.reads;
    let before = reads();
    await pollOnce(deps());
    g.clock += 60_000;
    await pollOnce(deps());
    expect(reads() - before).toBe(2);

    g.clock += HOUR;
    before = reads();
    await pollOnce(deps());
    expect(reads() - before).toBe(1);
    g.clock += 60_000;
    await pollOnce(deps());
    expect(reads() - before).toBe(1);
    g.clock += setupConfig.keyWaitEveryMs;
    await pollOnce(deps());
    expect(reads() - before).toBe(2);
  });

  it("after 7 days it gives up with the exact needs-setup message", async () => {
    const id = await waitingProject();
    g.clock += setupConfig.keyWaitMaxMs + 1;
    await pollOnce(deps());
    expect(h.store.getProject(id)).toMatchObject({
      setupStatus: "needs-setup",
      setupError: `NBO never got read access to ${sshRepo}. Add the deploy key, then retry setup.`,
    });
  });

  it("skipFirstBuild survives a restart while waiting", async () => {
    const id = await waitingProject({ skipFirstBuild: true });
    expect(h.store.getProject(id).skipFirstBuild).toBe(true);
    // A second Setup on the same store: nothing in memory.
    const restarted = createSetup({
      store: h.store,
      cloudSetup: h.cloud,
      queue: h.v2.queue,
      lsRemote: h.v2.lsRemote,
      gitAuth: h.v2.gitAuth,
      now: () => g.clock,
    });
    g.open = true;
    const out = await restarted.checkKey(id, { force: true });
    expect(out).toMatchObject({ setupStatus: "ready", queued: null });
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id)).toEqual([]);
    expect(h.store.getProject(id)).toMatchObject({ lastSeenSha: h.head, skipFirstBuild: false });
  });

  it("polling off: a waiting project is still read by the loop and still gives up after 7 days", async () => {
    const id = await waitingProject();
    h.store.updateProject(id, { pollingEnabled: false });
    const before = g.reads;
    await pollOnce(deps());
    expect(g.reads - before).toBe(1);
    g.clock += setupConfig.keyWaitMaxMs + 1;
    await pollOnce(deps());
    expect(h.store.getProject(id)).toMatchObject({
      setupStatus: "needs-setup",
      setupError: expect.stringContaining("retry setup"),
    });
  });

  for (const skipFirstBuild of [true, false]) {
    it(`a setup retry during a key read completes setup once (skipFirstBuild ${skipFirstBuild})`, async () => {
      const id = await waitingProject(skipFirstBuild ? { skipFirstBuild: true } : {});
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let calls = 0;
      const lsRemote = async (repo: string, branch: string, opts?: { env?: NodeJS.ProcessEnv }) => {
        const head = await h.v2.lsRemote(repo, branch, opts);
        // The first read (checkKey's) answers only after the retry has finished.
        if (calls++ === 0) await held;
        return head;
      };
      const s = createSetup({
        store: h.store,
        cloudSetup: h.cloud,
        queue: h.v2.queue,
        lsRemote,
        gitAuth: h.v2.gitAuth,
        now: () => g.clock,
      });
      g.open = true;
      const check = s.checkKey(id, { force: true });
      await new Promise((r) => setTimeout(r, 20));
      s.retry(id);
      await s.settled(id);
      expect(h.store.getProject(id).setupStatus).toBe("ready");
      release();
      await check;
      await h.v2.queue.idle(id);
      expect(h.store.listBuilds(id)).toHaveLength(skipFirstBuild ? 0 : 1);
      expect(h.store.getProject(id)).toMatchObject({
        setupStatus: "ready",
        skipFirstBuild: false,
        lastSeenSha: h.head,
      });
    });
  }

  it("a key read while a setup retry runs leaves it to the retry", async () => {
    const id = await waitingProject({ skipFirstBuild: true });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    const lsRemote = async (repo: string, branch: string, opts?: { env?: NodeJS.ProcessEnv }) => {
      const head = await h.v2.lsRemote(repo, branch, opts);
      // The first read (the retry's) answers only after the key read was asked.
      if (calls++ === 0) await held;
      return head;
    };
    const s = createSetup({
      store: h.store,
      cloudSetup: h.cloud,
      queue: h.v2.queue,
      lsRemote,
      gitAuth: h.v2.gitAuth,
      now: () => g.clock,
    });
    g.open = true;
    s.retry(id);
    h.store.updateProject(id, { setupStatus: "waiting-for-key" });
    const out = await s.checkKey(id, { force: true });
    expect(out.queued).toBeNull();
    release();
    await s.settled(id);
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id)).toEqual([]);
  });
});
