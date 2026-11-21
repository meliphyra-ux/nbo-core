// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createStore, ErrDuplicateName, ErrNotFound, type Store } from "../../store/store.js";
import { ErrSecretKey, seal } from "../../store/secrets.js";
import { baseSchema } from "../../store/store.js";
import { gitSchema } from "../../git/git.js";
import { kubeConnectionsSchema, legacyConnectionsSchema, reservedClusterName } from "../connections.js";

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

async function openTestStore(withKey = true): Promise<{ store: Store; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-conn-"));
  const path = join(dir, "test.db");
  const store = createStore(path, withKey ? { secretKey: randomBytes(32) } : undefined);
  openStores.push(store);
  return { store, path };
}

const google = { project: "my-proj", region: "us-central1", arRepo: "nbo", deployer: "d@x.iam", puller: "p@x.iam" };
const k8s = {
  name: "prod",
  server: "https://k8s.example:6443",
  registry: { kind: "custom" as const, server: "ghcr.io", username: "me" },
};

describe("connections store", () => {
  it("round-trips a google connection and its secrets", async () => {
    const { store } = await openTestStore();
    expect(store.getGoogleConnection()).toBeNull();
    const saved = store.saveGoogleConnection(google, { deployerKey: '{"a":1}', pullerKey: '{"b":2}' });
    expect(saved).toMatchObject({ kind: "google", ...google, status: "connected", lastChecked: "", lastError: "" });
    expect(saved.createdAt).not.toBe("");
    expect(store.getGoogleConnection()).toEqual(saved);
    expect(store.getGoogleSecrets()).toEqual({ deployerKey: '{"a":1}', pullerKey: '{"b":2}' });
  });

  it("round-trips a kubernetes connection by id and keeps the secret encrypted at rest", async () => {
    const { store, path } = await openTestStore();
    const saved = store.saveKubernetesConnection(k8s, {
      kubeconfig: "SUPER-SECRET-KUBECONFIG",
      registryPassword: "hunter2",
    });
    expect(saved).toMatchObject({ kind: "kubernetes", ...k8s, status: "connected" });
    expect(saved.id).toMatch(/^kc_[0-9a-f]{16}$/);
    expect(store.getKubernetesConnection(saved.id)).toEqual(saved);
    expect(store.listKubernetesConnections()).toEqual([saved]);
    expect(store.getKubernetesSecrets(saved.id)).toEqual({
      kubeconfig: "SUPER-SECRET-KUBECONFIG",
      registryPassword: "hunter2",
    });

    const raw = new DatabaseSync(path);
    const rows = raw.prepare("SELECT config, secret FROM kube_connections").all() as {
      config: string;
      secret: string;
    }[];
    raw.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.secret).not.toContain("SUPER-SECRET-KUBECONFIG");
    expect(rows[0]!.secret).not.toContain("hunter2");
    expect(rows[0]!.config).not.toContain("SUPER-SECRET-KUBECONFIG");
  });

  it("keeps several clusters, each with its own secrets", async () => {
    const { store } = await openTestStore();
    const a = store.saveKubernetesConnection(k8s, { kubeconfig: "one" });
    const b = store.saveKubernetesConnection({ ...k8s, name: "hetzner-eu" }, { kubeconfig: "two" });
    expect(a.id).not.toBe(b.id);
    expect(store.listKubernetesConnections().map((c) => c.name)).toEqual(["prod", "hetzner-eu"]);
    expect(store.getKubernetesSecrets(a.id).kubeconfig).toBe("one");
    expect(store.getKubernetesSecrets(b.id).kubeconfig).toBe("two");
  });

  it("replaces a connection's credentials when saved with its id", async () => {
    const { store } = await openTestStore();
    const a = store.saveKubernetesConnection(k8s, { kubeconfig: "one" });
    store.recordConnectionCheck("kubernetes", "boom", a.id);
    const replaced = store.saveKubernetesConnection(
      { ...k8s, id: a.id, server: "https://new:6443" },
      { kubeconfig: "two" },
    );
    expect(replaced).toMatchObject({
      id: a.id,
      name: "prod",
      server: "https://new:6443",
      status: "connected",
      lastError: "",
    });
    expect(store.listKubernetesConnections()).toHaveLength(1);
    expect(store.getKubernetesSecrets(a.id).kubeconfig).toBe("two");
    expect(() => store.saveKubernetesConnection({ ...k8s, id: "kc_missing" }, { kubeconfig: "x" })).toThrow(
      ErrNotFound,
    );
  });

  it("refuses a duplicate or malformed cluster name", async () => {
    const { store } = await openTestStore();
    store.saveKubernetesConnection(k8s, { kubeconfig: "one" });
    expect(() => store.saveKubernetesConnection(k8s, { kubeconfig: "two" })).toThrow(ErrDuplicateName);
    for (const name of ["", "Prod", "a_b", "-a", "a-", "x".repeat(31)]) {
      expect(() => store.saveKubernetesConnection({ ...k8s, name }, { kubeconfig: "x" })).toThrow(/name/);
    }
    expect(store.listKubernetesConnections()).toHaveLength(1);
  });

  // k8s-isr's app would be named like k8s's ISR cache (<app>-isr).
  it("refuses new clusters named isr or ending in -isr, but keeps updating one connected earlier", async () => {
    const { store, path } = await openTestStore();
    // One connected before the rule: its setup can still be replaced.
    const old = store.saveKubernetesConnection({ ...k8s, name: "old" }, { kubeconfig: "x" });
    const db = new DatabaseSync(path);
    db.prepare("UPDATE kube_connections SET name = 'old-isr' WHERE id = ?").run(old.id);
    db.close();
    expect(store.saveKubernetesConnection({ ...k8s, name: "old-isr", id: old.id }, { kubeconfig: "y" }).name).toBe(
      "old-isr",
    );
    for (const name of ["isr", "prod-isr"]) {
      expect(() => store.saveKubernetesConnection({ ...k8s, name }, { kubeconfig: "x" })).toThrow(/isr/);
    }
    expect(store.listKubernetesConnections()).toHaveLength(1);
    expect(store.saveKubernetesConnection({ ...k8s, name: "isrx" }, { kubeconfig: "x" }).name).toBe("isrx");
    expect(store.saveKubernetesConnection({ ...k8s, name: "my-isr2" }, { kubeconfig: "x" }).name).toBe("my-isr2");
    expect(reservedClusterName("isr")).toBe(true);
    expect(reservedClusterName("a-isr")).toBe(true);
    expect(reservedClusterName("isra")).toBe(false);
  });

  it("records checks and deletes per cluster", async () => {
    const { store } = await openTestStore();
    const a = store.saveKubernetesConnection(k8s, { kubeconfig: "one" });
    const b = store.saveKubernetesConnection({ ...k8s, name: "b" }, { kubeconfig: "two" });
    store.recordConnectionCheck("kubernetes", "Unauthorized", b.id);
    expect(store.getKubernetesConnection(a.id)!.status).toBe("connected");
    expect(store.getKubernetesConnection(b.id)).toMatchObject({ status: "failing", lastError: "Unauthorized" });
    store.deleteKubernetesConnection(b.id);
    expect(store.getKubernetesConnection(b.id)).toBeNull();
    expect(store.listKubernetesConnections().map((c) => c.id)).toEqual([a.id]);
  });

  it("lists the live environments on one cluster", async () => {
    const { store } = await openTestStore();
    const a = store.saveKubernetesConnection(k8s, { kubeconfig: "one" });
    const b = store.saveKubernetesConnection({ ...k8s, name: "b" }, { kubeconfig: "two" });
    const p = store.createProject("web");
    const onA = store.createEnvironment(p.id, "k8s", "kubernetes", JSON.stringify({ clusterId: a.id }));
    const old = store.createEnvironment(p.id, "k8s-b", "kubernetes", JSON.stringify({ clusterId: b.id }));
    store.archiveEnvironment(old.id);
    store.createEnvironment(p.id, "run", "cloudrun", JSON.stringify({ clusterId: b.id }));
    expect(store.environmentsUsingCluster(a.id)).toEqual([{ projectName: "web", environmentId: onA.id }]);
    expect(store.environmentsUsingCluster(b.id)).toEqual([]);
  });

  it("throws ErrNotFound for secrets of a missing connection", async () => {
    const { store } = await openTestStore();
    expect(() => store.getGoogleSecrets()).toThrow(ErrNotFound);
    expect(() => store.getKubernetesSecrets("kc_nope")).toThrow(ErrNotFound);
  });

  it("records check results", async () => {
    const { store } = await openTestStore();
    store.saveGoogleConnection(google, { deployerKey: "a", pullerKey: "b" });
    store.recordConnectionCheck("google", "boom");
    expect(store.getGoogleConnection()).toMatchObject({ status: "failing", lastError: "boom" });
    expect(store.getGoogleConnection()!.lastChecked).not.toBe("");
    store.recordConnectionCheck("google", null);
    expect(store.getGoogleConnection()).toMatchObject({ status: "connected", lastError: "" });
  });

  it("deletes a connection", async () => {
    const { store } = await openTestStore();
    store.saveGoogleConnection(google, { deployerKey: "a", pullerKey: "b" });
    store.deleteConnection("google");
    expect(store.getGoogleConnection()).toBeNull();
    expect(store.hasSealedSecrets()).toBe(false);
  });

  it("lists non-archived environments using Google", async () => {
    const { store } = await openTestStore();
    const p = store.createProject("web");
    const live = store.createEnvironment(p.id, "run", "cloudrun");
    const old = store.createEnvironment(p.id, "old", "cloudrun");
    store.createEnvironment(p.id, "k8s", "kubernetes");
    store.archiveEnvironment(old.id);
    expect(store.environmentsUsing("google")).toEqual([{ projectName: "web", environmentId: live.id }]);
  });

  it("hasSealedSecrets is false when empty and true after save", async () => {
    const { store } = await openTestStore();
    expect(store.hasSealedSecrets()).toBe(false);
    store.saveKubernetesConnection(k8s, { kubeconfig: "x" });
    expect(store.hasSealedSecrets()).toBe(true);
  });

  it("verifySecretKey rejects a store sealed with a different key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-conn-"));
    const path = join(dir, "test.db");
    const keyA = randomBytes(32);
    const a = createStore(path, { secretKey: keyA });
    a.saveKubernetesConnection(k8s, { kubeconfig: "x" });
    a.close();
    const b = createStore(path, { secretKey: randomBytes(32) });
    openStores.push(b);
    expect(() => b.verifySecretKey()).toThrow(ErrSecretKey);
    b.setSecretKey(keyA);
    expect(() => b.verifySecretKey()).not.toThrow();
  });

  it("throws ErrSecretKey without a key, and works after setSecretKey", async () => {
    const { store } = await openTestStore(false);
    expect(() => store.saveKubernetesConnection(k8s, { kubeconfig: "x" })).toThrow(ErrSecretKey);
    store.setSecretKey(randomBytes(32));
    const c = store.saveKubernetesConnection(k8s, { kubeconfig: "x" });
    expect(store.getKubernetesSecrets(c.id).kubeconfig).toBe("x");
  });
});

