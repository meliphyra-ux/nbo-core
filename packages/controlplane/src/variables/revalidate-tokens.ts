// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { open, seal, secretKeyHooks } from "../store/secrets.js";
import type { Store } from "../store/store.js";
import type { ResolvedEnv } from "./env-vars.js";
import type { Stage } from "../stages/stages.js";

// REVALIDATE_TOKEN_ENV is the runtime variable an app's prerender routes
// read their bypass and revalidation secret from (bypassToken.env).
export const REVALIDATE_TOKEN_ENV = "NBO_PRERENDER_BYPASS";

// One revalidation secret per stage (environment), shared by that stage's
// clouds. NBO's own secret, like the cron signing secret: sealed with the
// same key as secret variables, and kept whatever "Don't store variable
// values" says (that setting is about values the user types). Rows go
// before their stage: deleteStage, discardEphemeralStage and deleteProject delete
// them first (foreign keys are on).
export const revalidateTokensSchema = `
CREATE TABLE IF NOT EXISTS stage_revalidate_tokens (
	stage_id TEXT PRIMARY KEY REFERENCES stages(id),
	token TEXT NOT NULL,
	created_at TEXT NOT NULL
);
`;

export interface RevalidateToken {
  token: string;
  createdAt: string;
}

const newToken = (): string => randomBytes(32).toString("base64url");

// attachRevalidateTokenMethods mutates store in place like
// attachRelayMethods, wrapping the secret-key hooks so token rows count as
// sealed data (a missing key file must not be silently replaced).
export function attachRevalidateTokenMethods(db: DatabaseSync, store: Store, initialKey?: Buffer): Store {
  const { needKey, hooks } = secretKeyHooks(store, initialKey, {
    hasSealed: () => (db.prepare("SELECT COUNT(*) AS n FROM stage_revalidate_tokens").get() as { n: number }).n > 0,
    verify: (k) => {
      for (const r of db.prepare("SELECT token FROM stage_revalidate_tokens").all() as { token: string }[])
        open(k, r.token);
    },
  });
  const read = (stageId: string): RevalidateToken | undefined => {
    const r = db.prepare("SELECT token, created_at FROM stage_revalidate_tokens WHERE stage_id = ?").get(stageId) as
      { token: string; created_at: string } | undefined;
    return r ? { token: open(needKey(), r.token), createdAt: r.created_at } : undefined;
  };
  const write = (stageId: string, replace: boolean): RevalidateToken => {
    store.getStage(stageId); // ErrNotFound for an unknown stage
    const sealed = seal(needKey(), newToken());
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO stage_revalidate_tokens (stage_id, token, created_at) VALUES (?, ?, ?)
       ON CONFLICT(stage_id) DO ${replace ? "UPDATE SET token = excluded.token, created_at = excluded.created_at" : "NOTHING"}`,
    ).run(stageId, sealed, now);
    return read(stageId)!;
  };

  Object.assign(store, {
    ...hooks,
    getRevalidateToken(stageId: string): RevalidateToken | undefined {
      return read(stageId);
    },
    ensureRevalidateToken(stageId: string): RevalidateToken {
      return read(stageId) ?? write(stageId, false);
    },
    rotateRevalidateToken(stageId: string): RevalidateToken {
      return write(stageId, true);
    },
  });
  return store;
}

// withRevalidateToken: env plus the stage's revalidation secret (created
// on first need) as a secret variable, in a new object. Keyed by the
// stage itself, so an ephemeral stage gets its own, never Preview's or Production's.
export function withRevalidateToken(store: Store, stage: Stage, env: ResolvedEnv): ResolvedEnv {
  const { token } = store.ensureRevalidateToken(stage.id);
  return {
    vars: { ...env.vars, [REVALIDATE_TOKEN_ENV]: token },
    secretNames: [...new Set([...env.secretNames, REVALIDATE_TOKEN_ENV])].sort(),
  };
}
