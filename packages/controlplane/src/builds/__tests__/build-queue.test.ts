// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../../store/store.js";
import { createBuildQueue, recoverInterruptedBuilds } from "../build-queue.js";
import { createSuppliedValues } from "../../variables/supplied-values.js";

const openStores: Store[] = [];
afterEach(() => {
  for (const s of openStores.splice(0)) s.close();
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-queue-"));
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

const sha = (c: string) => c.repeat(40);

// A runner whose builds finish only when the test says so: each
// runBuild call marks the build running and waits on its own gate.
function gatedRunner(store: Store) {
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  return {
    started,
    release(buildId: string) {
      gates.get(buildId)?.();
    },
    async runBuild(buildId: string) {
      store.startBuild(buildId);
      started.push(buildId);
      await new Promise<void>((resolve) => gates.set(buildId, resolve));
      store.completeBuild(buildId, "succeeded", []);
    },
  };
}

describe("createBuildQueue", () => {
  it("enqueue on an idle project starts the build immediately", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    const runner = gatedRunner(store);
    const queue = createBuildQueue(store, runner, createSuppliedValues());

    const b = queue.enqueue(p.id, sha("a"));
    expect(runner.started).toEqual([b.id]);
    expect(store.getBuild(b.id).status).toBe("running");
    runner.release(b.id);
    await queue.idle(p.id);
    expect(store.getBuild(b.id).status).toBe("succeeded");
  });

  it("a newer build replacing a queued manual build stays manual; plain replacing plain stays plain", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    const runner = gatedRunner(store);
    const queue = createBuildQueue(store, runner, createSuppliedValues());

    const running = queue.enqueue(p.id, sha("a"));
    const plain = queue.enqueue(p.id, sha("b"));
    const plain2 = queue.enqueue(p.id, sha("c"));
    expect(store.getBuild(plain2.id).manual).toBe(false);
    const manual = queue.enqueue(p.id, sha("d"), { manual: true });
    const replacing = queue.enqueue(p.id, sha("e"));
    expect(store.getBuild(plain.id).status).toBe("skipped");
    expect(store.getBuild(manual.id).status).toBe("skipped");
    expect(store.getBuild(replacing.id).manual).toBe(true);

    runner.release(running.id);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    runner.release(replacing.id);
    await queue.idle(p.id);
    expect(store.getBuild(replacing.id).status).toBe("succeeded");
  });

  it("a second enqueue while running queues, a third replaces the queued one", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    const runner = gatedRunner(store);
    const queue = createBuildQueue(store, runner, createSuppliedValues());

    const first = queue.enqueue(p.id, sha("a"));
    const second = queue.enqueue(p.id, sha("b"));
    expect(second.status).toBe("queued");
    const third = queue.enqueue(p.id, sha("c"));

    const builds = store.listBuilds(p.id);
    expect(builds.filter((b) => b.status === "running").map((b) => b.id)).toEqual([first.id]);
    expect(builds.filter((b) => b.status === "queued").map((b) => b.id)).toEqual([third.id]);
    expect(store.getBuild(second.id)).toMatchObject({ status: "skipped", error: "superseded by a newer build" });
    expect(runner.started).toEqual([first.id]);

    runner.release(first.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.started).toEqual([first.id, third.id]);
    runner.release(third.id);
    await queue.idle(p.id);
    expect(store.getBuild(third.id).status).toBe("succeeded");
  });

  it("builds for different projects run concurrently", async () => {
    const store = await openTestStore();
    const a = store.createProject("a");
    const b = store.createProject("b");
    const runner = gatedRunner(store);
    const queue = createBuildQueue(store, runner, createSuppliedValues());

    const ba = queue.enqueue(a.id, sha("a"));
    const bb = queue.enqueue(b.id, sha("b"));
    expect(runner.started).toEqual([ba.id, bb.id]);
    runner.release(ba.id);
    runner.release(bb.id);
    await queue.idle(a.id);
    await queue.idle(b.id);
  });

  it("a runner that throws marks the build failed and still drains the queue", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    let calls = 0;
    const queue = createBuildQueue(
      store,
      {
        async runBuild(id: string) {
          calls++;
          if (calls === 1) throw new Error("kaboom");
          store.startBuild(id);
          store.completeBuild(id, "succeeded", []);
        },
      },
      createSuppliedValues(),
    );
    const first = queue.enqueue(p.id, sha("a"));
    const second = queue.enqueue(p.id, sha("b"));
    await queue.idle(p.id);
    expect(store.getBuild(first.id)).toMatchObject({ status: "failed", error: "kaboom" });
    expect(store.getBuild(second.id).status).toBe("succeeded");
  });

  it("idle resolves immediately for a project with nothing running", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    const queue = createBuildQueue(store, gatedRunner(store), createSuppliedValues());
    await queue.idle(p.id);
  });

  it("recoverInterruptedBuilds fails builds a previous process left running or queued", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    const running = store.createQueuedBuild(p.id, sha("a"));
    store.startBuild(running.id);
    const queued = store.createQueuedBuild(p.id, sha("b"));
    const done = store.createQueuedBuild(p.id, sha("c"));
    store.completeBuild(done.id, "succeeded", []);

    recoverInterruptedBuilds(store);

    expect(store.getBuild(running.id)).toMatchObject({
      status: "failed",
      error: "interrupted: the control-plane restarted during this build",
    });
    expect(store.getBuild(queued.id)).toMatchObject({
      status: "failed",
      error: "interrupted: the control-plane restarted during this build",
    });
    expect(store.getBuild(done.id).status).toBe("succeeded");
  });
});

