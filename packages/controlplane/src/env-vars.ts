// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ErrInvalidEnvVar, ErrNotFound } from "./errors.js";
import { redact } from "@nbo/deploy";
import { ErrSecretKey, open, seal } from "./secrets.js";
import type { Store } from "./store.js";

export interface EnvVarMeta {
  name: string;
  secret: boolean;
  updatedAt: string;
}
// value is present only when the variable is not secret and has a value.
export interface EnvVarView extends EnvVarMeta {
  // A stage name, or ALL_STAGES for every stage.
  stage: string;
  // false for a declared name (names only, or a value cleared when the
  // workspace stopped storing values).
  hasValue: boolean;
  value?: string;
}
export type ProjectEnvVarView = EnvVarView & { inherited?: boolean; overridden?: boolean };
// Full values — server-side only, never serialized to a client.
export interface ResolvedEnv {
  vars: Record<string, string>;
  secretNames: string[];
}

// ALL_STAGES is the stage value of a variable that applies to every stage.
export const ALL_STAGES = "*";
// Workspace variables belong to no project, so they can only name a built-in stage.
const WORKSPACE_STAGES = [ALL_STAGES, "production", "preview", "development"];

// The stage and has_value columns are added to older databases by migrate.ts (addedColumns),
// which also swaps the old unique index for env_vars_scope_stage_name once
// the column exists.
export const envVarsSchema = `
CREATE TABLE IF NOT EXISTS env_vars (
	project_id TEXT NULL REFERENCES projects(id),
	name TEXT NOT NULL,
	value TEXT NOT NULL,
	secret INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	stage TEXT NOT NULL DEFAULT 'production',
	has_value INTEGER NOT NULL DEFAULT 1
);
`;

const MAX_NAME = 256;
const MAX_VALUE_BYTES = 64 * 1024;
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED = new Set(["PORT", "K_SERVICE", "K_REVISION", "K_CONFIGURATION", "NEXT_ADAPTER_PATH"]);

// validateEnvName returns an error message, or null when the name is fine.
export function validateEnvName(name: string): string | null {
  if (typeof name !== "string" || name === "") return "variable name is required";
  if (name.length > MAX_NAME) return `variable name must be at most ${MAX_NAME} characters`;
  if (!NAME_RE.test(name)) return `variable name "${name}" must use only A-Z, 0-9 and _, and not start with a digit`;
  if (name.startsWith("NBO_") || RESERVED.has(name)) return `variable name "${name}" is reserved`;
  return null;
}

export function validateEnvValue(value: string): string | null {
  if (typeof value !== "string") return "variable value must be a string";
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) return "variable value must be at most 64 KiB";
  if (value.includes("\u0000")) return "variable value must not contain a NUL character";
  return null;
}

const FINGERPRINT_LABEL = "nbo-env-fingerprint";

// envFingerprint identifies a resolved variable set without revealing it:
// null when empty, else an HMAC (keyed from the secret key) over the
// canonical {name: value} map plus the sorted secret names, so any value,
// name or secret-flag change alters it.
export function envFingerprint(env: ResolvedEnv, secretKey: Buffer): string | null {
  const names = Object.keys(env.vars).sort();
  if (names.length === 0) return null;
  const hmacKey = createHmac("sha256", secretKey).update(FINGERPRINT_LABEL).digest();
  const vars: Record<string, string> = {};
  for (const n of names) vars[n] = env.vars[n]!;
  const canonical = JSON.stringify({ vars, secretNames: [...env.secretNames].sort() });
  return createHmac("sha256", hmacKey).update(canonical).digest("hex").slice(0, 32);
}

const SECRET_VALUE_LABEL = "nbo-secret-value-hash";

// envSecretHashes gives, for each secret name, an HMAC (keyed from the
// secret key, separately from the fingerprint's) over its name and value:
// 32 hex, labelled on the variable's Secret Manager secret so an
// unchanged value adds no version and nothing is ever read back.
export function envSecretHashes(env: ResolvedEnv, secretKey: Buffer): Record<string, string> {
  const hmacKey = createHmac("sha256", secretKey).update(SECRET_VALUE_LABEL).digest();
  const out: Record<string, string> = {};
  for (const name of [...env.secretNames].sort()) {
    out[name] = createHmac("sha256", hmacKey)
      .update(JSON.stringify([name, env.vars[name] ?? ""]))
      .digest("hex")
      .slice(0, 32);
  }
  return out;
}

