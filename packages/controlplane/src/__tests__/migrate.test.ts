// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { baseSchema, createStore } from "../store.js";
import { gitSchema } from "../git.js";
import { ErrStrandedSettings, migrate } from "../migrate.js";
import { seal } from "../secrets.js";

async function preV2Db(): Promise<DatabaseSync> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-migrate-"));
  const db = new DatabaseSync(join(dir, "test.db"));
  db.exec(baseSchema);
  db.exec(gitSchema);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_1', 'acme', '2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO builds (id, project_id, revision, status, created_at) VALUES ('build_1', 'proj_1', 'abc', 'succeeded', '2026-01-01T00:00:00Z')").run();
  return db;
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe("migrate", () => {
  it("adds every new column to a pre-v2 database without losing rows", async () => {
    const db = await preV2Db();
    migrate(db);
    expect(columns(db, "projects")).toEqual(expect.arrayContaining(["edge_host", "polling_enabled", "last_seen_sha", "setup_status", "setup_error"]));
    expect(columns(db, "environments")).toEqual(expect.arrayContaining(["traffic_weight", "archived"]));
    expect(columns(db, "builds")).toEqual(expect.arrayContaining(["log", "deployment_ids", "started_at", "finished_at"]));
    expect(columns(db, "transfers")).toEqual(expect.arrayContaining(["id", "project_id", "from_env_id", "to_env_id", "status", "weight", "error", "created_at"]));
    const p = db.prepare("SELECT name, setup_status, polling_enabled FROM projects WHERE id = 'proj_1'").get() as { name: string; setup_status: string; polling_enabled: number };
    expect(p).toEqual({ name: "acme", setup_status: "ready", polling_enabled: 1 });
    const b = db.prepare("SELECT status, deployment_ids, log FROM builds WHERE id = 'build_1'").get() as { status: string; deployment_ids: string; log: string };
    expect(b).toEqual({ status: "succeeded", deployment_ids: "[]", log: "" });
  });

  it("is all or nothing: a failing step leaves no added columns behind", async () => {
    const db = await preV2Db();
    // Two variables with one name make the unique index on env_vars fail, after every ALTER ran.
    db.exec("CREATE TABLE env_vars (project_id TEXT, name TEXT)");
    db.exec("INSERT INTO env_vars VALUES ('p', 'A'), ('p', 'A')");
    expect(() => migrate(db)).toThrow();
    expect(columns(db, "projects")).not.toContain("edge_host");
    expect(columns(db, "transfers")).toEqual([]);
  });

  it("is idempotent", async () => {
    const db = await preV2Db();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(columns(db, "projects").filter((c) => c === "edge_host")).toHaveLength(1);
  });

  it("a build made before details were kept reads as null details", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-migrate-"));
    const path = join(dir, "test.db");
    const db = new DatabaseSync(path);
    db.exec(baseSchema);
    db.exec(gitSchema);
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_1', 'acme', '2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO builds (id, project_id, revision, status, created_at) VALUES ('build_1', 'proj_1', 'abc', 'succeeded', '2026-01-01T00:00:00Z')").run();
    db.close();
    const store = createStore(path);
    try {
      expect(store.getBuild("build_1")).toMatchObject({ status: "succeeded", commit: null, input: null, timeline: null, outputSummary: null, contentId: "", artifact: false });
    } finally {
      store.close();
    }
  });
});

describe("migrate: per-cloud auto-deploy and deployment build ids", () => {
  it("an environment and a deployment made before these columns read as auto-deploy on and no build id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-migrate-"));
    const path = join(dir, "test.db");
    const db = new DatabaseSync(path);
    db.exec(baseSchema);
    db.exec(gitSchema);
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_1', 'acme', '2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO environments (id, project_id, name, target, created_at) VALUES ('env_1', 'proj_1', 'k8s', 'kubernetes', '2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO deployments (id, environment_id, status, created_at) VALUES ('dep_1', 'env_1', 'succeeded', '2026-01-01T00:00:00Z')").run();
    db.close();
    const store = createStore(path);
    try {
      expect(store.getEnvironment("env_1").autoDeploy).toBe(true);
      expect(store.getDeployment("dep_1").buildId).toBe("");
    } finally {
      store.close();
    }
  });
});

// A database made by the code before stages (fixtures/pre-stages.sql, dumped
// from a store at HEAD 10137af: two projects, Production clouds including an
// archived one, deployments, a split, variables, a domain).
async function preStagesDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-migrate-"));
  const path = join(dir, "test.db");
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL("./fixtures/pre-stages.sql", import.meta.url), "utf8"));
  db.close();
  return path;
}

