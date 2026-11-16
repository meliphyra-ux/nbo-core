// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../store/store.js";
import { legacyTablesInUse, movedTables } from "../store/migrate.js";
import { ErrSecretKey } from "../store/secrets.js";

// A database the code before the core split wrote (fixtures/legacy-schema.sql,
// dumped from 498eada): sign-in on, members, sessions, audit rows, the GitHub
// App and its installation, an active preview, vitals, and sealed settings
// in platform_settings. Core must open it, keep every row, and leave the
// tables of the features that moved out exactly as they were.
const KEY = Buffer.alloc(32, 0x42);

const MOVED = [
  "users",
  "user_identities",
  "sessions",
  "invites",
  "sign_in_rules",
  "oauth_states",
  "sign_in_links",
  "audit_events",
  "github_installations",
  "github_deliveries",
  "github_states",
  "preview_settings",
  "previews",
  "preview_branch_heads",
  "vitals",
];

function legacyDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "controlplane-legacy-"));
  const path = join(dir, "nbo.db");
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL("./fixtures/legacy-schema.sql", import.meta.url), "utf8"));
  db.close();
  return { dir, path };
}

type Snapshot = Record<string, { sql: string[]; rows: Record<string, unknown>[] }>;

// snapshot reads every table's definition (with its indexes) and rows.
function snapshot(path: string): Snapshot {
  const db = new DatabaseSync(path);
  try {
    const out: Snapshot = {};
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[];
    for (const { name } of tables) {
      const sql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(name) as {
          sql: string;
        }[]
      ).map((r) => r.sql);
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Record<string, unknown>[];
      out[name] = { sql, rows };
    }
    return out;
  } finally {
    db.close();
  }
}

function openCore(path: string): ReturnType<typeof createStore> {
  return createStore(path, { artifactsDir: join(path, "..", "artifacts") });
}

