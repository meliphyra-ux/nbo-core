// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import { migrateKubernetesConnections } from "../clouds/connections.js";
import { ephemeralStageColumns, migrateStages } from "../stages/stages.js";

// v2 columns are added with ALTER TABLE rather than folded into the
// CREATE TABLE statements: CREATE TABLE IF NOT EXISTS never alters an
// existing table, so a control-plane database created before v2 would
// otherwise keep its old shape forever.
const addedColumns: Record<string, [string, string][]> = {
  projects: [
    ["edge_host", "TEXT NOT NULL DEFAULT ''"],
    ["polling_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["last_seen_sha", "TEXT NOT NULL DEFAULT ''"],
    ["setup_status", "TEXT NOT NULL DEFAULT 'ready'"],
    ["setup_error", "TEXT NOT NULL DEFAULT ''"],
    // Speed Insights: off by default; the edge inserts the script; 100% sampled.
    ["speed_insights", "INTEGER NOT NULL DEFAULT 0"],
    ["speed_insights_inject", "INTEGER NOT NULL DEFAULT 1"],
    ["speed_insights_sample", "INTEGER NOT NULL DEFAULT 100"],
    // When the project's GitHub webhook last delivered anything ("" = never).
    ["last_webhook_at", "TEXT NOT NULL DEFAULT ''"],
    // Setup: skip the first build (kept until setup completes); when it began waiting for a deploy key.
    ["skip_first_build", "INTEGER NOT NULL DEFAULT 0"],
    ["key_wait_since", "TEXT NOT NULL DEFAULT ''"],
    // When the push (or poll, or manual build) that set last_seen_sha
    // happened, in ms (0 = unknown); see advanceHead in git-heads.ts.
    ["last_seen_at", "INTEGER NOT NULL DEFAULT 0"],
  ],
  // A reset code names the key it may register ('' = an older code, never usable).
  link_reset_codes: [["key_fingerprint", "TEXT NOT NULL DEFAULT ''"]],
  stages: [
    // As projects.last_seen_at, for a custom stage's head.
    ["last_seen_at", "INTEGER NOT NULL DEFAULT 0"],
    // Ephemeral stages: expiry, label and removal state (stages.ts).
    ...ephemeralStageColumns,
  ],
  environments: [
    ["traffic_weight", "INTEGER NOT NULL DEFAULT 0"],
    ["archived", "INTEGER NOT NULL DEFAULT 0"],
    // Per cloud: deploy each new commit's build here automatically.
    ["auto_deploy", "INTEGER NOT NULL DEFAULT 1"],
    // An environment revived after archiving counts only deployments
    // with a rowid above this one (earlier ones belong to its past life).
    ["deployments_after", "INTEGER NOT NULL DEFAULT 0"],
    // The stage (stages.ts) this cloud row belongs to; set to Production by
    // migrateStages for rows made before stages.
    ["stage_id", "TEXT NOT NULL DEFAULT ''"],
  ],
  domains: [
    // Behind Cloudflare: proxied domains, pasted origin certificates, and
    // a non-fatal warning shown beside the domain.
    ["behind_cloudflare", "INTEGER NOT NULL DEFAULT 0"],
    ["cert_source", "TEXT NOT NULL DEFAULT 'letsencrypt'"],
    ["warning", "TEXT NOT NULL DEFAULT ''"],
    // Cloud Run domain mappings: who serves the host, the DNS records the
    // mapping asked for (JSON), whether the mapping is being kept, and when a
    // kept mapping may be removed.
    ["serving", "TEXT NOT NULL DEFAULT 'edge'"],
    ["mapping_records", "TEXT NOT NULL DEFAULT ''"],
    ["mapping_kept", "INTEGER NOT NULL DEFAULT 0"],
    ["mapping_remove_after", "TEXT NOT NULL DEFAULT ''"],
    // The stage (stages.ts) whose site the host serves; set to Production
    // by migrateStages for rows made before stages.
    ["stage_id", "TEXT NOT NULL DEFAULT ''"],
  ],
  env_vars: [
    // A stage name or "*" for every stage. Existing variables become Production's.
    ["stage", "TEXT NOT NULL DEFAULT 'production'"],
    // 0 for a name declared without a value ("Don't store variable values").
    ["has_value", "INTEGER NOT NULL DEFAULT 1"],
  ],
  deployments: [
    // The build whose .nbo/ this deployment ran ("" for older rows).
    ["build_id", "TEXT NOT NULL DEFAULT ''"],
  ],
  api_tokens: [
    // Sign-in (auth.ts): the token's owner ('' until the Owner claims) and
    // its role; every token made before sign-in keeps working as an admin.
    ["user_id", "TEXT NOT NULL DEFAULT ''"],
    ["role", "TEXT NOT NULL DEFAULT 'admin'"],
  ],
  builds: [
    ["log", "TEXT NOT NULL DEFAULT ''"],
    ["deployment_ids", "TEXT NOT NULL DEFAULT '[]'"],
    ["started_at", "TEXT NOT NULL DEFAULT ''"],
    ["finished_at", "TEXT NOT NULL DEFAULT ''"],
    ["manual", "INTEGER NOT NULL DEFAULT 0"],
    // Build page details (JSON, NULL for builds made before NBO kept them).
    ["commit_info", "TEXT"],
    ["input", "TEXT"],
    ["timeline", "TEXT"],
    ["output_summary", "TEXT"],
    ["content_id", "TEXT NOT NULL DEFAULT ''"],
    ["artifact", "INTEGER NOT NULL DEFAULT 0"],
    // A promote job (kind 'promote') deploys a stored build's .nbo/
    // (source_build_id) to one environment, through the same queue.
    ["kind", "TEXT NOT NULL DEFAULT 'build'"],
    ["source_build_id", "TEXT NOT NULL DEFAULT ''"],
    ["target_environment_id", "TEXT NOT NULL DEFAULT ''"],
    // note: an informational outcome that is not an error (e.g. built
    // but no cloud takes new commits automatically).
    ["note", "TEXT NOT NULL DEFAULT ''"],
    // The stage (stages.ts) the job belongs to; set to Production by
    // migrateStages for builds made before stages.
    ["stage_id", "TEXT NOT NULL DEFAULT ''"],
    // The GitHub check run reporting this build (0 = none).
    ["github_check_run_id", "INTEGER NOT NULL DEFAULT 0"],
  ],
};

// movedTables are the tables of features that left core for the hosted
// dashboard (sign-in, members and audit; the GitHub App; previews; Speed
// Insights storage). A database from before the split keeps them: core never
// creates, alters, drops or reads them, except where a migration below says
// so (the preview stages read previews and preview_settings once), and a
// project's deletion removes its rows. The hosted dashboard's one-time import
// reads them; a later major version may drop them.
export const movedTables = [
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
] as const;

// legacyTablesInUse names the moved tables that exist and hold rows.
export function legacyTablesInUse(db: DatabaseSync): string[] {
  return movedTables.filter(
    (t) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined &&
      db.prepare(`SELECT 1 FROM "${t}" LIMIT 1`).get() !== undefined,
  );
}

// ErrStrandedSettings stops startup when platform_settings holds rows next to
// server_settings: an NBO from before the rename ran on this database after
// it was upgraded (a rollback without restoring the backup) and wrote
// settings that this version would never read.
export class ErrStrandedSettings extends Error {
  constructor() {
    super(
      "this database has settings in both platform_settings and server_settings: an older NBO wrote settings after this one upgraded the database, and they would be lost. Restore the volume backup taken before the upgrade, or start the older NBO again",
    );
    this.name = "ErrStrandedSettings";
  }
}

const transfersSchema = `
CREATE TABLE IF NOT EXISTS transfers (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	from_env_id TEXT NOT NULL,
	to_env_id TEXT NOT NULL,
	status TEXT NOT NULL,
	weight INTEGER NOT NULL DEFAULT 0,
	error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
`;

// migrate brings a database to the current shape. schemas (CREATE TABLE
// IF NOT EXISTS statements) run first. Everything up to the Kubernetes
// connection move runs in one transaction: all or nothing, and one
// journal commit instead of one per statement (dozens of fsyncs, which
// made every store open take hundreds of milliseconds on Windows).
export function migrate(db: DatabaseSync, schemas: string[] = []): void {
  db.exec("BEGIN");
  try {
    // Platform settings were renamed server settings: carry the table (rows,
    // sealed values and all) over before the schemas would create an empty one.
    const hasTable = (name: string): boolean =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
    if (hasTable("platform_settings") && !hasTable("server_settings"))
      db.exec("ALTER TABLE platform_settings RENAME TO server_settings");
    // Both tables, and the old one holds rows: an older NBO wrote there after
    // the upgrade. An empty leftover is harmless and stays.
    if (hasTable("platform_settings") && db.prepare("SELECT 1 FROM platform_settings LIMIT 1").get() !== undefined)
      throw new ErrStrandedSettings();
    for (const schema of schemas) db.exec(schema);
    for (const [table, cols] of Object.entries(addedColumns)) {
      const existing = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
      );
      // A table that does not exist yet (its CREATE TABLE was not passed in)
      // has nothing to alter.
      if (existing.size === 0) continue;
      for (const [name, decl] of cols) {
        if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      }
    }
    // Variables per stage: the unique index gains the stage. It can only be
    // made after the column exists (envVarsSchema runs before the column pass).
    if ((db.prepare("PRAGMA table_info(env_vars)").all() as unknown[]).length > 0) {
      db.exec("DROP INDEX IF EXISTS env_vars_scope_name");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS env_vars_scope_stage_name ON env_vars (COALESCE(project_id, ''), stage, name)",
      );
    }
    db.exec(transfersSchema);
    // A head an older NBO stored without a time (0) counts as seen now, so a
    // push older than the upgrade, replayed, can't pass advanceHead as newer.
    // Pushes that really are newer still do.
    const now = Date.now();
    for (const table of ["projects", "stages"]) {
      const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      if (cols.has("last_seen_at") && cols.has("last_seen_sha"))
        db.prepare(`UPDATE ${table} SET last_seen_at = ? WHERE last_seen_at = 0 AND last_seen_sha <> ''`).run(now);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  // Multiple Kubernetes clusters: the single connection becomes kc_default
  // (in a transaction of its own).
  migrateKubernetesConnections(db);
  // Stages: every project gets Production, Preview and Development, and
  // every cloud row without a stage goes on Production (its own transaction).
  migrateStages(db);
}