function dumpTables(path: string, tables: string[]): Record<string, unknown[]> {
  const db = new DatabaseSync(path);
  try {
    return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  } finally {
    db.close();
  }
}

describe("migrate: stages", () => {
  it("a database made before stages opens with three stages per project and every cloud row on Production", async () => {
    const path = await preStagesDb();
    const before = dumpTables(path, ["projects", "environments", "deployments"]);
    const store = createStore(path);
    try {
      const projects = store.listProjects();
      expect(projects.map((p) => p.name)).toEqual(["shop", "blog"]);
      for (const p of projects) {
        expect(store.listStages(p.id).map((s) => [s.name, s.kind])).toEqual([
          ["production", "production"],
          ["preview", "preview"],
          ["development", "development"],
        ]);
        const prod = store.productionStage(p.id);
        const all = store.listEnvironments(p.id, { allStages: true, includeArchived: true });
        expect(all.length).toBeGreaterThan(0);
        for (const e of all) expect(e.stageId).toBe(prod.id);
        // Every existing caller sees exactly what it saw before.
        expect(store.listEnvironments(p.id, { includeArchived: true })).toEqual(all);
      }
      const shop = projects[0]!;
      expect(store.listEnvironments(shop.id).map((e) => [e.name, e.trafficWeight])).toEqual([
        ["k8s", 70],
        ["cloudrun", 30],
      ]);
      expect(store.listEnvironments(shop.id, { includeArchived: true }).map((e) => e.name)).toEqual(["k8s", "cloudrun", "k8s-old"]);
    } finally {
      store.close();
    }
    // Nothing else changed: same projects and deployments, environments
    // only gained stage_id.
    const after = dumpTables(path, ["projects", "environments", "deployments"]);
    expect((after.projects as Record<string, unknown>[]).map(({ last_webhook_at: _w, last_seen_at: _a, ...rest }) => rest)).toEqual(before.projects);
    expect(after.deployments).toEqual(before.deployments);
    expect((after.environments as Record<string, unknown>[]).map(({ stage_id: _s, ...rest }) => rest)).toEqual(before.environments);
  });

  it("a second open changes nothing", async () => {
    const path = await preStagesDb();
    createStore(path).close();
    const first = dumpTables(path, ["stages", "environments", "projects", "builds"]);
    createStore(path).close();
    expect(dumpTables(path, ["stages", "environments", "projects", "builds"])).toEqual(first);
  });

  it("every build made before stages belongs to Production", async () => {
    const path = await preStagesDb();
    const before = dumpTables(path, ["builds"]);
    const store = createStore(path);
    try {
      const builds = store.listProjects().flatMap((p) => store.listBuilds(p.id).map((b) => [b.stageId, store.productionStage(p.id).id]));
      expect(builds.length).toBeGreaterThan(0);
      for (const [got, want] of builds) expect(got).toBe(want);
    } finally {
      store.close();
    }
    const after = dumpTables(path, ["builds"]);
    // github_check_run_id: added later (GitHub check runs), 0 for old builds.
    expect((after.builds as Record<string, unknown>[]).every((b) => b.github_check_run_id === 0)).toBe(true);
    expect((after.builds as Record<string, unknown>[]).map(({ stage_id: _s, github_check_run_id: _g, ...rest }) => rest)).toEqual(before.builds);
  });

  it("every domain made before stages belongs to Production, and a second open changes nothing", async () => {
    const path = await preStagesDb();
    const before = dumpTables(path, ["domains"]);
    expect(before.domains!.length).toBeGreaterThan(0);
    const store = createStore(path);
    try {
      for (const d of store.listDomains()) expect(d.stageId).toBe(store.productionStage(d.projectId).id);
    } finally {
      store.close();
    }
    const after = dumpTables(path, ["domains"]);
    expect((after.domains as Record<string, unknown>[]).map(({ stage_id: _s, ...rest }) => rest)).toEqual(before.domains);
    createStore(path).close();
    expect(dumpTables(path, ["domains"])).toEqual(after);
  });

  it("migrate alone (no schemas passed) adds stages to a pre-v2 database", async () => {
    const db = await preV2Db();
    db.prepare("INSERT INTO environments (id, project_id, name, target, created_at) VALUES ('env_1', 'proj_1', 'k8s', 'kubernetes', '2026-01-01T00:00:00Z')").run();
    migrate(db);
    migrate(db);
    const stages = db.prepare("SELECT id, name, kind FROM stages WHERE project_id = 'proj_1' ORDER BY rowid").all() as { id: string; name: string; kind: string }[];
    expect(stages.map((s) => s.name)).toEqual(["production", "preview", "development"]);
    const env = db.prepare("SELECT stage_id FROM environments WHERE id = 'env_1'").get() as { stage_id: string };
    expect(env.stage_id).toBe(stages[0]!.id);
  });
});