describe("migrating the single Kubernetes connection", () => {
  // A database from before multiple clusters: one kind=kubernetes row.
  async function oldDb(opts: { kube: boolean }): Promise<{ path: string; key: Buffer; secret: string }> {
    const key = randomBytes(32);
    const dir = await mkdtemp(join(tmpdir(), "controlplane-conn-mig-"));
    const path = join(dir, "test.db");
    const db = new DatabaseSync(path);
    db.exec(baseSchema);
    db.exec(gitSchema);
    db.exec(legacyConnectionsSchema);
    const secret = seal(key, JSON.stringify({ kubeconfig: "OLD-KUBECONFIG" }));
    if (opts.kube) {
      db.prepare(
        "INSERT INTO connections (kind, config, secret, status, last_checked, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "kubernetes",
        JSON.stringify({ name: "prod", server: "https://k8s.example:6443", registry: { kind: "artifact-registry" } }),
        secret,
        "failing",
        "2026-11-01T00:00:00Z",
        "Unauthorized",
        "2026-10-01T00:00:00Z",
      );
    }
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_1', 'acme', '2026-01-01T00:00:00Z')").run();
    const insertEnv = db.prepare(
      "INSERT INTO environments (id, project_id, name, target, config, created_at) VALUES (?, 'proj_1', ?, ?, ?, '2026-01-01T00:00:00Z')",
    );
    insertEnv.run("env_k", "k8s", "kubernetes", JSON.stringify({ cronsEnabled: true }));
    insertEnv.run("env_c", "cloudrun", "cloudrun", JSON.stringify({ project: "p" }));
    db.close();
    return { path, key, secret };
  }

  it("moves the row to kc_default named default and links Kubernetes environments to it", async () => {
    const { path, key, secret } = await oldDb({ kube: true });
    const store = createStore(path);
    openStores.push(store);
    expect(store.listKubernetesConnections()).toEqual([
      {
        kind: "kubernetes",
        id: "kc_default",
        name: "default",
        server: "https://k8s.example:6443",
        registry: { kind: "artifact-registry" },
        status: "failing",
        lastChecked: "2026-11-01T00:00:00Z",
        lastError: "Unauthorized",
        createdAt: "2026-10-01T00:00:00Z",
        lbLocationSaved: false,
      },
    ]);
    expect(JSON.parse(store.getEnvironment("env_k").config)).toEqual({ cronsEnabled: true, clusterId: "kc_default" });
    expect(JSON.parse(store.getEnvironment("env_c").config)).toEqual({ project: "p" });
    expect(store.hasSealedSecrets()).toBe(true);
    store.setSecretKey(key);
    expect(() => store.verifySecretKey()).not.toThrow();
    expect(store.getKubernetesSecrets("kc_default").kubeconfig).toBe("OLD-KUBECONFIG");
    const raw = new DatabaseSync(path);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM connections WHERE kind = 'kubernetes'").get()).toEqual({ n: 0 });
    expect((raw.prepare("SELECT secret FROM kube_connections").get() as { secret: string }).secret).toBe(secret);
    raw.close();
  });

  it("is idempotent across restarts", async () => {
    const { path } = await oldDb({ kube: true });
    createStore(path).close();
    const store = createStore(path);
    openStores.push(store);
    expect(store.listKubernetesConnections().map((c) => c.id)).toEqual(["kc_default"]);
    expect(JSON.parse(store.getEnvironment("env_k").config)).toEqual({ cronsEnabled: true, clusterId: "kc_default" });
  });

  it("leaves environments alone when no Kubernetes connection existed (dev mode)", async () => {
    const { path } = await oldDb({ kube: false });
    const store = createStore(path);
    openStores.push(store);
    expect(store.listKubernetesConnections()).toEqual([]);
    expect(JSON.parse(store.getEnvironment("env_k").config)).toEqual({ cronsEnabled: true });
  });
});

