// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, type Store } from "../../store/store.js";
import { ErrSecretKey } from "../../store/secrets.js";
import { createLinkKeys } from "../keys.js";
import type { LinkStateInput } from "../link-store.js";

let dir: string;
let dbPath: string;
let key: Buffer;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nbo-link-store-"));
  dbPath = join(dir, "test.db");
  key = randomBytes(32);
  store = createStore(dbPath, { secretKey: key });
});
afterEach(async () => {
  try {
    store.close();
  } catch {
    // already closed
  }
  await rm(dir, { recursive: true, force: true });
});

async function stateInput(): Promise<{ input: LinkStateInput; keys: Awaited<ReturnType<typeof createLinkKeys>> }> {
  const keys = await createLinkKeys();
  return {
    keys,
    input: {
      coreId: "core_1",
      teamId: "team_1",
      linkUrl: "https://platform.example.test/link",
      linkHost: "platform.example.test",
      platformKeyId: "pk_1",
      platformKey: "PLATFORMKEY",
      identityPublic: keys.identityPublic,
      identityPkcs8: keys.identityPkcs8,
      encryptionPublic: keys.encryptionPublic,
      encryptionPkcs8: keys.encryptionPkcs8,
      highSeq: 0,
      enrolledAt: "2026-11-13T00:00:00.000Z",
    },
  };
}

const entry = (id: string, seq: number, nonce: string, at: string) => ({
  id,
  at,
  seq,
  nonce,
  tier: 1,
  method: "POST",
  route: "/x",
  signedBy: "pk_1",
  status: 200,
  reason: "",
  accepted: true,
});