describe("a database from before the core split", () => {
  it("names the same moved tables as the plan", () => {
    expect([...movedTables].sort()).toEqual([...MOVED].sort());
  });

  it("opens under core: moved tables untouched, core rows kept, settings renamed, a second start changes nothing", () => {
    const { path } = legacyDb();
    const before = snapshot(path);
    for (const t of MOVED) expect(before[t]?.rows.length, t).toBeGreaterThan(0);
    // Core tables whose rows an upgrade must keep too.
    for (const t of ["crons", "environment_cron_secrets", "relays", "transfers"])
      expect(before[t]?.rows.length, t).toBeGreaterThan(0);

    openCore(path).close();
    const after = snapshot(path);

    // Moved tables: the same definition, indexes and rows.
    for (const t of MOVED) expect(after[t], t).toEqual(before[t]);

    // platform_settings became server_settings with every row, sealed ones included.
    expect(after.platform_settings).toBeUndefined();
    expect(after.server_settings!.rows).toEqual(before.platform_settings!.rows);

    // Every other table: every old row keeps its old columns' values. The
    // intended changes: the preview stage is now an ephemeral stage core
    // expires, and a head stored without a time (last_seen_at 0) gets one.
    for (const [table, { rows }] of Object.entries(before)) {
      if (MOVED.includes(table) || table === "platform_settings") continue;
      expect(after[table]?.rows.length, table).toBe(rows.length);
      rows.forEach((row, i) => {
        const now = after[table]!.rows[i]!;
        const picked = Object.fromEntries(Object.keys(row).map((c) => [c, now[c]]));
        if (row.last_seen_at === 0 && typeof row.last_seen_sha === "string" && row.last_seen_sha !== "") {
          expect(now.last_seen_at, `${table} row ${i}`).toBeGreaterThan(0);
          picked.last_seen_at = 0;
        }
        if (table === "stages" && row.kind === "preview-deployment") {
          expect(picked).toEqual({ ...row, kind: "ephemeral" });
          expect(now).toMatchObject({ label: "pr #12", removal_status: "" });
        } else {
          expect(picked, `${table} row ${i}`).toEqual(row);
        }
      });
    }

    // A second start is a no-op.
    openCore(path).close();
    expect(snapshot(path)).toEqual(after);
  });

  it("the secret key check covers the sealed GitHub, Google and ACME rows", () => {
    const { path } = legacyDb();
    const right = openCore(path);
    try {
      expect(right.hasSealedSecrets()).toBe(true);
      right.setSecretKey(KEY);
      expect(() => right.verifySecretKey()).not.toThrow();
      expect(right.getServerSecret("github_private_key")).toBe("github-app-pem");
      expect(right.getServerSecret("google_client_secret")).toBe("google-secret");
      expect(right.getServerSecret("acme_account_key")).toBe("acme-account-pem");
      expect(right.getServerSettings().baseDomain).toBe("nbo.example.com");
    } finally {
      right.close();
    }
    const wrong = openCore(path);
    try {
      wrong.setSecretKey(randomBytes(32));
      expect(() => wrong.verifySecretKey()).toThrow(ErrSecretKey);
    } finally {
      wrong.close();
    }
  });

  it("the sealed rows alone fail a wrong key", () => {
    // Only the settings rows hold sealed data: no connections, no secret variables.
    const { path } = legacyDb();
    const db = new DatabaseSync(path);
    db.exec(
      "DELETE FROM connections; DELETE FROM kube_connections; DELETE FROM env_vars WHERE secret = 1; DELETE FROM platform_settings WHERE key <> 'github_private_key'",
    );
    db.close();
    const store = openCore(path);
    try {
      expect(store.hasSealedSecrets()).toBe(true);
      store.setSecretKey(randomBytes(32));
      expect(() => store.verifySecretKey()).toThrow(ErrSecretKey);
      store.setSecretKey(KEY);
      expect(() => store.verifySecretKey()).not.toThrow();
    } finally {
      store.close();
    }
  });

  it("legacyTablesInUse names the moved tables that hold rows", () => {
    const { path } = legacyDb();
    const db = new DatabaseSync(path);
    db.exec("DELETE FROM github_states; DELETE FROM oauth_states");
    expect(legacyTablesInUse(db)).toEqual(MOVED.filter((t) => t !== "github_states" && t !== "oauth_states"));
    db.close();
    const store = openCore(path);
    try {
      expect(store.legacyTablesInUse()).toEqual(MOVED.filter((t) => t !== "github_states" && t !== "oauth_states"));
    } finally {
      store.close();
    }
  });

  it("a fresh database has none of the moved tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "controlplane-legacy-"));
    const path = join(dir, "nbo.db");
    const store = openCore(path);
    try {
      expect(store.legacyTablesInUse()).toEqual([]);
    } finally {
      store.close();
    }
    const tables = Object.keys(snapshot(path));
    for (const t of MOVED) expect(tables, t).not.toContain(t);
    expect(tables).not.toContain("platform_settings");
  });

  it("refuses to open when an older NBO wrote settings after the upgrade", () => {
    const { path } = legacyDb();
    openCore(path).close();
    // A rollback to an older build: it finds no platform_settings, creates an
    // empty one and writes there; those writes would be lost silently.
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO platform_settings VALUES ('base_domain', 'other.example.com')",
    );
    db.close();
    const before = snapshot(path);
    expect(() => openCore(path)).toThrow(/platform_settings.*server_settings|server_settings.*platform_settings/);
    expect(() => openCore(path)).toThrow(/backup/);
    expect(snapshot(path)).toEqual(before);
  });

  it("opens when the older NBO left an empty platform_settings behind", () => {
    const { path } = legacyDb();
    openCore(path).close();
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.close();
    expect(() => openCore(path).close()).not.toThrow();
  });

  it("main prints the notice once and starts; a stranded-settings database stops startup with the message", async () => {
    const { main } = await import("../main.js");
    const { dir, path } = legacyDb();
    const keyFile = join(dir, "nbo-secret.key");
    writeFileSync(keyFile, KEY);
    const env = {
      NBO_CONTROL_PLANE_DB: path,
      NBO_SECRET_KEY_FILE: keyFile,
      NBO_CONTROL_PLANE_ADDR: "127.0.0.1:0",
      NBO_EDGE_ADMIN_URL: "http://127.0.0.1:9",
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = process.exitCode;
    try {
      const started = main(env);
      try {
        expect(started).toBeDefined();
        await started!.listening;
        const notices = log.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes("moved to the hosted dashboard"));
        expect(notices).toEqual([
          `control-plane: this database holds data from features that moved to the hosted dashboard (${MOVED.join(", ")}); it is kept, unused, until you migrate`,
        ]);
      } finally {
        await started?.close();
      }

      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO platform_settings VALUES ('base_domain', 'other.example.com')",
      );
      db.close();
      expect(main(env)).toBeUndefined();
      expect(process.exitCode).toBe(1);
      expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/^control-plane: .*platform_settings/m);
    } finally {
      process.exitCode = before;
      log.mockRestore();
      err.mockRestore();
    }
  });
});
