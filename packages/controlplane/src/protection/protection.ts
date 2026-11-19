// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import { randomBytes, scrypt } from "node:crypto";
import type { Store } from "../store/store.js";
import type { Stage } from "../stages/stages.js";
import type { ResolvedEnv } from "../variables/env-vars.js";

// Deployment protection: a password in front of a project's sites, for every environment but Production
// ("previews") or for all of them. Core keeps the mode and a salted scrypt hash, never the password; a
// protected stage's deploys carry the hash as the secret variable NBO_PROTECTION, which nbo serve checks
// (packages/serve/src/protection.ts verifies the same format).
// How it behaves for users: docs/manual/protection.md.

export const PROTECTION_ENV = "NBO_PROTECTION";

export type ProtectionMode = "off" | "previews" | "all";
export const PROTECTION_MODES: readonly ProtectionMode[] = ["off", "previews", "all"];

export interface Protection {
  mode: ProtectionMode;
  // The scrypt hash; "" when no password was ever set.
  hash: string;
}

// Rows go before their project (store-projects.ts deleteProject deletes them first).
export const protectionSchema = `
CREATE TABLE IF NOT EXISTS project_protection (
	project_id TEXT PRIMARY KEY REFERENCES projects(id),
	mode TEXT NOT NULL,
	password_hash TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL
);
`;

const N = 16384;
const R = 8;
const P = 1;

/** scrypt$16384$8$1$<salt b64url>$<32-byte key b64url>, with a fresh 16-byte salt unless one is given (tests). */
export async function hashPassword(password: string, salt: Buffer = randomBytes(16)): Promise<string> {
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 32, { N, r: R, p: P }, (err, k) => (err ? reject(err) : resolve(k))),
  );
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Whether a stage's sites need the password. */
export function stageProtected(p: Protection, stage: Pick<Stage, "kind">): boolean {
  if (p.hash === "") return false;
  return p.mode === "all" || (p.mode === "previews" && stage.kind !== "production");
}

/**
 * The stages whose visitors see a difference: protected before and not after (or the reverse), or
 * protected both times with a new password (every old cookie stops working).
 */
export function affectedStages<S extends Pick<Stage, "kind">>(before: Protection, after: Protection, stages: S[]): S[] {
  return stages.filter((s) => {
    const was = stageProtected(before, s);
    const is = stageProtected(after, s);
    return was !== is || (is && before.hash !== after.hash);
  });
}

/** env plus NBO_PROTECTION as a secret variable when the stage is protected; env itself otherwise. */
export function withProtection(store: Store, stage: Stage, env: ResolvedEnv): ResolvedEnv {
  const p = store.getProtection(stage.projectId);
  if (!stageProtected(p, stage)) return env;
  return {
    vars: { ...env.vars, [PROTECTION_ENV]: p.hash },
    secretNames: [...new Set([...env.secretNames, PROTECTION_ENV])].sort(),
  };
}

// attachProtectionMethods mutates store in place, like the other attach* helpers.
export function attachProtectionMethods(db: DatabaseSync, store: Store): Store {
  Object.assign(store, {
    getProtection(projectId: string): Protection {
      const r = db.prepare("SELECT mode, password_hash FROM project_protection WHERE project_id = ?").get(projectId) as
        { mode: ProtectionMode; password_hash: string } | undefined;
      return r ? { mode: r.mode, hash: r.password_hash } : { mode: "off", hash: "" };
    },
    setProtection(projectId: string, mode: ProtectionMode, hash: string): void {
      store.getProject(projectId); // ErrNotFound for an unknown project
      db.prepare(
        `INSERT INTO project_protection (project_id, mode, password_hash, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET mode = excluded.mode, password_hash = excluded.password_hash,
         updated_at = excluded.updated_at`,
      ).run(projectId, mode, hash, new Date().toISOString());
    },
  });
  return store;
}
