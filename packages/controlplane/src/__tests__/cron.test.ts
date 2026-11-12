// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../store.js";
import { signCron, nextRun } from "../cron.js";

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
  const dir = await mkdtemp(join(tmpdir(), "controlplane-cron-"));
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

function cronFixture(id: string, schedule: string, extra?: Record<string, unknown>) {
  return { id, schedule, target: { function: "ssr", path: `/api/cron/${id}`, method: "POST" }, overlap: "skip", timeoutSec: 60, ...extra };
}

async function writeCronManifest(crons: Record<string, unknown>[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-cron-manifest-"));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0", crons }));
  return dir;
}

describe("nextRun", () => {
  it("* matches anything", () => {
    const after = new Date("2026-01-01T00:00:00Z");
    expect(nextRun("* * * * *", after)).toEqual(new Date("2026-01-01T00:01:00Z"));
  });

  it("a single number matches exactly", () => {
    const after = new Date("2026-01-01T00:00:00Z");
    expect(nextRun("0 3 * * *", after)).toEqual(new Date("2026-01-01T03:00:00Z"));
  });

  it("a comma list matches any, advancing correctly on a second call", () => {
    const after = new Date("2026-01-01T00:00:00Z");
    const first = nextRun("0 3,15 * * *", after);
    expect(first).toEqual(new Date("2026-01-01T03:00:00Z"));
    expect(nextRun("0 3,15 * * *", first)).toEqual(new Date("2026-01-01T15:00:00Z"));
  });

  it("a */N step matches every Nth", () => {
    const after = new Date("2026-01-01T00:00:00Z");
    expect(nextRun("*/15 * * * *", after)).toEqual(new Date("2026-01-01T00:15:00Z"));
  });

  // Day-of-month starts at 1, not 0 — */5 must mean "every 5th day
  // starting from day 1" (1, 6, 11, 16, 21, 26, 31), not day 0 (which
  // doesn't exist) or an off-by-one set.
  it("a day-of-month step respects its own 1-based minimum", () => {
    const after = new Date("2026-01-01T00:01:00Z");
    expect(nextRun("0 0 */5 * *", after)).toEqual(new Date("2026-01-06T00:00:00Z"));
  });

  it("an invalid field names itself in the error", () => {
    expect(() => nextRun("60 * * * *", new Date())).toThrow(/minute/);
  });

  it("an unreachable schedule fails rather than looping forever", () => {
    expect(() => nextRun("0 0 30 2 *", new Date())).toThrow();
  });
});

describe("signCron", () => {
  it("is deterministic for the same inputs", () => {
    expect(signCron("secret", "nightly-sync", 1700000000)).toBe(signCron("secret", "nightly-sync", 1700000000));
  });

  it("changes with a different secret, cron id, or timestamp", () => {
    const base = signCron("secret", "nightly-sync", 1700000000);
    expect(signCron("other-secret", "nightly-sync", 1700000000)).not.toBe(base);
    expect(signCron("secret", "other-id", 1700000000)).not.toBe(base);
    expect(signCron("secret", "nightly-sync", 1700000001)).not.toBe(base);
  });
});

describe("registerCronsFromManifest", () => {
  it("registers each cron", async () => {
    const s = await openTestStore();
    const proj = s.createProject("acme");
    const env = s.createEnvironment(proj.id, "production", "kubernetes");
    const dir = await writeCronManifest([cronFixture("a", "0 3 * * *"), cronFixture("b", "0 * * * *")]);

    s.registerCronsFromManifest(env.id, dir);
    const rows = s.dueCrons(new Date("2099-01-01T00:00:00Z"));
    expect(rows).toHaveLength(2);
  });

  it("removing a cron from the manifest deletes its row", async () => {
    const s = await openTestStore();
    const proj = s.createProject("acme");
    const env = s.createEnvironment(proj.id, "production", "kubernetes");
    const dir = await writeCronManifest([cronFixture("a", "0 3 * * *"), cronFixture("b", "0 * * * *")]);
    s.registerCronsFromManifest(env.id, dir);

    const dir2 = await writeCronManifest([cronFixture("a", "0 3 * * *")]);
    s.registerCronsFromManifest(env.id, dir2);

    const rows = s.dueCrons(new Date("2099-01-01T00:00:00Z"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cronId).toBe("a");
  });

  it("rejects a non-UTC timezone", async () => {
    const s = await openTestStore();
    const proj = s.createProject("acme");
    const env = s.createEnvironment(proj.id, "production", "kubernetes");
    const dir = await writeCronManifest([cronFixture("a", "0 3 * * *", { timezone: "America/New_York" })]);

    expect(() => s.registerCronsFromManifest(env.id, dir)).toThrow(/UTC/);
  });

  it("accepts an explicit UTC timezone", async () => {
    const s = await openTestStore();
    const proj = s.createProject("acme");
    const env = s.createEnvironment(proj.id, "production", "kubernetes");
    const dir = await writeCronManifest([cronFixture("a", "0 3 * * *", { timezone: "UTC" })]);

    expect(() => s.registerCronsFromManifest(env.id, dir)).not.toThrow();
  });
});

describe("claimCron", () => {
  it("a second claim fails until released", async () => {
    const s = await openTestStore();
    const proj = s.createProject("acme");
    const env = s.createEnvironment(proj.id, "production", "kubernetes");
    const dir = await writeCronManifest([cronFixture("a", "0 3 * * *")]);
    s.registerCronsFromManifest(env.id, dir);

    expect(s.claimCron(env.id, "a")).toBe(true);
    expect(s.claimCron(env.id, "a")).toBe(false);

    s.releaseCron(env.id, "a", new Date(), new Date(Date.now() + 3600_000));
    expect(s.claimCron(env.id, "a")).toBe(true);
  });
});

describe("cron signing secret", () => {
  it("round-trips", async () => {
    const s = await openTestStore();
    const proj = s.createProject("acme");
    const env = s.createEnvironment(proj.id, "production", "kubernetes");

    expect(() => s.getCronSigningSecret(env.id)).toThrow();
    s.setCronSigningSecret(env.id, "my-secret");
    expect(s.getCronSigningSecret(env.id)).toBe("my-secret");
  });

  it("generates once and stays stable", async () => {
    const s = await openTestStore();
    const proj = s.createProject("acme");
    const env = s.createEnvironment(proj.id, "production", "kubernetes");

    const first = s.ensureCronSigningSecret(env.id);
    expect(first).not.toBe("");
    expect(s.ensureCronSigningSecret(env.id)).toBe(first);
  });
});

describe("dueCrons", () => {
  it("only returns crons due by now", async () => {
    const s = await openTestStore();
    const proj = s.createProject("acme");
    const env = s.createEnvironment(proj.id, "production", "kubernetes");
    const dir = await writeCronManifest([cronFixture("a", "0 0 1 1 *")]); // once a year, Jan 1
    s.registerCronsFromManifest(env.id, dir);

    expect(s.dueCrons(new Date("2026-01-01T00:00:00Z"))).toHaveLength(0);
    expect(s.dueCrons(new Date("2027-01-01T00:00:00Z"))).toHaveLength(1);
  });
});