describe("migrate: ephemeral stages (previews left core)", () => {
  const tables = (path: string): string[] => {
    const db = new DatabaseSync(path);
    try {
      return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    } finally {
      db.close();
    }
  };

  // A database made after stages but before ephemeral stages: the stages
  // table without their columns, and the preview tables an earlier NBO made
  // (previews without removed_at, as before that column existed).
  async function olderPreviewsDb(): Promise<string> {
    const path = await preStagesDb();
    const s = createStore(path);
    const p = s.listProjects()[0]!;
    s.createStage(p.id, { name: "staging", branch: "staging", host: "staging--shop.127.0.0.1.sslip.io" });
    s.close();
    const db = new DatabaseSync(path);
    for (const c of ["expires_at", "label", "removal_status", "removal_attempts", "next_attempt_at", "removal_error"]) db.exec(`ALTER TABLE stages DROP COLUMN ${c}`);
    db.exec(`
CREATE TABLE preview_settings (project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, branches TEXT NOT NULL DEFAULT '[]', without_pull_request INTEGER NOT NULL DEFAULT 1, expire_after_days INTEGER NOT NULL DEFAULT 7, delete_on_close INTEGER NOT NULL DEFAULT 1, max_active INTEGER NOT NULL DEFAULT 10, cloud TEXT NOT NULL DEFAULT '');
CREATE TABLE previews (stage_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch TEXT NOT NULL, host TEXT NOT NULL DEFAULT '', pr_number INTEGER NOT NULL DEFAULT 0, pr_state TEXT NOT NULL DEFAULT '', last_sha TEXT NOT NULL DEFAULT '', last_push_at TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', remove_reason TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE preview_branch_heads (project_id TEXT NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY (project_id, branch));
`);
    db.prepare("INSERT INTO stages (id, project_id, name, kind, branch, auto_deploy, host, created_at) VALUES ('stg_pv1', ?, 'pv-0000aaaa', 'preview-deployment', 'feature/x', 1, 'feature-x--shop.127.0.0.1.sslip.io', '2026-11-10T00:00:00.000Z')").run(p.id);
    db.prepare("INSERT INTO previews (stage_id, project_id, branch, host, pr_number, pr_state, status, remove_reason, created_at) VALUES ('stg_pv1', ?, 'feature/x', 'feature-x--shop.127.0.0.1.sslip.io', 7, 'closed', 'active', 'closed', '2026-11-10T00:00:00.000Z')").run(p.id);
    db.prepare("INSERT INTO preview_settings (project_id, enabled, expire_after_days) VALUES (?, 1, 3)").run(p.id);
    db.prepare("INSERT INTO preview_branch_heads (project_id, branch, sha) VALUES (?, 'feature/x', ?)").run(p.id, "a".repeat(40));
    db.close();
    return path;
  }

  it("a fresh database has no preview tables but keeps the certificate order count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-migrate-"));
    createStore(join(dir, "fresh.db")).close();
    const t = tables(join(dir, "fresh.db"));
    for (const name of ["previews", "preview_settings", "preview_branch_heads"]) expect(t).not.toContain(name);
    expect(t).toContain("preview_cert_orders");
  });

  it("an earlier database opens: stages gain the new columns, its preview becomes ephemeral, and the preview tables are untouched", async () => {
    const path = await olderPreviewsDb();
    const before = dumpTables(path, ["previews", "preview_settings", "preview_branch_heads"]);
    const shape = (name: string) => {
      const db = new DatabaseSync(path);
      try {
        return db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name);
      } finally {
        db.close();
      }
    };
    const previewsShape = shape("previews");
    const stagesBefore = (dumpTables(path, ["stages"]).stages as Record<string, unknown>[]).filter((r) => r.kind !== "preview-deployment");
    const store = createStore(path);
    try {
      const shop = store.listProjects()[0]!;
      const pv = store.getStage("stg_pv1");
      // A preview already marked for removal (its pull request closed) is removed on the first pass.
      expect(pv).toMatchObject({ kind: "ephemeral", label: "pr #7", removal: "removing", expiresAt: "2026-11-13T00:00:00.000Z" });
      expect(store.listStages(shop.id).map((s) => s.kind)).toEqual(["production", "preview", "development", "custom"]);
      for (const s of store.listStages(shop.id)) expect(s).toMatchObject({ expiresAt: "", label: "", removal: "", removalAttempts: 0 });
    } finally {
      store.close();
    }
    expect(dumpTables(path, ["previews", "preview_settings", "preview_branch_heads"])).toEqual(before);
    expect(shape("previews")).toEqual(previewsShape);
    const after = (dumpTables(path, ["stages"]).stages as Record<string, unknown>[])
      .filter((r) => r.kind !== "ephemeral")
      .map(({ expires_at: _e, label: _l, removal_status: _r, removal_attempts: _a, next_attempt_at: _n, removal_error: _x, ...rest }) => rest);
    expect(after).toEqual(stagesBefore);
    // Opening again changes nothing.
    const first = dumpTables(path, ["stages", "projects", "previews", "preview_settings"]);
    createStore(path).close();
    expect(dumpTables(path, ["stages", "projects", "previews", "preview_settings"])).toEqual(first);
  });

  it("deleting a project deletes its rows from the preview tables only where they exist", async () => {
    const path = await olderPreviewsDb();
    const store = createStore(path);
    try {
      const shop = store.listProjects()[0]!;
      store.deleteProject(shop.id);
    } finally {
      store.close();
    }
    const left = dumpTables(path, ["previews", "preview_settings", "preview_branch_heads"]);
    for (const rows of Object.values(left)) expect(rows).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), "controlplane-migrate-"));
    const fresh = createStore(join(dir, "fresh.db"));
    try {
      const p = fresh.createProject("blog");
      expect(() => fresh.deleteProject(p.id)).not.toThrow();
    } finally {
      fresh.close();
    }
  });

  it("migrateStages doesn't count ephemeral stages as built-in stages", async () => {
    const path = await preStagesDb();
    const s = createStore(path);
    const p = s.listProjects()[0]!;
    s.createEphemeralStage(p.id, { branch: "a", host: "a--shop.127.0.0.1.sslip.io", expiresAt: "", label: "" });
    s.createEphemeralStage(p.id, { branch: "b", host: "b--shop.127.0.0.1.sslip.io", expiresAt: "", label: "" });
    s.close();
    // A project somehow left with only Production plus ephemeral stages still gets its Preview and Development.
    const db = new DatabaseSync(path);
    db.prepare("DELETE FROM stages WHERE project_id = ? AND kind IN ('preview', 'development')").run(p.id);
    db.close();
    const again = createStore(path);
    try {
      expect(again.listStages(p.id).map((x) => x.name)).toEqual(["production", "preview", "development"]);
      expect(again.listStages(p.id, { includeEphemeral: true }).filter((x) => x.kind === "ephemeral")).toHaveLength(2);
    } finally {
      again.close();
    }
  });
});

