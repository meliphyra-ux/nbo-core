// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createCliDeployDirCache } from "../cli-deploy-dir.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakes() {
  let n = 0;
  let preparing = 0;
  let maxPreparing = 0;
  const removed: string[] = [];
  const prepare = async () => {
    preparing++;
    maxPreparing = Math.max(maxPreparing, preparing);
    await sleep(10);
    preparing--;
    return `dir${++n}`;
  };
  const remove = async (d: string) => void removed.push(d);
  return { prepare, remove, removed, prepared: () => n, maxPreparing: () => maxPreparing };
}

describe("createCliDeployDirCache", () => {
  it("prepares once for concurrent acquirers of the same build and removes the dir after the last release", async () => {
    const f = fakes();
    const cache = createCliDeployDirCache(f.prepare, f.remove);
    const [a, b] = await Promise.all([cache.acquire("/b/.nbo"), cache.acquire("/b/.nbo")]);
    expect(a.dir).toBe("dir1");
    expect(b.dir).toBe("dir1");
    expect(f.prepared()).toBe(1);
    await a.release();
    expect(f.removed).toEqual([]);
    await b.release();
    await b.release(); // idempotent
    expect(f.removed).toEqual(["dir1"]);
  });

  it("a hold keeps one build's dir alive between sequential acquirers, then the last release removes it", async () => {
    const f = fakes();
    const cache = createCliDeployDirCache(f.prepare, f.remove);
    const hold = cache.hold("/b/.nbo");
    const a = await cache.acquire("/b/.nbo");
    await a.release();
    const b = await cache.acquire("/b/.nbo");
    expect(b.dir).toBe("dir1");
    await b.release();
    expect(f.prepared()).toBe(1);
    expect(f.removed).toEqual([]);
    await hold.release();
    expect(f.removed).toEqual(["dir1"]);
  });

  it("a hold that nobody acquires under prepares nothing", async () => {
    const f = fakes();
    const cache = createCliDeployDirCache(f.prepare, f.remove);
    await cache.hold("/b/.nbo").release();
    expect(f.prepared()).toBe(0);
    expect(f.removed).toEqual([]);
  });

  it("without a hold, a later acquire prepares fresh (never reuses a removed dir)", async () => {
    const f = fakes();
    const cache = createCliDeployDirCache(f.prepare, f.remove);
    const a = await cache.acquire("/b/.nbo");
    await a.release();
    const b = await cache.acquire("/b/.nbo");
    expect(b.dir).toBe("dir2");
    await b.release();
    expect(f.removed).toEqual(["dir1", "dir2"]);
  });

  it("different builds get their own dirs, and their prepares never overlap", async () => {
    const f = fakes();
    const cache = createCliDeployDirCache(f.prepare, f.remove);
    const [a, b] = await Promise.all([cache.acquire("/one/.nbo"), cache.acquire("/two/.nbo")]);
    expect(new Set([a.dir, b.dir]).size).toBe(2);
    expect(f.maxPreparing()).toBe(1);
    await a.release();
    await b.release();
  });

  it("a failed prepare rejects every waiter and the next acquire retries", async () => {
    let calls = 0;
    const cache = createCliDeployDirCache(
      async () => {
        calls++;
        await sleep(5);
        if (calls === 1) throw new Error("pnpm build failed");
        return "ok";
      },
      async () => {},
    );
    const results = await Promise.allSettled([cache.acquire("/b/.nbo"), cache.acquire("/b/.nbo")]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    const c = await cache.acquire("/b/.nbo");
    expect(c.dir).toBe("ok");
    await c.release();
  });
});