describe("link store", () => {
  it("a fresh store has no link state and no sealed link rows", () => {
    expect(store.getLinkState()).toBeNull();
    expect(store.openLinkKeys()).toBeNull();
    expect(store.listMemberKeys()).toEqual([]);
    expect(store.hasSealedSecrets()).toBe(false);
  });

  it("saved keys open with the secret key and hasSealedSecrets turns true", async () => {
    const { input, keys } = await stateInput();
    store.saveLinkState(input);
    expect(store.hasSealedSecrets()).toBe(true);
    const s = store.getLinkState()!;
    expect(s.coreId).toBe("core_1");
    expect(s.identityPublic).toBe(keys.identityPublic);
    expect(JSON.stringify(s)).not.toContain(keys.identityPkcs8);
    expect(store.openLinkKeys()).toEqual({ identityPkcs8: keys.identityPkcs8, encryptionPkcs8: keys.encryptionPkcs8 });
  });

  it("verifySecretKey fails with another key once link keys are sealed", async () => {
    const { input } = await stateInput();
    store.saveLinkState(input);
    store.close();
    const other = createStore(dbPath, { secretKey: randomBytes(32) });
    expect(() => other.verifySecretKey()).toThrow(ErrSecretKey);
    other.close();
    store = createStore(dbPath, { secretKey: key });
    expect(() => store.verifySecretKey()).not.toThrow();
  });

  it("platform key and high sequence update in place", async () => {
    const { input } = await stateInput();
    store.saveLinkState(input);
    store.setPlatformKey("pk_2", "NEWKEY");
    store.setHighSeq(41);
    const s = store.getLinkState()!;
    expect([s.platformKeyId, s.platformKey, s.highSeq]).toEqual(["pk_2", "NEWKEY", 41]);
  });

  it("member keys add, get, list and remove", () => {
    const k = store.addMemberKey({ keyId: "fp1", memberId: "m1", role: "admin", publicKey: "PUB", addedBy: "m0" });
    expect(k.keyId).toBe("fp1");
    expect(k.addedAt).toMatch(/^\d{4}-/);
    expect(store.getMemberKey("fp1")?.memberId).toBe("m1");
    expect(store.listMemberKeys()).toHaveLength(1);
    store.removeMemberKey("fp1");
    expect(store.getMemberKey("fp1")).toBeUndefined();
  });

  it("clearLink keeps the journal", async () => {
    const { input } = await stateInput();
    store.saveLinkState(input);
    store.addMemberKey({ keyId: "fp1", memberId: "m1", role: "admin", publicKey: "PUB", addedBy: "m0" });
    store.createResetCode("h1", "sha256:k1", "2999-01-01T00:00:00.000Z");
    store.appendJournal(entry("i1", 1, "n1", "2026-11-13T00:00:00.000Z"));
    store.clearLink();
    expect(store.getLinkState()).toBeNull();
    expect(store.listMemberKeys()).toEqual([]);
    expect(store.useResetCode("h1", new Date("2026-11-13T00:00:00Z"))).toBeNull();
    expect(store.listJournal({ limit: 10 })).toHaveLength(1);
    expect(store.hasSealedSecrets()).toBe(false);
  });

  it("a reset code is usable once, not after expiry, and names the key it is for", () => {
    store.createResetCode("h1", "sha256:k1", "2026-11-13T01:00:00.000Z");
    store.createResetCode("h2", "sha256:k2", "2026-11-13T01:00:00.000Z");
    expect(store.useResetCode("h1", new Date("2026-11-13T00:30:00Z"))).toBe("sha256:k1");
    expect(store.useResetCode("h1", new Date("2026-11-13T00:30:01Z"))).toBeNull();
    expect(store.useResetCode("h2", new Date("2026-11-13T01:00:01Z"))).toBeNull();
    expect(store.useResetCode("nope", new Date("2026-11-13T00:30:00Z"))).toBeNull();
  });

  it("a reset code made before codes named a key can't be used", () => {
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec(
      "DROP TABLE link_reset_codes; CREATE TABLE link_reset_codes (code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT);",
    );
    raw
      .prepare(
        "INSERT INTO link_reset_codes (code_hash, expires_at, used_at) VALUES ('old', '2999-01-01T00:00:00.000Z', NULL)",
      )
      .run();
    raw.close();
    store = createStore(dbPath, { secretKey: key });
    expect(store.useResetCode("old", new Date("2026-11-13T00:30:00Z"))).toBeNull();
    store.createResetCode("h3", "sha256:k3", "2999-01-01T00:00:00.000Z");
    expect(store.useResetCode("h3", new Date("2026-11-13T00:30:00Z"))).toBe("sha256:k3");
  });

  it("journalHas finds a seq and a nonce", () => {
    store.appendJournal(entry("i1", 7, "n7", "2026-11-13T00:00:00.000Z"));
    expect(store.journalHas(7, "other")).toBe(true);
    expect(store.journalHas(8, "n7")).toBe(true);
    expect(store.journalHas(8, "n8")).toBe(false);
  });

  it("journalHas counts a seq only under the link it was accepted on; a nonce counts across links", async () => {
    const { input } = await stateInput();
    store.saveLinkState(input);
    store.appendJournal(entry("i1", 7, "n7", "2026-11-13T00:00:00.000Z"));
    expect(store.journalHas(7, "other")).toBe(true);
    store.clearLink();
    store.saveLinkState({ ...input, coreId: "core_2" });
    expect(store.journalHas(7, "other")).toBe(false);
    expect(store.journalHas(8, "n7")).toBe(true);
  });

  it("a refused entry with seq N and nonce X does not make journalHas(N, X) true", () => {
    store.appendJournal({
      ...entry("r1", 9, "n9", "2026-11-13T00:00:00.000Z"),
      accepted: false,
      status: 400,
      reason: "expired",
    });
    expect(store.journalHas(9, "n9")).toBe(false);
    expect(store.journalHas(9, "x")).toBe(false);
    expect(store.journalHas(1, "n9")).toBe(false);
  });

  it("journaling a refused replay of an accepted instruction (same id, seq, nonce) does not throw and both rows list", () => {
    store.appendJournal(entry("i1", 5, "n5", "2026-11-13T00:00:01.000Z"));
    expect(() =>
      store.appendJournal({
        ...entry("i1", 5, "n5", "2026-11-13T00:00:02.000Z"),
        accepted: false,
        status: 409,
        reason: "replay",
      }),
    ).not.toThrow();
    expect(store.listJournal({ limit: 10 })).toHaveLength(2);
    expect(store.journalHas(5, "n5")).toBe(true);
  });

  it("a message with no instruction id can be journaled", () => {
    store.appendJournal({
      ...entry("x", 1, "n1", "2026-11-13T00:00:01.000Z"),
      id: null,
      accepted: false,
      status: 400,
      reason: "bad",
    });
    expect(store.listJournal({ limit: 1 })[0]!.id).toBeNull();
  });

  it("setPlatformKey and setHighSeq refuse when the core is not linked", () => {
    expect(() => store.setPlatformKey("k", "K")).toThrow("this core is not linked");
    expect(() => store.setHighSeq(1)).toThrow("this core is not linked");
  });

  it("listJournal pages newest first with before", () => {
    store.appendJournal(entry("i1", 1, "n1", "2026-11-13T00:00:01.000Z"));
    store.appendJournal(entry("i2", 2, "n2", "2026-11-13T00:00:02.000Z"));
    store.appendJournal(entry("i3", 3, "n3", "2026-11-13T00:00:03.000Z"));
    expect(store.listJournal({ limit: 2 }).map((e) => e.id)).toEqual(["i3", "i2"]);
    expect(store.listJournal({ limit: 5, before: "2026-11-13T00:00:03.000Z" }).map((e) => e.id)).toEqual(["i2", "i1"]);
  });

  it("pruneJournal removes rows older than the date only", () => {
    store.appendJournal(entry("old", 1, "n1", "2026-01-01T00:00:00.000Z"));
    store.appendJournal(entry("new", 2, "n2", "2026-11-01T00:00:00.000Z"));
    expect(store.pruneJournal(new Date("2026-06-01T00:00:00Z"))).toBe(1);
    expect(store.listJournal({ limit: 10 }).map((e) => e.id)).toEqual(["new"]);
  });

  it("a database made before this task migrates without loss", () => {
    const p = store.createProject("shop");
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec(
      "DROP TABLE link_state; DROP TABLE link_member_keys; DROP TABLE link_journal; DROP TABLE link_reset_codes;",
    );
    const before = (raw.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    raw.close();
    store = createStore(dbPath, { secretKey: key });
    expect(store.listProjects()).toHaveLength(before);
    expect(store.getProject(p.id).name).toBe("shop");
    expect(store.getLinkState()).toBeNull();
  });
});