type Row = { project_id: string | null; name: string; value: string; secret: number; updated_at: string; stage: string; has_value: number };

// The 400 a value gets when the workspace keeps names only.
export const namesOnlyMessage = "This NBO doesn't store variable values. Send them with each deploy.";
const storedRefusal = "This NBO stores variable values, so a deploy takes none: set them with PUT /projects/{id}/env/{name} or Terraform's nbo_env_var";

// With names only, a plain value shorter than this may appear in a log if
// the build prints it (documented): redacting it would mangle ordinary words.
export const minRedactedPlainLength = 6;

// redactionsFor is what never reaches a log or an error: every secret value,
// and with names only also every plain value of 6+ characters.
export function redactionsFor(env: ResolvedEnv, namesOnly: boolean): string[] {
  const out = env.secretNames.map((n) => env.vars[n] ?? "");
  if (namesOnly) {
    const secret = new Set(env.secretNames);
    for (const [n, v] of Object.entries(env.vars)) if (!secret.has(n) && v.length >= minRedactedPlainLength) out.push(v);
  }
  return out.filter((v) => v !== "");
}

// attachEnvMethods mutates store in place like attachConnectionMethods. It
// wraps setSecretKey/hasSealedSecrets/verifySecretKey so secret variables
// count as sealed data (a missing key file must not be silently replaced).
export function attachEnvMethods(db: DatabaseSync, store: Store, initialKey?: Buffer): Store {
  let key: Buffer | undefined = initialKey;
  const needKey = (): Buffer => {
    if (!key) throw new ErrSecretKey("no secret key loaded");
    return key;
  };

  const view = (r: Row): EnvVarView => {
    const v: EnvVarView = { name: r.name, stage: r.stage, secret: r.secret === 1, hasValue: r.has_value === 1, updatedAt: r.updated_at };
    if (r.secret !== 1 && r.has_value === 1) v.value = r.value;
    return v;
  };
  const rows = (projectId: string | null): Row[] =>
    (projectId === null
      ? db.prepare("SELECT * FROM env_vars WHERE project_id IS NULL ORDER BY name, stage").all()
      : db.prepare("SELECT * FROM env_vars WHERE project_id = ? ORDER BY name, stage").all(projectId)) as Row[];
  const getRow = (projectId: string | null, name: string, stage: string): Row | undefined =>
    db.prepare("SELECT * FROM env_vars WHERE COALESCE(project_id, '') = ? AND stage = ? AND name = ?").get(projectId ?? "", stage, name) as Row | undefined;
  // A workspace variable takes a built-in stage or "*"; a project one takes "*" or
  // one of the project's stages (an unknown one is a 404).
  const checkStage = (projectId: string | null, stage: string): void => {
    if (projectId === null) {
      if (!WORKSPACE_STAGES.includes(stage)) {
        throw new ErrInvalidEnvVar(`workspace variables apply to all environments, Production, Preview or Development, not "${stage}"`);
      }
    } else if (stage !== ALL_STAGES) {
      // An ephemeral stage (pv-...) has no variables of its own: it uses Preview's.
      if (store.getStageByName(projectId, stage).kind === "ephemeral") {
        throw new ErrInvalidEnvVar(`"${stage}" is an ephemeral environment; set its variables on the Preview environment`);
      }
    }
  };
  const plain = (r: Row): string => (r.secret === 1 ? open(needKey(), r.value) : r.value);
  const namesOnly = (): boolean => store.getServerSettings().envValues === "none";
  // The rows that apply to a stage, later winning: workspace "*",
  // workspace S, project "*", project S.
  const ordered = (projectId: string, stage: string): Row[] => {
    const forStage = (rs: Row[], s: string): Row[] => rs.filter((r) => r.stage === s);
    const ws = rows(null);
    const own = rows(projectId);
    return [...forStage(ws, ALL_STAGES), ...forStage(ws, stage), ...forStage(own, ALL_STAGES), ...forStage(own, stage)];
  };

  const origSetKey = store.setSecretKey.bind(store);
  const origHasSealed = store.hasSealedSecrets.bind(store);
  const origVerify = store.verifySecretKey.bind(store);

  Object.assign(store, {
    setSecretKey(k: Buffer): void {
      key = k;
      origSetKey(k);
    },
    hasSealedSecrets(): boolean {
      // A declared secret (has_value = 0) holds no sealed value.
      return origHasSealed() || (db.prepare("SELECT COUNT(*) AS n FROM env_vars WHERE secret = 1 AND has_value = 1").get() as { n: number }).n > 0;
    },
    verifySecretKey(): void {
      origVerify();
      const k = needKey();
      for (const r of db.prepare("SELECT value FROM env_vars WHERE secret = 1 AND has_value = 1").all() as { value: string }[]) open(k, r.value);
    },
    listWorkspaceEnv(): EnvVarView[] {
      return rows(null).map(view);
    },
    listProjectEnv(projectId: string): ProjectEnvVarView[] {
      store.getProject(projectId);
      const own = rows(projectId);
      // Inherited and overridden are per (name, stage).
      const key = (r: Row): string => JSON.stringify([r.name, r.stage]);
      const ownKeys = new Set(own.map(key));
      const ws = rows(null);
      const wsKeys = new Set(ws.map(key));
      const out: ProjectEnvVarView[] = [
        ...own.map((r) => (wsKeys.has(key(r)) ? { ...view(r), overridden: true } : view(r))),
        ...ws.filter((r) => !ownKeys.has(key(r))).map((r) => ({ ...view(r), inherited: true })),
      ];
      const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
      return out.sort((a, b) => cmp(a.name, b.name) || cmp(a.stage, b.stage));
    },
    // value null declares the name without a value (the only way while the
    // workspace keeps names only).
    setEnv(scope: { projectId: string | null }, name: string, value: string | null, secret: boolean, stage = "production"): EnvVarView {
      const nameErr = validateEnvName(name);
      if (nameErr) throw new ErrInvalidEnvVar(nameErr);
      if (value !== null) {
        if (namesOnly()) throw new ErrInvalidEnvVar(namesOnlyMessage);
        const valueErr = validateEnvValue(value);
        if (valueErr) throw new ErrInvalidEnvVar(valueErr);
        // Secret Manager holds no empty payloads; an empty secret is a mistake anyway.
        if (secret && value === "") throw new ErrInvalidEnvVar("Secret values can't be empty");
      }
      if (scope.projectId !== null) store.getProject(scope.projectId);
      checkStage(scope.projectId, stage);
      const existing = getRow(scope.projectId, name, stage);
      if (existing && existing.secret === 1 && !secret) {
        throw new ErrInvalidEnvVar(`variable "${name}" is secret and cannot be made plain; delete it and add it again`);
      }
      const stored = value === null ? "" : secret ? seal(needKey(), value) : value;
      db.prepare(
        `INSERT INTO env_vars (project_id, name, value, secret, updated_at, stage, has_value) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (COALESCE(project_id, ''), stage, name) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at, has_value = excluded.has_value`,
      ).run(scope.projectId, name, stored, secret ? 1 : 0, new Date().toISOString(), stage, value === null ? 0 : 1);
      return view(getRow(scope.projectId, name, stage)!);
    },
    deleteEnv(scope: { projectId: string | null }, name: string, stage = "production"): void {
      checkStage(scope.projectId, stage);
      const res = db.prepare("DELETE FROM env_vars WHERE COALESCE(project_id, '') = ? AND stage = ? AND name = ?").run(scope.projectId ?? "", stage, name);
      if (res.changes === 0) throw new ErrNotFound(`variable "${name}"`);
    },
    // Later wins: workspace "*", workspace S, project "*", project S.
    // Stored values: rows without a value are skipped, and supplied values
    // are refused (one source at a time; an empty map counts as none).
    // Names only: the stage's declared names take their values from
    // supplied, which must name each of them and nothing else. Error texts
    // name variables, never a value.
    resolveEnv(projectId: string, stage = "production", supplied?: Record<string, string>): ResolvedEnv {
      store.getProject(projectId);
      const vars: Record<string, string> = {};
      const secrets = new Set<string>();
      const rs = ordered(projectId, stage);
      if (!namesOnly()) {
        if (supplied && Object.keys(supplied).length > 0) throw new ErrInvalidEnvVar(storedRefusal);
        for (const r of rs) {
          if (r.has_value !== 1) continue;
          vars[r.name] = plain(r);
          if (r.secret === 1) secrets.add(r.name);
          else secrets.delete(r.name);
        }
        return { vars, secretNames: [...secrets].sort() };
      }
      for (const r of rs) {
        if (r.secret === 1) secrets.add(r.name);
        else secrets.delete(r.name);
      }
      const declared = [...new Set(rs.map((r) => r.name))].sort();
      const given = supplied ?? {};
      const undeclared = Object.keys(given)
        .filter((n) => !declared.includes(n))
        .sort();
      if (undeclared.length > 0) {
        throw new ErrInvalidEnvVar(`${undeclared.join(", ")} ${undeclared.length === 1 ? "isn't" : "aren't"} declared for ${stage}: declare it first, plain or secret`);
      }
      const missing = declared.filter((n) => !Object.prototype.hasOwnProperty.call(given, n));
      if (missing.length > 0) throw new ErrInvalidEnvVar(`values are missing for ${missing.join(", ")}`);
      for (const n of declared) {
        const v = given[n]!;
        const err = validateEnvValue(v);
        if (err) throw new ErrInvalidEnvVar(`${n}: ${err}`);
        if (secrets.has(n) && v === "") throw new ErrInvalidEnvVar(`${n}: Secret values can't be empty`);
        vars[n] = v;
      }
      return { vars, secretNames: [...secrets].sort() };
    },
    // declaredEnvNames: every name that applies to a stage, valued or not.
    declaredEnvNames(projectId: string, stage = "production"): string[] {
      store.getProject(projectId);
      return [...new Set(ordered(projectId, stage).map((r) => r.name))].sort();
    },
    // clearStoredValues turns names only on. In one transaction: the
    // current values are redacted from build logs, build errors and notes
    // and deployment errors (secrets, and plain values of 6+ characters, as
    // with names only's logs), every value is blanked (names, stages and
    // secret flags stay) and the setting is saved. Then, with secure_delete
    // on for this connection from here on, VACUUM rebuilds the file, so
    // freed pages (values edited or deleted earlier, old ciphertext, the old
    // log text) leave the database file, not only its rows. The rollback
    // journal is unlinked, not overwritten: the disk's free blocks may still
    // hold old pages until reused (documented).
    clearStoredValues(): void {
      const valued = db.prepare("SELECT value, secret FROM env_vars WHERE has_value = 1").all() as { value: string; secret: number }[];
      const scrub = [
        ...valued.filter((r) => r.secret === 1).map((r) => open(needKey(), r.value)),
        ...valued.filter((r) => r.secret !== 1 && r.value.length >= minRedactedPlainLength).map((r) => r.value),
      ].filter((v) => v !== "");
      db.exec("PRAGMA secure_delete = ON");
      db.exec("BEGIN");
      try {
        if (scrub.length > 0) {
          const buildRows = db.prepare("SELECT id, log, error, note FROM builds").all() as { id: string; log: string; error: string; note: string }[];
          const updateBuild = db.prepare("UPDATE builds SET log = ?, error = ?, note = ? WHERE id = ?");
          for (const b of buildRows) {
            const next = [redact(b.log, scrub), redact(b.error, scrub), redact(b.note, scrub)] as const;
            if (next[0] !== b.log || next[1] !== b.error || next[2] !== b.note) updateBuild.run(next[0], next[1], next[2], b.id);
          }
          const depRows = db.prepare("SELECT id, error FROM deployments").all() as { id: string; error: string }[];
          const updateDep = db.prepare("UPDATE deployments SET error = ? WHERE id = ?");
          for (const d of depRows) {
            const next = redact(d.error, scrub);
            if (next !== d.error) updateDep.run(next, d.id);
          }
        }
        db.prepare("UPDATE env_vars SET value = '', has_value = 0").run();
        db.prepare("INSERT INTO server_settings (key, value) VALUES ('env_values', 'none') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      db.exec("VACUUM");
      const mode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
      if (mode.toLowerCase() === "wal") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    envFingerprintFor(env: ResolvedEnv): string | null {
      if (Object.keys(env.vars).length === 0) return null;
      return envFingerprint(env, needKey());
    },
    envSecretHashes(env: ResolvedEnv): Record<string, string> {
      return env.secretNames.length === 0 ? {} : envSecretHashes(env, needKey());
    },
  });
  return store;
}
