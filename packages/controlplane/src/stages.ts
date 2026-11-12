// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { ErrConflict, ErrDuplicateName, ErrInvalid, ErrNotFound } from "./errors.js";
import type { Store } from "./store.js";

// Stages are what the manual calls environments: Production, Preview,
// Development and custom ones such as "staging". (In NBO's code the word
// "environment" already names a cloud row a project runs on.) A custom
// stage owns its own cloud rows (environments.stage_id); Production's are
// the project's existing rows. The manual's Environments chapter covers them.

// "ephemeral": a short-lived environment with its own branch, its own
// address and a time to live (expiresAt), named pv-<8 hex> and hidden from
// listStages unless asked for. Whoever creates it (the hosted platform's
// previews, a script, Terraform) decides what it is for; core builds it,
// routes it and removes it when it expires (stage-expiry.ts).
export type StageKind = "production" | "preview" | "development" | "custom" | "ephemeral";

// Where an ephemeral stage's removal is: "" while it runs, "removing" once
// marked (its address stops routing at once), "removal-failed" after a
// failed attempt (retried with backoff), "removed" when its app is gone.
export type StageRemoval = "" | "removing" | "removal-failed" | "removed";

export interface Stage {
  id: string;
  projectId: string;
  name: string;
  kind: StageKind;
  // The branch that feeds a custom or ephemeral stage; "" for the built-ins
  // (Production's branch is the git config's productionBranch, never copied here).
  branch: string;
  autoDeploy: boolean;
  // The stage's default host; "" for Production (projects.edge_host holds it).
  host: string;
  // Custom and ephemeral stages: the last head the poller saw (Production keeps projects.last_seen_sha).
  lastSeenSha: string;
  createdAt: string;
  // Ephemeral stages: when core removes it (ISO; "" = never), a free-text
  // label from whoever made it (never parsed), and its removal state.
  expiresAt: string;
  label: string;
  removal: StageRemoval;
  removalAttempts: number;
  // When a failed removal is tried again (ISO; "" = at once).
  nextAttemptAt: string;
  removalError: string;
  // When its removal finished (ISO; "" = not removed, or removed before NBO
  // recorded this). GET .../stages lists a removed stage for 7 days after.
  removedAt: string;
}

export type StagePatch = Partial<
  Pick<Stage, "branch" | "autoDeploy" | "host" | "lastSeenSha" | "expiresAt" | "label" | "removal" | "removalAttempts" | "nextAttemptAt" | "removalError" | "removedAt">
>;

export const stagesSchema = `
CREATE TABLE IF NOT EXISTS stages (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	name TEXT NOT NULL,
	kind TEXT NOT NULL,
	branch TEXT NOT NULL DEFAULT '',
	auto_deploy INTEGER NOT NULL DEFAULT 1,
	host TEXT NOT NULL DEFAULT '',
	last_seen_sha TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL DEFAULT '',
	label TEXT NOT NULL DEFAULT '',
	removal_status TEXT NOT NULL DEFAULT '',
	removal_attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TEXT NOT NULL DEFAULT '',
	removal_error TEXT NOT NULL DEFAULT '',
	removed_at TEXT NOT NULL DEFAULT '',
	UNIQUE(project_id, name)
);
`;

