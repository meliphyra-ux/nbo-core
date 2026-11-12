// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, type Store } from "../store.js";
import { REVALIDATE_TOKEN_ENV, withRevalidateToken } from "../revalidate-tokens.js";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      // closed by the test
    }
  }
  vi.useRealTimers();
});

async function openStore(key: Buffer | undefined = randomBytes(32)): Promise<{ s: Store; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-revalidate-tokens-"));
  const path = join(dir, "test.db");
  const s = createStore(path, key ? { secretKey: key } : undefined);
  stores.push(s);
  return { s, path };
}

function storedColumn(path: string, stageId: string): string | undefined {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare("SELECT token FROM stage_revalidate_tokens WHERE stage_id = ?").get(stageId) as { token: string } | undefined)?.token;
  } finally {
    db.close();
  }
}

describe("revalidate tokens", () => {
  it("is NBO_PRERENDER_BYPASS", () => {
    expect(REVALIDATE_TOKEN_ENV).toBe("NBO_PRERENDER_BYPASS");
  });

  it("stores the token sealed and reads it back equal", async () => {
    const { s, path } = await openStore();
    const p = s.createProject("shop");
    const stage = s.productionStage(p.id);
    expect(s.getRevalidateToken(stage.id)).toBeUndefined();
    const t = s.ensureRevalidateToken(stage.id);
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const column = storedColumn(path, stage.id);
    expect(column).toBeDefined();
    expect(column).not.toBe(t.token);
    expect(column).not.toContain(t.token);
    expect(s.getRevalidateToken(stage.id)).toEqual(t);
  });

  it("gives two stages different tokens and ensure is stable", async () => {
    const { s } = await openStore();
    const p = s.createProject("shop");
    const prod = s.productionStage(p.id);
    const staging = s.createStage(p.id, { name: "staging", branch: "staging", host: "staging--shop.127.0.0.1.sslip.io" });
    const a = s.ensureRevalidateToken(prod.id);
    const b = s.ensureRevalidateToken(staging.id);
    expect(a.token).not.toBe(b.token);
    expect(s.ensureRevalidateToken(prod.id)).toEqual(a);
  });

  it("rotate returns a new token and moves createdAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
    const { s } = await openStore();
    const p = s.createProject("shop");
    const stage = s.productionStage(p.id);
    const first = s.ensureRevalidateToken(stage.id);
    vi.setSystemTime(new Date("2026-11-09T11:00:00Z"));
    const second = s.rotateRevalidateToken(stage.id);
    expect(second.token).not.toBe(first.token);
    expect(second.createdAt > first.createdAt).toBe(true);
    expect(s.getRevalidateToken(stage.id)).toEqual(second);
  });

  it("rotate on a stage without a token creates one", async () => {
    const { s } = await openStore();
    const p = s.createProject("shop");
    const stage = s.productionStage(p.id);
    const t = s.rotateRevalidateToken(stage.id);
    expect(s.getRevalidateToken(stage.id)).toEqual(t);
  });

  it("refuses an unknown stage", async () => {
    const { s } = await openStore();
    expect(() => s.ensureRevalidateToken("stg_nope")).toThrow();
  });

  it("counts as sealed data and is checked by verifySecretKey", async () => {
    const key = randomBytes(32);
    const { s, path } = await openStore(key);
    const p = s.createProject("shop");
    expect(s.hasSealedSecrets()).toBe(false);
    s.ensureRevalidateToken(s.productionStage(p.id).id);
    expect(s.hasSealedSecrets()).toBe(true);
    s.verifySecretKey();
    s.close();

    const wrong = createStore(path, { secretKey: randomBytes(32) });
    stores.push(wrong);
    expect(() => wrong.verifySecretKey()).toThrow();
  });

  it("deleting a custom stage removes its row", async () => {
    const { s, path } = await openStore();
    const p = s.createProject("shop");
    const staging = s.createStage(p.id, { name: "staging", branch: "staging", host: "staging--shop.127.0.0.1.sslip.io" });
    s.ensureRevalidateToken(staging.id);
    s.ensureRevalidateToken(s.productionStage(p.id).id);
    s.deleteStage(staging.id);
    expect(storedColumn(path, staging.id)).toBeUndefined();
    expect(s.getRevalidateToken(s.productionStage(p.id).id)).toBeDefined();
  });

  it("discarding an ephemeral stage removes its row", async () => {
    const { s, path } = await openStore();
    const p = s.createProject("shop");
    const pv = s.createEphemeralStage(p.id, { branch: "feature/x", host: "feature-x--shop.127.0.0.1.sslip.io", expiresAt: "", label: "" });
    s.ensureRevalidateToken(pv.id);
    s.discardEphemeralStage(pv.id);
    expect(storedColumn(path, pv.id)).toBeUndefined();
  });

  it("deleting a project removes every stage's row", async () => {
    const { s, path } = await openStore();
    const p = s.createProject("shop");
    const prod = s.productionStage(p.id);
    const staging = s.createStage(p.id, { name: "staging", branch: "staging", host: "staging--shop.127.0.0.1.sslip.io" });
    s.ensureRevalidateToken(prod.id);
    s.ensureRevalidateToken(staging.id);
    s.deleteProject(p.id);
    expect(storedColumn(path, prod.id)).toBeUndefined();
    expect(storedColumn(path, staging.id)).toBeUndefined();
  });

  it("survives turning names only on (NBO's own secret, not a variable)", async () => {
    const { s } = await openStore();
    const p = s.createProject("shop");
    const stage = s.productionStage(p.id);
    const t = s.ensureRevalidateToken(stage.id);
    s.clearStoredValues();
    expect(s.getRevalidateToken(stage.id)).toEqual(t);
  });
});

describe("withRevalidateToken", () => {
  it("adds the stage's token as a secret in a new object", async () => {
    const { s } = await openStore();
    const p = s.createProject("shop");
    const stage = s.productionStage(p.id);
    const env = { vars: { A: "1", Z: "zz" }, secretNames: ["Z"] };
    const out = withRevalidateToken(s, stage, env);
    const token = s.getRevalidateToken(stage.id)!.token;
    expect(out.vars).toEqual({ A: "1", Z: "zz", NBO_PRERENDER_BYPASS: token });
    expect(out.secretNames).toEqual(["NBO_PRERENDER_BYPASS", "Z"]);
    expect(env).toEqual({ vars: { A: "1", Z: "zz" }, secretNames: ["Z"] });
  });
});