describe("migrate: sign-in left core", () => {
  const AUTH_TABLES = ["users", "user_identities", "sessions", "invites", "sign_in_rules", "oauth_states", "sign_in_links", "audit_events"];
  const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);

  it("a fresh database has none of the sign-in tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-migrate-"));
    const store = createStore(join(dir, "fresh.db"));
    store.close();
    const db = new DatabaseSync(join(dir, "fresh.db"));
    try {
      for (const t of AUTH_TABLES) expect(tables(db), t).not.toContain(t);
      expect(tables(db)).toContain("api_tokens");
      expect(columns(db, "api_tokens")).toEqual(expect.arrayContaining(["user_id", "role"]));
    } finally {
      db.close();
    }
  });

  it("a database with sign-in on keeps its sign-in tables, rows and owned tokens untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-migrate-"));
    const path = join(dir, "signed-in.db");
    const first = createStore(path);
    const { token } = first.createApiToken("member-token");
    first.close();
    // What the sign-in code wrote, in its own tables (copied shapes).
    const seed = new DatabaseSync(path);
    seed.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL);`);
    seed.prepare("INSERT INTO users VALUES ('usr_1', 'Olive', 'owner'), ('usr_2', 'Vee', 'viewer')").run();
    seed.prepare("INSERT INTO sessions VALUES ('ses_1', 'usr_1', '2020-01-01T00:00:00Z')").run();
    seed.prepare("INSERT INTO audit_events (at, route, status) VALUES ('2020-01-01T00:00:00Z', '/projects', 201)").run();
    seed.prepare("UPDATE api_tokens SET user_id = 'usr_2', role = 'viewer' WHERE id = ?").run(token.id);
    seed.prepare("INSERT INTO server_settings (key, value) VALUES ('auth_mode', 'on')").run();
    const sqlOf = (db: DatabaseSync) => db.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('users', 'sessions', 'audit_events') ORDER BY name").all();
    const before = sqlOf(seed);
    seed.close();

    for (let i = 0; i < 2; i++) createStore(path).close();

    const db = new DatabaseSync(path);
    try {
      expect(sqlOf(db)).toEqual(before);
      expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(2);
      expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n).toBe(1);
      expect(db.prepare("SELECT user_id, role FROM api_tokens WHERE id = ?").get(token.id)).toEqual({ user_id: "usr_2", role: "viewer" });
      expect(db.prepare("SELECT value FROM server_settings WHERE key = 'auth_mode'").get()).toEqual({ value: "on" });
    } finally {
      db.close();
    }
  });
});

describe("migrate: server settings (renamed from platform settings)", () => {
  const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  const KEY = Buffer.alloc(32, 7);

  async function oldDb(): Promise<{ path: string; sealed: string }> {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-migrate-"));
    const path = join(dir, "old.db");
    const first = createStore(path);
    first.close();
    // Turn it into what the code before the rename left: the same table
    // under its old name, holding a plain row and a sealed one.
    const sealed = seal(KEY, "acme-account-key-pem");
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE server_settings RENAME TO platform_settings");
    db.prepare("INSERT INTO platform_settings (key, value) VALUES ('base_domain', 'example.test')").run();
    db.prepare("INSERT INTO platform_settings (key, value) VALUES ('acme_account_key', ?)").run(sealed);
    db.close();
    return { path, sealed };
  }

  it("a database with platform_settings opens as server_settings with both rows and no old table", async () => {
    const { path, sealed } = await oldDb();
    const store = createStore(path);
    expect(store.getServerSettings().baseDomain).toBe("example.test");
    store.close();
    const db = new DatabaseSync(path);
    try {
      expect(tables(db)).toContain("server_settings");
      expect(tables(db)).not.toContain("platform_settings");
      expect(db.prepare("SELECT value FROM server_settings WHERE key = 'base_domain'").get()).toEqual({ value: "example.test" });
      expect(db.prepare("SELECT value FROM server_settings WHERE key = 'acme_account_key'").get()).toEqual({ value: sealed });
    } finally {
      db.close();
    }
  });

  it("the secret-key check still sees the renamed sealed row", async () => {
    const { path } = await oldDb();
    const store = createStore(path);
    try {
      expect(store.hasSealedSecrets()).toBe(true);
      store.setSecretKey(KEY);
      expect(() => store.verifySecretKey()).not.toThrow();
      expect(store.getServerSecret("acme_account_key")).toBe("acme-account-key-pem");
      store.setSecretKey(Buffer.alloc(32, 9));
      expect(() => store.verifySecretKey()).toThrow();
    } finally {
      store.close();
    }
  });

  it("a second migrate is a no-op", async () => {
    const { path } = await oldDb();
    createStore(path).close();
    createStore(path).close();
    const db = new DatabaseSync(path);
    try {
      expect(tables(db)).not.toContain("platform_settings");
      expect((db.prepare("SELECT COUNT(*) AS n FROM server_settings").get() as { n: number }).n).toBe(2);
    } finally {
      db.close();
    }
  });

  it("a database that has both tables, the old one with rows, is refused and left as it is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-migrate-"));
    const db = new DatabaseSync(join(dir, "both.db"));
    db.exec("CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO platform_settings VALUES ('base_domain', 'old')").run();
    expect(() => migrate(db)).toThrow(ErrStrandedSettings);
    expect(tables(db)).toEqual(expect.arrayContaining(["platform_settings", "server_settings"]));
    expect(tables(db)).not.toContain("transfers");
    expect((db.prepare("SELECT COUNT(*) AS n FROM server_settings").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it("createStore closes the database when migrate refuses it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-migrate-"));
    const path = join(dir, "both.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO platform_settings VALUES ('base_domain', 'old')").run();
    db.close();
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      expect(() => createStore(path)).toThrow(ErrStrandedSettings);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
    // Nothing holds the file open any more (Windows refuses to delete an open one).
    rmSync(path);
  });

  it("a fresh database gets server_settings only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-migrate-"));
    createStore(join(dir, "fresh.db")).close();
    const db = new DatabaseSync(join(dir, "fresh.db"));
    try {
      expect(tables(db)).toContain("server_settings");
      expect(tables(db)).not.toContain("platform_settings");
    } finally {
      db.close();
    }
  });
});
