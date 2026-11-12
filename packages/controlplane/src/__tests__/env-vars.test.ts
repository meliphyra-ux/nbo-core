// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createStore, ErrNotFound, ErrInvalidEnvVar, type Store } from "../store.js";
import { ErrSecretKey, seal } from "../secrets.js";
import { envFingerprint, envSecretHashes, validateEnvName } from "../env-vars.js";

const openStores: Store[] = [];
afterEach(() => {
  for (const s of openStores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
});

async function openTestStore(): Promise<{ store: Store; path: string; key: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-env-"));
  const path = join(dir, "test.db");
  const key = randomBytes(32);
  const store = createStore(path, { secretKey: key });
  openStores.push(store);
  return { store, path, key };
}

const ws = { projectId: null };

describe("env var store", () => {
  it("round-trips plain and secret variables", async () => {
    const { store } = await openTestStore();
    const p = store.createProject("app");
    store.setEnv(ws, "PLAIN", "hello", false);
    store.setEnv({ projectId: p.id }, "TOKEN", "s3cret", true);
    expect(store.listWorkspaceEnv()).toEqual([expect.objectContaining({ name: "PLAIN", secret: false, value: "hello" })]);
    expect(store.resolveEnv(p.id)).toEqual({ vars: { PLAIN: "hello", TOKEN: "s3cret" }, secretNames: ["TOKEN"] });
  });

  it("keeps secret values out of the raw column and out of views", async () => {
    const { store, path } = await openTestStore();
    const p = store.createProject("app");
    const v = store.setEnv({ projectId: p.id }, "TOKEN", "s3cret-value", true);
    expect(v.value).toBeUndefined();
    expect(JSON.stringify(store.listProjectEnv(p.id))).not.toContain("s3cret-value");
    const rawDb = new DatabaseSync(path);
    let raw: { value: string };
    try {
      raw = rawDb.prepare("SELECT value FROM env_vars WHERE name = 'TOKEN'").get() as { value: string };
    } finally {
      rawDb.close();
    }
    expect(raw.value).not.toContain("s3cret-value");
    expect(raw.value.startsWith("v1:")).toBe(true);
  });

  it("lets a project variable override a workspace one in either secrecy direction", async () => {
    const { store } = await openTestStore();
    const p = store.createProject("app");
    store.setEnv(ws, "A", "ws-plain", false);
    store.setEnv(ws, "B", "ws-secret", true);
    store.setEnv({ projectId: p.id }, "A", "proj-secret", true);
    store.setEnv({ projectId: p.id }, "B", "proj-plain", false);
    expect(store.resolveEnv(p.id)).toEqual({ vars: { A: "proj-secret", B: "proj-plain" }, secretNames: ["A"] });
    const list = store.listProjectEnv(p.id);
    expect(list.map((v) => [v.name, v.inherited, v.overridden])).toEqual([
      ["A", undefined, true],
      ["B", undefined, true],
    ]);
    store.setEnv(ws, "C", "x", false);
    expect(store.listProjectEnv(p.id).find((v) => v.name === "C")).toMatchObject({ inherited: true, value: "x" });
    // another project only sees the workspace values
    const q = store.createProject("other");
    expect(store.resolveEnv(q.id)).toEqual({ vars: { A: "ws-plain", B: "ws-secret", C: "x" }, secretNames: ["B"] });
  });

  it("refuses secret to plain but allows plain to secret", async () => {
    const { store } = await openTestStore();
    store.setEnv(ws, "X", "1", false);
    expect(store.setEnv(ws, "X", "2", true)).toMatchObject({ secret: true });
    expect(() => store.setEnv(ws, "X", "3", false)).toThrow(ErrInvalidEnvVar);
  });

  it("validates names and values", async () => {
    const { store } = await openTestStore();
    for (const bad of ["", "lower", "1ABC", "A-B", "NBO_FOO", "PORT", "K_SERVICE", "K_REVISION", "K_CONFIGURATION", "A".repeat(257)]) {
      expect(validateEnvName(bad), bad).not.toBeNull();
      expect(() => store.setEnv(ws, bad, "v", false)).toThrow(ErrInvalidEnvVar);
    }
    expect(validateEnvName("_OK_1")).toBeNull();
    expect(validateEnvName("A".repeat(256))).toBeNull();
    expect(() => store.setEnv(ws, "BIG", "x".repeat(64 * 1024 + 1), false)).toThrow(ErrInvalidEnvVar);
    expect(() => store.setEnv(ws, "NUL", "a\u0000b", false)).toThrow(ErrInvalidEnvVar);
    store.setEnv(ws, "BIG", "x".repeat(64 * 1024), true);
    expect(() => store.setEnv({ projectId: "nope" }, "A", "v", false)).toThrow(ErrNotFound);
  });

  it("rejects an empty secret value; an empty plain value is fine", async () => {
    const { store } = await openTestStore();
    expect(() => store.setEnv(ws, "S", "", true)).toThrow(ErrInvalidEnvVar);
    expect(() => store.setEnv(ws, "S", "", true)).toThrow("Secret values can't be empty");
    expect(store.setEnv(ws, "P", "", false)).toMatchObject({ name: "P", value: "" });
  });

  it("deletes variables and reports missing ones", async () => {
    const { store } = await openTestStore();
    store.setEnv(ws, "A", "1", false);
    store.deleteEnv(ws, "A");
    expect(store.listWorkspaceEnv()).toEqual([]);
    expect(() => store.deleteEnv(ws, "A")).toThrow(ErrNotFound);
  });

  it("counts secret variables as sealed data", async () => {
    const { store } = await openTestStore();
    expect(store.hasSealedSecrets()).toBe(false);
    store.setEnv(ws, "A", "1", false);
    expect(store.hasSealedSecrets()).toBe(false);
    store.setEnv(ws, "S", "1", true);
    expect(store.hasSealedSecrets()).toBe(true);
    expect(() => store.verifySecretKey()).not.toThrow();
  });

  it("treats a db holding only an env secret as sealed and checks the key", async () => {
    const { store, path, key } = await openTestStore();
    store.setEnv(ws, "S", "value", true);
    store.close();
    const wrong = createStore(path, { secretKey: randomBytes(32) });
    openStores.push(wrong);
    expect(wrong.hasSealedSecrets()).toBe(true);
    expect(() => wrong.verifySecretKey()).toThrow(ErrSecretKey);
    wrong.close();
    const right = createStore(path, { secretKey: key });
    openStores.push(right);
    expect(right.hasSealedSecrets()).toBe(true);
    expect(() => right.verifySecretKey()).not.toThrow();
  });

  it("removes a project's variables with the project", async () => {
    const { store, path } = await openTestStore();
    const p = store.createProject("app");
    store.setEnv({ projectId: p.id }, "A", "1", false);
    store.setEnv(ws, "KEEP", "1", false);
    store.deleteProject(p.id);
    const rawDb = new DatabaseSync(path);
    let n: { n: number };
    try {
      n = rawDb.prepare("SELECT COUNT(*) AS n FROM env_vars WHERE project_id IS NOT NULL").get() as { n: number };
    } finally {
      rawDb.close();
    }
    expect(n.n).toBe(0);
    expect(store.listWorkspaceEnv()).toHaveLength(1);
  });
});

describe("env fingerprint", () => {
  it("is null for an empty set", async () => {
    const { store, key } = await openTestStore();
    const p = store.createProject("app");
    expect(store.envFingerprintFor(store.resolveEnv(p.id))).toBeNull();
    expect(envFingerprint({ vars: {}, secretNames: [] }, key)).toBeNull();
  });

  it("is stable, 32 hex, value-free, and changes with any value, name or flag", async () => {
    const { store, key } = await openTestStore();
    const p = store.createProject("app");
    store.setEnv({ projectId: p.id }, "A", "topsecretvalue", true);
    const f1 = store.envFingerprintFor(store.resolveEnv(p.id))!;
    expect(f1).toMatch(/^[0-9a-f]{32}$/);
    expect(store.envFingerprintFor(store.resolveEnv(p.id))).toBe(f1);
    expect(f1).toBe(envFingerprint(store.resolveEnv(p.id), key));
    expect(f1).not.toContain("topsecretvalue");

    const seen = new Set([f1]);
    const change = (fn: () => void) => {
      fn();
      const f = store.envFingerprintFor(store.resolveEnv(p.id))!;
      expect(seen.has(f)).toBe(false);
      seen.add(f);
    };
    change(() => store.setEnv({ projectId: p.id }, "A", "other", true)); // value
    change(() => store.setEnv({ projectId: p.id }, "B", "1", false)); // name added
    change(() => store.setEnv({ projectId: p.id }, "B", "1", true)); // flag only
  });

  it("depends on the secret key", () => {
    const env = { vars: { A: "1" }, secretNames: [] };
    expect(envFingerprint(env, randomBytes(32))).not.toBe(envFingerprint(env, randomBytes(32)));
  });
});

describe("secret value hashes", () => {
  it("are 32 hex per secret name only, value-free, stable, and change with the value, the name and the key", async () => {
    const { store, key } = await openTestStore();
    const p = store.createProject("app");
    store.setEnv({ projectId: p.id }, "TOKEN", "topsecretvalue", true);
    store.setEnv({ projectId: p.id }, "OTHER", "topsecretvalue", true);
    store.setEnv({ projectId: p.id }, "PLAIN", "x", false);
    const h = store.envSecretHashes(store.resolveEnv(p.id));
    expect(Object.keys(h).sort()).toEqual(["OTHER", "TOKEN"]);
    for (const v of Object.values(h)) expect(v).toMatch(/^[0-9a-f]{32}$/);
    expect(h.TOKEN).not.toBe(h.OTHER);
    expect(store.envSecretHashes(store.resolveEnv(p.id))).toEqual(h);
    expect(envSecretHashes(store.resolveEnv(p.id), key)).toEqual(h);
    expect(envSecretHashes(store.resolveEnv(p.id), randomBytes(32)).TOKEN).not.toBe(h.TOKEN);
    // Never equal to the fingerprint (different derived key).
    expect(Object.values(h)).not.toContain(store.envFingerprintFor(store.resolveEnv(p.id)));
    store.setEnv({ projectId: p.id }, "TOKEN", "changed", true);
    expect(store.envSecretHashes(store.resolveEnv(p.id)).TOKEN).not.toBe(h.TOKEN);
  });
});

describe("variables per environment", () => {
  it("resolves in the order workspace *, workspace S, project *, project S", async () => {
    const { store } = await openTestStore();
    const p = store.createProject("app");
    const proj = { projectId: p.id };
    store.setEnv(ws, "A", "ws-star", false, "*");
    store.setEnv(ws, "A", "ws-preview", false, "preview");
    store.setEnv(proj, "A", "proj-star", false, "*");
    expect(store.resolveEnv(p.id, "preview").vars.A).toBe("proj-star");
    store.setEnv(proj, "A", "proj-preview", false, "preview");
    expect(store.resolveEnv(p.id, "preview").vars.A).toBe("proj-preview");
    store.deleteEnv(proj, "A", "preview");
    store.deleteEnv(proj, "A", "*");
    expect(store.resolveEnv(p.id, "preview").vars.A).toBe("ws-preview");
    store.deleteEnv(ws, "A", "preview");
    expect(store.resolveEnv(p.id, "preview").vars.A).toBe("ws-star");
    // "*" reaches every stage.
    expect(store.resolveEnv(p.id).vars.A).toBe("ws-star");
  });

  it("takes the secret flag from the winning row", async () => {
    const { store } = await openTestStore();
    const p = store.createProject("app");
    store.setEnv(ws, "K", "plainval", false, "*");
    store.setEnv({ projectId: p.id }, "K", "sealedval", true, "preview");
    expect(store.resolveEnv(p.id, "preview")).toEqual({ vars: { K: "sealedval" }, secretNames: ["K"] });
    expect(store.resolveEnv(p.id, "development")).toEqual({ vars: { K: "plainval" }, secretNames: [] });
  });

  it("defaults to production and keeps the same name in two stages as two rows", async () => {
    const { store } = await openTestStore();
    const p = store.createProject("app");
    const proj = { projectId: p.id };
    const prod = store.setEnv(proj, "URL", "p", false);
    const prev = store.setEnv(proj, "URL", "v", false, "preview");
    expect(prod.stage).toBe("production");
    expect(prev.stage).toBe("preview");
    expect(store.listProjectEnv(p.id).map((v) => [v.name, v.stage, v.value])).toEqual([
      ["URL", "preview", "v"],
      ["URL", "production", "p"],
    ]);
    store.setEnv(proj, "URL", "p2", false); // updates only the production row
    expect(store.resolveEnv(p.id).vars.URL).toBe("p2");
    expect(store.resolveEnv(p.id, "preview").vars.URL).toBe("v");
    store.deleteEnv(proj, "URL", "preview");
    expect(store.resolveEnv(p.id, "preview").vars).toEqual({});
    expect(store.resolveEnv(p.id).vars.URL).toBe("p2");
    expect(() => store.deleteEnv(proj, "URL", "preview")).toThrow(ErrNotFound);
  });

  it("allows a project variable for a custom stage, refuses unknown stages, and refuses a workspace one for it", async () => {
    const { store } = await openTestStore();
    const p = store.createProject("app");
    store.createStage(p.id, { name: "staging", branch: "staging", host: "" });
    store.setEnv({ projectId: p.id }, "DB", "x", false, "staging");
    expect(store.resolveEnv(p.id, "staging").vars.DB).toBe("x");
    expect(store.resolveEnv(p.id).vars).toEqual({});
    expect(() => store.setEnv({ projectId: p.id }, "DB", "x", false, "nope")).toThrow(ErrNotFound);
    expect(() => store.setEnv(ws, "DB", "x", false, "staging")).toThrow(ErrInvalidEnvVar);
    expect(() => store.deleteEnv(ws, "DB", "staging")).toThrow(ErrInvalidEnvVar);
    for (const s of ["*", "production", "preview", "development"]) store.setEnv(ws, "W", "1", false, s);
  });

  it("refuses an ephemeral stage's own name: ephemeral stages use Preview's variables", async () => {
    const { store } = await openTestStore();
    const p = store.createProject("app");
    const stage = store.getStage(store.createEphemeralStage(p.id, { branch: "feature/x", host: "feature-x--app.127.0.0.1.sslip.io", expiresAt: "", label: "" }).id);
    expect(() => store.setEnv({ projectId: p.id }, "DB", "x", false, stage.name)).toThrow(ErrInvalidEnvVar);
    expect(() => store.setEnv({ projectId: p.id }, "DB", "x", false, stage.name)).toThrow(/Preview/);
    expect(() => store.deleteEnv({ projectId: p.id }, "DB", stage.name)).toThrow(ErrInvalidEnvVar);
    store.setEnv({ projectId: p.id }, "DB", "x", false, "preview");
    expect(store.resolveEnv(p.id, "preview").vars.DB).toBe("x");
  });

  it("marks inherited and overridden per stage", async () => {
    const { store } = await openTestStore();
    const p = store.createProject("app");
    store.setEnv(ws, "N", "ws", false, "preview");
    store.setEnv({ projectId: p.id }, "N", "own-prod", false);
    const list = store.listProjectEnv(p.id).map((v) => [v.name, v.stage, v.inherited === true, v.overridden === true]);
    expect(list).toEqual([
      ["N", "preview", true, false],
      ["N", "production", false, false],
    ]);
    store.setEnv({ projectId: p.id }, "N", "own-prev", false, "preview");
    expect(store.listProjectEnv(p.id).map((v) => [v.stage, v.inherited === true, v.overridden === true])).toEqual([
      ["preview", false, true],
      ["production", false, false],
    ]);
  });
});

describe("upgrade: variables from a database made before stages", () => {
  async function upgradeable(withSecrets: boolean) {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-env-up-"));
    const path = join(dir, "test.db");
    const db = new DatabaseSync(path);
    db.exec(readFileSync(new URL("./fixtures/pre-stages.sql", import.meta.url), "utf8"));
    const key = randomBytes(32);
    if (withSecrets) {
      const ins = db.prepare("INSERT INTO env_vars (project_id, name, value, secret, updated_at) VALUES (?, ?, ?, 1, '2026-11-08T00:00:00.000Z')");
      ins.run(null, "WS_SECRET", seal(key, "ws-secret-value"));
      ins.run("proj_88e4ac33bff00c55", "DB_PASS", seal(key, "pw-123456"));
    }
    db.close();
    return { path, key };
  }

  it("resolves Production to the same variables and fingerprint, and Preview to nothing", async () => {
    const { path, key } = await upgradeable(true);
    const expected = {
      vars: { API_URL: "https://shop-api.example", WS_SECRET: "ws-secret-value", DB_PASS: "pw-123456" },
      secretNames: ["DB_PASS", "WS_SECRET"],
    };
    const store = createStore(path, { secretKey: key });
    openStores.push(store);
    store.verifySecretKey();
    const shop = store.listProjects().find((p) => p.name === "shop")!;
    const blog = store.listProjects().find((p) => p.name === "blog")!;
    const resolved = store.resolveEnv(shop.id);
    expect(resolved).toEqual(expected);
    expect(store.envFingerprintFor(resolved)).toBe(envFingerprint(expected, key));
    expect(store.resolveEnv(shop.id, "preview")).toEqual({ vars: {}, secretNames: [] });
    expect(store.resolveEnv(shop.id, "development")).toEqual({ vars: {}, secretNames: [] });
    // The other project sees the workspace values only.
    expect(store.resolveEnv(blog.id)).toEqual({
      vars: { API_URL: "https://api.example", WS_SECRET: "ws-secret-value" },
      secretNames: ["WS_SECRET"],
    });
    expect(store.listProjectEnv(shop.id).every((v) => v.stage === "production")).toBe(true);
    // Every row kept, all production; the old unique index is gone, the new one exists.
    const raw = new DatabaseSync(path);
    try {
      expect((raw.prepare("SELECT COUNT(*) AS n FROM env_vars WHERE stage = 'production'").get() as { n: number }).n).toBe(4);
      const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'env_vars'").all() as { name: string }[]).map((i) => i.name);
      expect(idx).toContain("env_vars_scope_stage_name");
      expect(idx).not.toContain("env_vars_scope_name");
    } finally {
      raw.close();
    }
  });

  it("opens again unchanged and accepts the same name in two stages", async () => {
    const { path, key } = await upgradeable(false);
    createStore(path, { secretKey: key }).close();
    const store = createStore(path, { secretKey: key });
    openStores.push(store);
    const shop = store.listProjects().find((p) => p.name === "shop")!;
    expect(store.resolveEnv(shop.id).vars).toEqual({ API_URL: "https://shop-api.example" });
    store.setEnv({ projectId: shop.id }, "API_URL", "https://preview.example", false, "preview");
    expect(store.resolveEnv(shop.id, "preview").vars).toEqual({ API_URL: "https://preview.example" });
    expect(store.resolveEnv(shop.id).vars).toEqual({ API_URL: "https://shop-api.example" });
  });
});