// The columns ephemeral stages added, for databases made before them
// (migrate.ts adds them through addedColumns.stages).
export const ephemeralStageColumns: [string, string][] = [
  ["expires_at", "TEXT NOT NULL DEFAULT ''"],
  ["label", "TEXT NOT NULL DEFAULT ''"],
  ["removal_status", "TEXT NOT NULL DEFAULT ''"],
  ["removal_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["next_attempt_at", "TEXT NOT NULL DEFAULT ''"],
  ["removal_error", "TEXT NOT NULL DEFAULT ''"],
  ["removed_at", "TEXT NOT NULL DEFAULT ''"],
];

const builtIns = ["production", "preview", "development"] as const;

// variableStage names the stage whose variables a stage's builds and
// runtime use: an ephemeral stage uses Preview's, every other stage its own.
export function variableStage(stage: Pick<Stage, "kind" | "name">): string {
  return stage.kind === "ephemeral" ? "preview" : stage.name;
}

// hasOwnHost: does the stage have an address of its own (besides
// Production's, which is projects.edge_host)? Custom stages do, and
// ephemeral stages until their removal starts (the row keeps the host, so a
// retried removal still knows its certificate). Callers list stages with
// { includeEphemeral: true }.
export function hasOwnHost(stage: Pick<Stage, "kind" | "host"> & { removal?: StageRemoval }): boolean {
  if (stage.host === "") return false;
  if (stage.kind === "custom") return true;
  return stage.kind === "ephemeral" && (stage.removal ?? "") === "";
}

// validateStageName: null when name may be a custom stage's, else why not.
// 1 to 16 lowercase letters, digits and hyphens, starting with a letter and
// not ending with a hyphen; not exactly two characters; not a built-in's name; not "pv-..." (kept for
// ephemeral stages).
export function validateStageName(name: string): string | null {
  if (typeof name !== "string" || !/^[a-z]([-a-z0-9]{0,14}[a-z0-9])?$/.test(name)) {
    return "an environment name is 1 to 16 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen";
  }
  if ((builtIns as readonly string[]).includes(name)) return `"${name}" is a built-in environment`;
  // "qa" would make the address qa--<project>: a label with "--" in its 3rd
  // and 4th characters is reserved (RFC 5891), and Let's Encrypt refuses it.
  // Environments made before this rule keep their names.
  if (name.length === 2) return "environment names can't be exactly two characters long: the address would be a reserved DNS label (\"--\" as its 3rd and 4th characters)";
  // <stage>--<project> is the host; a "--" in the stage could make it equal another project's.
  if (name.includes("--")) return "environment names can't contain \"--\" (two hyphens in a row)";
  if (name.startsWith("pv-")) return 'environment names starting with "pv-" are reserved';
  // An app's functions run as "<app>-fn-<function>". A name with an "fn"
  // part could make one environment's app look like another's function
  // (stage "a" on Cloud Run is p..-s-a-cr; "a-cr-fn-x" would be p..-s-a-cr-fn-x-cr).
  if (/(^|-)fn(-|$)/.test(name)) return 'environment names can\'t contain "fn" as a part between hyphens';
  return null;
}

// validateHostLabel: null when label may start an ephemeral stage's address
// (<label>--<project>), else why not. validateStageName's DNS rules, up to
// 40 characters.
export function validateHostLabel(label: unknown): string | null {
  if (typeof label !== "string" || !/^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/.test(label)) {
    return "hostLabel is 1 to 40 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen";
  }
  if (label.length === 2) return "hostLabel can't be exactly two characters long: the address would be a reserved DNS label (\"--\" as its 3rd and 4th characters)";
  if (label.includes("--")) return "hostLabel can't contain \"--\" (two hyphens in a row)";
  return null;
}

// stageRowName names a custom stage's cloud row: s-<stage>-<slot>, where
// the slot is "cr" for Cloud Run, "k8s" for the dev cluster or kc_default,
// otherwise "k-" plus the first 6 hex of the cluster id's sha256. No
// Production row starts with "s-", so the two never collide.
export function stageRowName(stage: Pick<Stage, "name">, cloud: { target: string; clusterId?: string }): string {
  let slot: string;
  if (cloud.target === "cloudrun") slot = "cr";
  else if (cloud.clusterId === undefined || cloud.clusterId === "kc_default") slot = "k8s";
  else slot = `k-${createHash("sha256").update(cloud.clusterId).digest("hex").slice(0, 6)}`;
  return `s-${stage.name}-${slot}`;
}

// branchInUse names what already builds from branch in a project: "production"
// when it is the production branch, else the name of the custom environment
// on it, else null. exceptStageId skips one stage (the one being edited).
// A project with no git config has no production branch yet.
export function branchInUse(store: Store, projectId: string, branch: string, exceptStageId?: string): string | null {
  try {
    if (store.getGitConfig(projectId).productionBranch === branch) return "production";
  } catch (err) {
    if (!(err instanceof ErrNotFound)) throw err;
  }
  const other = store.listStages(projectId).find((s) => s.kind === "custom" && s.id !== exceptStageId && s.branch === branch);
  return other ? other.name : null;
}

const newStageID = (): string => `stg_${randomBytes(8).toString("hex")}`;

// insertBuiltInStages adds whichever built-in stages the project lacks.
export function insertBuiltInStages(db: DatabaseSync, projectId: string, createdAt: string): void {
  const insert = db.prepare("INSERT OR IGNORE INTO stages (id, project_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)");
  for (const name of builtIns) insert.run(newStageID(), projectId, name, name, createdAt);
}

// migrateStages gives every project its built-in stages and puts every
// cloud row, build and domain without a stage on Production; it also turns
// an earlier NBO's preview deployments into ephemeral stages. Its own
// transaction, after the column pass; a second run finds nothing to do.
export function migrateStages(db: DatabaseSync): void {
  const hasTable = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as unknown[]).length > 0;
  if (!hasTable("projects")) return;
  db.exec("BEGIN");
  try {
    db.exec(stagesSchema);
    const projects = db.prepare("SELECT p.id, p.created_at FROM projects p WHERE (SELECT COUNT(*) FROM stages s WHERE s.project_id = p.id AND s.kind IN ('production', 'preview', 'development')) < 3").all() as {
      id: string;
      created_at: string;
    }[];
    for (const p of projects) insertBuiltInStages(db, p.id, p.created_at);
    if (hasTable("environments")) {
      db.exec(
        "UPDATE environments SET stage_id = (SELECT s.id FROM stages s WHERE s.project_id = environments.project_id AND s.name = 'production') WHERE stage_id = '' AND EXISTS (SELECT 1 FROM stages s WHERE s.project_id = environments.project_id AND s.name = 'production')",
      );
    }
    if (hasTable("domains")) {
      db.exec(
        "UPDATE domains SET stage_id = (SELECT s.id FROM stages s WHERE s.project_id = domains.project_id AND s.name = 'production') WHERE stage_id = '' AND EXISTS (SELECT 1 FROM stages s WHERE s.project_id = domains.project_id AND s.name = 'production')",
      );
    }
    if (hasTable("builds")) {
      db.exec(
        "UPDATE builds SET stage_id = (SELECT s.id FROM stages s WHERE s.project_id = builds.project_id AND s.name = 'production') WHERE stage_id = '' AND EXISTS (SELECT 1 FROM stages s WHERE s.project_id = builds.project_id AND s.name = 'production')",
      );
    }
    migratePreviewDeployments(db, hasTable);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const DAY_MS = 24 * 3_600_000;
const removalStates = new Set<string>(["", "removing", "removal-failed", "removed"]);

type OldPreview = {
  host: string;
  pr_number: number;
  pr_state: string;
  last_push_at: string;
  status: string;
  remove_reason: string;
  error: string;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
};

// migratePreviewDeployments turns the preview deployments an earlier NBO
// made (kind "preview-deployment", each with a row in its previews table)
// into ephemeral stages that core expires on its own: label "pr #<n>" or the
// branch; expiry the preview's last push (or creation) plus its project's
// expire_after_days (7 without a settings row); the removal state, attempts,
// next attempt and error carried over; the host the previews row kept when
// removal had already cleared the stage's. A preview marked for removal
// that hadn't started (closed pull request, deleted branch) is "removing",
// so the first pass removes it. previews and preview_settings are only
// read, never changed. Only stages still of the old kind are touched, so a
// second run does nothing.
function migratePreviewDeployments(db: DatabaseSync, hasTable: (t: string) => boolean): void {
  const old = db.prepare("SELECT id, project_id, branch, host, created_at FROM stages WHERE kind = 'preview-deployment'").all() as {
    id: string;
    project_id: string;
    branch: string;
    host: string;
    created_at: string;
  }[];
  if (old.length === 0) return;
  const previews = hasTable("previews");
  const settings = hasTable("preview_settings");
  const update = db.prepare(
    "UPDATE stages SET kind = 'ephemeral', host = ?, expires_at = ?, label = ?, removal_status = ?, removal_attempts = ?, next_attempt_at = ?, removal_error = ? WHERE id = ?",
  );
  for (const s of old) {
    const p = previews
      ? (db.prepare("SELECT host, pr_number, pr_state, last_push_at, status, remove_reason, error, attempts, next_attempt_at, created_at FROM previews WHERE stage_id = ?").get(s.id) as
          | OldPreview
          | undefined)
      : undefined;
    const set = settings
      ? (db.prepare("SELECT expire_after_days, delete_on_close FROM preview_settings WHERE project_id = ?").get(s.project_id) as { expire_after_days: number; delete_on_close: number } | undefined)
      : undefined;
    const days = set && Number.isInteger(set.expire_after_days) && set.expire_after_days > 0 ? set.expire_after_days : 7;
    const times = [p?.last_push_at, p?.created_at, s.created_at].map((t) => Date.parse(t ?? "")).filter((t) => Number.isFinite(t));
    const from = times.length > 0 ? Math.max(...times) : Date.now();
    const expiresAt = new Date(from + days * DAY_MS).toISOString();
    let removal = p ? (p.status === "active" ? "" : p.status) : "";
    if (!removalStates.has(removal)) removal = "removing";
    if (p && removal === "" && (p.remove_reason !== "" || (p.pr_state === "closed" && (set?.delete_on_close ?? 1) === 1))) removal = "removing";
    const label = p && p.pr_number > 0 ? `pr #${p.pr_number}` : s.branch;
    const host = s.host !== "" ? s.host : (p?.host ?? "");
    update.run(host, expiresAt, label, removal, p?.attempts ?? 0, p?.next_attempt_at ?? "", p?.error ?? "", s.id);
  }
}

type Row = {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  branch: string;
  auto_deploy: number;
  host: string;
  last_seen_sha: string;
  created_at: string;
  expires_at: string;
  label: string;
  removal_status: string;
  removal_attempts: number;
  next_attempt_at: string;
  removal_error: string;
  removed_at: string;
};

const columns = "id, project_id, name, kind, branch, auto_deploy, host, last_seen_sha, created_at, expires_at, label, removal_status, removal_attempts, next_attempt_at, removal_error, removed_at";
const order = "CASE kind WHEN 'production' THEN 0 WHEN 'preview' THEN 1 WHEN 'development' THEN 2 ELSE 3 END, created_at, rowid";

function toStage(r: Row): Stage {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    kind: r.kind as StageKind,
    branch: r.branch,
    autoDeploy: r.auto_deploy === 1,
    host: r.host,
    lastSeenSha: r.last_seen_sha,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    label: r.label,
    removal: r.removal_status as StageRemoval,
    removalAttempts: r.removal_attempts,
    nextAttemptAt: r.next_attempt_at,
    removalError: r.removal_error,
    removedAt: r.removed_at,
  };
}

const isUnique = (err: unknown): boolean => err instanceof Error && err.message.includes("UNIQUE constraint failed");

// attachStageMethods mutates store in place, like attachDomainMethods.
export function attachStageMethods(db: DatabaseSync, store: Store): Store {
  Object.assign(store, {
    listStages(projectId: string, opts?: { includeEphemeral?: boolean }): Stage[] {
      const where = opts?.includeEphemeral ? "project_id = ?" : "project_id = ? AND kind != 'ephemeral'";
      return (db.prepare(`SELECT ${columns} FROM stages WHERE ${where} ORDER BY ${order}`).all(projectId) as Row[]).map(toStage);
    },

    getStage(id: string): Stage {
      const row = db.prepare(`SELECT ${columns} FROM stages WHERE id = ?`).get(id) as Row | undefined;
      if (!row) throw new ErrNotFound(`environment "${id}"`);
      return toStage(row);
    },

    getStageByName(projectId: string, name: string): Stage {
      const row = db.prepare(`SELECT ${columns} FROM stages WHERE project_id = ? AND name = ?`).get(projectId, name) as Row | undefined;
      if (!row) throw new ErrNotFound(`environment "${name}" in project "${projectId}"`);
      return toStage(row);
    },

    productionStage(projectId: string): Stage {
      return store.getStageByName(projectId, "production");
    },

    createStage(projectId: string, input: { name: string; branch: string; autoDeploy?: boolean; host: string }): Stage {
      store.getProject(projectId);
      const problem = validateStageName(input.name);
      if (problem) throw new ErrInvalid(problem);
      const taken = branchInUse(store, projectId, input.branch);
      if (taken) throw new ErrConflict(`the branch "${input.branch}" already builds the ${taken} environment`);
      const id = newStageID();
      try {
        db.prepare("INSERT INTO stages (id, project_id, name, kind, branch, auto_deploy, host, created_at) VALUES (?, ?, ?, 'custom', ?, ?, ?, ?)").run(
          id,
          projectId,
          input.name,
          input.branch,
          input.autoDeploy === false ? 0 : 1,
          input.host,
          new Date().toISOString(),
        );
      } catch (err) {
        if (isUnique(err)) throw new ErrDuplicateName(`an environment named "${input.name}" already exists`);
        throw err;
      }
      return store.getStage(id);
    },

    // createEphemeralStage makes an ephemeral stage named pv-<8 hex> on
    // branch with host. The caller checks the address and the branch.
    createEphemeralStage(projectId: string, input: { branch: string; host: string; expiresAt: string; label: string }): Stage {
      store.getProject(projectId);
      const id = newStageID();
      // The name is unique per project; retry the rare repeat.
      for (let i = 0; ; i++) {
        try {
          db.prepare("INSERT INTO stages (id, project_id, name, kind, branch, auto_deploy, host, created_at, expires_at, label) VALUES (?, ?, ?, 'ephemeral', ?, 1, ?, ?, ?, ?)").run(
            id,
            projectId,
            `pv-${randomBytes(4).toString("hex")}`,
            input.branch,
            input.host,
            new Date().toISOString(),
            input.expiresAt,
            input.label,
          );
          break;
        } catch (err) {
          if (!isUnique(err) || i >= 4) throw err;
        }
      }
      return store.getStage(id);
    },

    updateStage(id: string, patch: StagePatch): Stage {
      const next = { ...store.getStage(id), ...patch };
      if (!removalStates.has(next.removal)) throw new ErrInvalid(`unknown removal state "${String(next.removal)}"`);
      db.prepare(
        "UPDATE stages SET branch = ?, auto_deploy = ?, host = ?, last_seen_sha = ?, expires_at = ?, label = ?, removal_status = ?, removal_attempts = ?, next_attempt_at = ?, removal_error = ?, removed_at = ? WHERE id = ?",
      ).run(
        next.branch,
        next.autoDeploy ? 1 : 0,
        next.host,
        next.lastSeenSha,
        next.expiresAt,
        next.label,
        next.removal,
        next.removalAttempts,
        next.nextAttemptAt,
        next.removalError,
        next.removedAt,
        id,
      );
      return store.getStage(id);
    },

    // discardEphemeralStage undoes a createEphemeralStage whose clouds
    // couldn't be added: the stage, its cloud and domain rows, in one
    // transaction. Only for one that has no builds.
    discardEphemeralStage(id: string): void {
      const stage = store.getStage(id);
      if (stage.kind !== "ephemeral") throw new ErrInvalid(`the ${stage.name} environment isn't ephemeral`);
      const builds = (db.prepare("SELECT COUNT(*) AS n FROM builds WHERE stage_id = ?").get(id) as { n: number }).n;
      if (builds > 0) throw new ErrConflict(`the ${stage.name} environment has builds; remove it instead`);
      deleteStageRows(db, stage);
    },

    // deleteStage removes a custom stage, atomically: its cloud rows (with
    // their deployments and crons), its variables, its domains, and any
    // transfer that names one of its rows. Its builds stay in history; a
    // promote that targeted one of its rows keeps no target. Built-in
    // stages can't be deleted (ephemeral ones are removed, stage-expiry.ts).
    deleteStage(id: string): void {
      const stage = store.getStage(id);
      if (stage.kind !== "custom") throw new ErrInvalid(`the ${stage.name} environment is built in and can't be deleted`);
      deleteStageRows(db, stage);
    },
  });
  return store;
}

function deleteStageRows(db: DatabaseSync, stage: Stage): void {
  const id = stage.id;
  db.exec("BEGIN");
  try {
    const envIds = (db.prepare("SELECT id FROM environments WHERE stage_id = ?").all(id) as { id: string }[]).map((r) => r.id);
    for (const envId of envIds) {
      db.prepare("DELETE FROM deployments WHERE environment_id = ?").run(envId);
      db.prepare("DELETE FROM crons WHERE environment_id = ?").run(envId);
      db.prepare("DELETE FROM environment_cron_secrets WHERE environment_id = ?").run(envId);
    }
    for (const envId of envIds) {
      db.prepare("DELETE FROM transfers WHERE from_env_id = ? OR to_env_id = ?").run(envId, envId);
      db.prepare("UPDATE builds SET target_environment_id = '' WHERE target_environment_id = ?").run(envId);
    }
    db.prepare("DELETE FROM environments WHERE stage_id = ?").run(id);
    db.prepare("DELETE FROM env_vars WHERE project_id = ? AND stage = ?").run(stage.projectId, stage.name);
    db.prepare("DELETE FROM domain_pending_certs WHERE domain_id IN (SELECT id FROM domains WHERE stage_id = ?)").run(id);
    db.prepare("DELETE FROM domain_pasted_certs WHERE domain_id IN (SELECT id FROM domains WHERE stage_id = ?)").run(id);
    db.prepare("DELETE FROM domains WHERE stage_id = ?").run(id);
    // Before the stage row: foreign keys are on.
    db.prepare("DELETE FROM stage_revalidate_tokens WHERE stage_id = ?").run(id);
    db.prepare("DELETE FROM stages WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
