// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { afterEach, describe, expect, it } from "vitest";
import { createTestMux } from "../../__tests__/test-mux.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../store/store.js";
import { wireV2 } from "../../v2.js";
import { fakeCloudSetup, fakeCloudTeardown, fakeDeploymentTrigger } from "../../testing.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-build-log-"));
  const store = createStore(join(dir, "test.db"));
  cleanups.push(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const deploys = fakeDeploymentTrigger(store);
  const v2 = wireV2(store, {
    deploymentTrigger: deploys,
    cloudSetup: fakeCloudSetup(),
    cloudTeardown: fakeCloudTeardown(),
    edgeAdminUrl: "http://127.0.0.1:1",
    edgePublicPort: 9443,
  });
  const mux = createTestMux(store, deploys, v2.queue, v2);
  const project = store.createProject("shop");
  const build = store.createBuild(project.id, "a".repeat(40));
  return { store, mux, build };
}

describe("GET /builds/{buildID}/log", () => {
  it("returns the stored log of a finished build", async () => {
    const { store, mux, build } = await setup();
    store.appendBuildLog(build.id, "one\ntwo\n");
    store.completeBuild(build.id, "succeeded");
    const res = await mux(new Request(`http://cp/builds/${build.id}/log`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("one\ntwo\n");
  });

  it("answers 404 for an unknown build", async () => {
    const { mux } = await setup();
    expect((await mux(new Request("http://cp/builds/nope/log"))).status).toBe(404);
  });

  it("from skips that many bytes", async () => {
    const { store, mux, build } = await setup();
    store.appendBuildLog(build.id, "one\ntwo\n");
    store.completeBuild(build.id, "failed", undefined, "x");
    const res = await mux(new Request(`http://cp/builds/${build.id}/log?from=4`));
    expect(await res.text()).toBe("two\n");
  });

  it("follow streams appended lines and ends when the build finishes", async () => {
    const { store, mux, build } = await setup();
    const res = await mux(new Request(`http://cp/builds/${build.id}/log?follow=1`));
    expect(res.status).toBe(200);
    const done = res.text();
    store.appendBuildLog(build.id, "first\n");
    await new Promise((r) => setTimeout(r, 700));
    store.appendBuildLog(build.id, "second\n");
    await new Promise((r) => setTimeout(r, 700));
    store.completeBuild(build.id, "succeeded");
    expect(await done).toBe("first\nsecond\n");
  }, 10000);

  it("from that is not a whole number is a 400", async () => {
    const { mux, build } = await setup();
    for (const bad of ["abc", "-1", "1.5"]) {
      const res = await mux(new Request(`http://cp/builds/${build.id}/log?from=${bad}`));
      expect(res.status).toBe(400);
    }
  });

  it("a follower that aborts stops polling the store", async () => {
    const { store, mux, build } = await setup();
    const ac = new AbortController();
    const res = await mux(new Request(`http://cp/builds/${build.id}/log?follow=1`, { signal: ac.signal }));
    const reader = res.body!.getReader();
    const pending = reader.read().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    let reads = 0;
    const real = store.getBuild.bind(store);
    store.getBuild = (id: string) => {
      reads++;
      return real(id);
    };
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
    const afterAbort = reads;
    await new Promise((r) => setTimeout(r, 1300));
    expect(reads).toBe(afterAbort);
    await pending;
  }, 10000);
});