describe("migrating the single Kubernetes connection: edge cases", () => {
  const oldRow = (db: DatabaseSync, secret: string) =>
    db
      .prepare(
        "INSERT INTO connections (kind, config, secret, status, created_at) VALUES ('kubernetes', ?, ?, 'connected', '2026-10-01T00:00:00Z')",
      )
      .run(JSON.stringify({ name: "prod", server: "https://k", registry: { kind: "artifact-registry" } }), secret);

  async function freshDb(): Promise<{ path: string; db: DatabaseSync }> {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-conn-mig2-"));
    const path = join(dir, "test.db");
    const db = new DatabaseSync(path);
    db.exec(baseSchema);
    db.exec(gitSchema);
    db.exec(legacyConnectionsSchema);
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_1', 'acme', '2026-01-01T00:00:00Z')").run();
    return { path, db };
  }

  it("links archived Kubernetes environments too", async () => {
    const { path, db } = await freshDb();
    db.exec("ALTER TABLE environments ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    oldRow(db, "v1:x:y:z");
    db.prepare(
      "INSERT INTO environments (id, project_id, name, target, config, created_at, archived) VALUES ('env_old', 'proj_1', 'k8s', 'kubernetes', '{}', '2026-01-01T00:00:00Z', 1)",
    ).run();
    db.close();
    const store = createStore(path);
    openStores.push(store);
    expect(store.getEnvironment("env_old").archived).toBe(true);
    expect(JSON.parse(store.getEnvironment("env_old").config)).toEqual({ clusterId: "kc_default" });
  });

  it("rolls back entirely when a step fails", async () => {
    const { path, db } = await freshDb();
    oldRow(db, "v1:x:y:z");
    db.prepare(
      "INSERT INTO environments (id, project_id, name, target, config, created_at) VALUES ('env_k', 'proj_1', 'k8s', 'kubernetes', '{}', '2026-01-01T00:00:00Z')",
    ).run();
    db.exec("CREATE TRIGGER boom BEFORE DELETE ON connections BEGIN SELECT RAISE(ABORT, 'forced failure'); END;");
    db.close();
    expect(() => createStore(path)).toThrow(/forced failure/);
    const raw = new DatabaseSync(path);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM kube_connections").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM connections WHERE kind = 'kubernetes'").get()).toEqual({ n: 1 });
    expect((raw.prepare("SELECT config FROM environments WHERE id = 'env_k'").get() as { config: string }).config).toBe(
      "{}",
    );
    raw.close();
  });

  it("keeps the old row (and logs) when kc_default already exists", async () => {
    const { path, db } = await freshDb();
    db.exec(kubeConnectionsSchema);
    db.prepare(
      "INSERT INTO kube_connections (id, name, config, secret, status, created_at) VALUES ('kc_default', 'default', '{\"server\":\"https://new\"}', 'v1:n:e:w', 'connected', '2026-11-01T00:00:00Z')",
    ).run();
    oldRow(db, "v1:o:l:d");
    db.close();
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
    try {
      const store = createStore(path);
      openStores.push(store);
      expect(store.getKubernetesConnection("kc_default")!.server).toBe("https://new");
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("\n")).toMatch(/kc_default already exists/);
    const raw = new DatabaseSync(path);
    expect(raw.prepare("SELECT secret FROM connections WHERE kind = 'kubernetes'").get()).toEqual({
      secret: "v1:o:l:d",
    });
    raw.close();
  });
});