describe("builds per stage", () => {
  it("a build without a stage belongs to Production; a staging build records its stage", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    const staging = store.createStage(p.id, { name: "staging", branch: "staging", host: "" });
    expect(store.createQueuedBuild(p.id, sha("a")).stageId).toBe(store.productionStage(p.id).id);
    expect(store.createBuild(p.id, sha("a")).stageId).toBe(store.productionStage(p.id).id);
    const b = store.createQueuedBuild(p.id, sha("b"), { stageId: staging.id });
    expect(store.getBuild(b.id).stageId).toBe(staging.id);
  });

  it("a queued Production build survives a staging enqueue; two staging enqueues supersede", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    const staging = store.createStage(p.id, { name: "staging", branch: "staging", host: "" });
    const runner = gatedRunner(store);
    const queue = createBuildQueue(store, runner, createSuppliedValues());

    const running = queue.enqueue(p.id, sha("a"));
    const prod = queue.enqueue(p.id, sha("b"));
    const s1 = queue.enqueue(p.id, sha("c"), { stageId: staging.id });
    expect(store.getBuild(prod.id).status).toBe("queued");
    expect(store.getBuild(s1.id)).toMatchObject({ status: "queued", stageId: staging.id });
    const s2 = queue.enqueue(p.id, sha("d"), { stageId: staging.id });
    expect(store.getBuild(s1.id)).toMatchObject({ status: "skipped", error: "superseded by a newer build" });
    expect(store.getBuild(prod.id).status).toBe("queued");
    expect(store.getBuild(s2.id).status).toBe("queued");
    expect(store.findQueuedBuild(p.id, staging.id)?.id).toBe(s2.id);
    expect(store.findQueuedBuild(p.id, store.productionStage(p.id).id)?.id).toBe(prod.id);

    runner.release(running.id);
    await new Promise((r) => setTimeout(r, 20));
    runner.release(prod.id);
    await new Promise((r) => setTimeout(r, 20));
    runner.release(s2.id);
    await queue.idle(p.id);
  });

  it("with a Production and an older staging job queued, Production runs first", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    const staging = store.createStage(p.id, { name: "staging", branch: "staging", host: "" });
    const runner = gatedRunner(store);
    const queue = createBuildQueue(store, runner, createSuppliedValues());

    const running = queue.enqueue(p.id, sha("a"));
    const older = queue.enqueue(p.id, sha("b"), { stageId: staging.id });
    await new Promise((r) => setTimeout(r, 5));
    const prod = queue.enqueue(p.id, sha("c"));
    expect(store.nextQueuedJob(p.id)?.id).toBe(prod.id);

    runner.release(running.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.started).toEqual([running.id, prod.id]);
    runner.release(prod.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.started).toEqual([running.id, prod.id, older.id]);
    runner.release(older.id);
    await queue.idle(p.id);
  });

  it("picks Production's job first, then custom environments', then ephemeral ones', each oldest first", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    const staging = store.createStage(p.id, { name: "staging", branch: "staging", host: "" });
    const preview = store.createEphemeralStage(p.id, {
      branch: "feature/x",
      host: "feature-x--acme.127.0.0.1.sslip.io",
      expiresAt: "",
      label: "",
    });
    const runner = gatedRunner(store);
    const queue = createBuildQueue(store, runner, createSuppliedValues());
    const running = queue.enqueue(p.id, sha("a"));
    const pv = queue.enqueue(p.id, sha("b"), { stageId: preview.id });
    const custom = queue.enqueue(p.id, sha("c"), { stageId: staging.id });
    const prod = queue.enqueue(p.id, sha("d"));
    const tick = async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    };
    for (const id of [running.id, prod.id, custom.id]) {
      runner.release(id);
      await tick();
    }
    runner.release(pv.id);
    await queue.idle(p.id);
    expect(runner.started).toEqual([running.id, prod.id, custom.id, pv.id]);
  });
});