describe("the AWS connection", () => {
  const aws = {
    region: "eu-west-1",
    accountId: "123456789012",
    repository: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/nbo",
  };
  const keys = { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "AWS-SECRET-ACCESS-KEY-0123456789abcdefghij" };

  it("round-trips, keeps the key pair sealed at rest, records checks and deletes", async () => {
    const { store, path } = await openTestStore();
    expect(store.getAwsConnection()).toBeNull();
    expect(() => store.getAwsSecrets()).toThrow(ErrNotFound);
    const saved = store.saveAwsConnection(aws, keys);
    expect(saved).toMatchObject({ kind: "aws", ...aws, status: "connected", lastError: "" });
    expect(store.getAwsSecrets()).toEqual(keys);
    expect(store.hasSealedSecrets()).toBe(true);
    expect(() => store.verifySecretKey()).not.toThrow();
    const raw = new DatabaseSync(path);
    const row = JSON.stringify(raw.prepare("SELECT * FROM connections WHERE kind = 'aws'").get());
    raw.close();
    expect(row).not.toContain(keys.secretAccessKey);
    expect(row).not.toContain(keys.accessKeyId);
    store.recordConnectionCheck("aws", "denied");
    expect(store.getAwsConnection()).toMatchObject({ status: "failing", lastError: "denied" });
    store.deleteConnection("aws");
    expect(store.getAwsConnection()).toBeNull();
  });

  it("lists non-archived Lambda environments as using it", async () => {
    const { store, path } = await openTestStore();
    const p = store.createProject("web");
    // shortcut: written raw until the lambda target exists (validTargets, Task 4).
    const live = store.createEnvironment(p.id, "lambda", "cloudrun");
    store.createEnvironment(p.id, "run", "cloudrun");
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE environments SET target = 'lambda' WHERE id = ?").run(live.id);
    raw.close();
    expect(store.environmentsUsing("aws")).toEqual([{ projectName: "web", environmentId: live.id }]);
  });

  it("migrates a connections table from before AWS, keeping its rows", async () => {
    const key = randomBytes(32);
    const dir = await mkdtemp(join(tmpdir(), "controlplane-conn-aws-"));
    const path = join(dir, "test.db");
    const db = new DatabaseSync(path);
    db.exec(baseSchema);
    db.exec(gitSchema);
    db.exec(legacyConnectionsSchema.replace(",'aws'", ""));
    db.prepare(
      "INSERT INTO connections (kind, config, secret, status, created_at) VALUES ('google', ?, ?, 'connected', '2026-10-01T00:00:00Z')",
    ).run(JSON.stringify(google), seal(key, JSON.stringify({ deployerKey: "a", pullerKey: "b" })));
    db.close();
    for (let i = 0; i < 2; i++) createStore(path, { secretKey: key }).close();
    const store = createStore(path, { secretKey: key });
    openStores.push(store);
    expect(store.getGoogleConnection()).toMatchObject({ ...google, createdAt: "2026-10-01T00:00:00Z" });
    expect(store.getGoogleSecrets()).toEqual({ deployerKey: "a", pullerKey: "b" });
    expect(store.saveAwsConnection(aws, keys).accountId).toBe("123456789012");
  });
});
