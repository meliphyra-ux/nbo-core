// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../store/store.js";

// The last seen head of each branch NBO builds from: Production's on the
// project row, a custom environment's on its stage row. The poller, the
// per-project webhook and manual builds move it through advanceHead, so one
// push is built once whichever of them sees it first.
export interface GitHeadsStore {
  // advanceHead moves the last seen head of Production (no stageId, or
  // Production's) or of a custom or ephemeral stage; true only for the caller that changed
  // it. With before (a push payload's "before", or the head a poll read before
  // ls-remote) it is a compare-and-set: the stored head must be before or
  // empty, so an older push arriving late never wins over a newer one.
  // Without it, it advances whenever sha differs.
  // opts.at (ms) is recorded with the head as the time of the push (or poll,
  // or manual build) that set it. opts.newer also lets a compare-and-set
  // miss through when at is later than the stored head's time, so a head
  // that went stale (branch changed, manual build, a given-up delivery)
  // doesn't block every later push, while an older delivery arriving late
  // still loses.
  advanceHead(
    projectId: string,
    sha: string,
    stageId?: string,
    before?: string,
    opts?: { at?: number; newer?: boolean },
  ): boolean;
  // headSeenAt: the time recorded with the stored head (0 = unknown).
  headSeenAt(projectId: string, stageId?: string): number;
}

// attachGitHeadMethods mutates store in place, like attachGitMethods.
export function attachGitHeadMethods(db: DatabaseSync, store: Store): Store {
  const methods: GitHeadsStore = {
    advanceHead(projectId, sha, stageId, before, opts = {}) {
      // One UPDATE either way, so two callers can't both see true.
      const at = opts.at !== undefined && Number.isFinite(opts.at) ? Math.max(0, Math.floor(opts.at)) : undefined;
      const newer = opts.newer === true && at !== undefined;
      const guard =
        before === undefined
          ? ""
          : ` AND (last_seen_sha = ? OR last_seen_sha = ''${newer ? " OR last_seen_at < ?" : ""})`;
      const guardArgs = before === undefined ? [] : newer ? [before, at!] : [before];
      const setAt = at === undefined ? "" : ", last_seen_at = ?";
      const setArgs = at === undefined ? [] : [at];
      if (stageId !== undefined) {
        const stage = db.prepare("SELECT kind FROM stages WHERE id = ? AND project_id = ?").get(stageId, projectId) as
          { kind: string } | undefined;
        if (!stage) return false;
        if (stage.kind === "custom" || stage.kind === "ephemeral") {
          const r = db
            .prepare(
              `UPDATE stages SET last_seen_sha = ?${setAt} WHERE id = ? AND project_id = ? AND last_seen_sha <> ?${guard}`,
            )
            .run(sha, ...setArgs, stageId, projectId, sha, ...guardArgs);
          return Number(r.changes) === 1;
        }
        // Only Production, custom and ephemeral stages track a head.
        if (stage.kind !== "production") return false;
      }
      const r = db
        .prepare(`UPDATE projects SET last_seen_sha = ?${setAt} WHERE id = ? AND last_seen_sha <> ?${guard}`)
        .run(sha, ...setArgs, projectId, sha, ...guardArgs);
      return Number(r.changes) === 1;
    },

    headSeenAt(projectId, stageId) {
      if (stageId !== undefined) {
        const row = db
          .prepare("SELECT kind, last_seen_at FROM stages WHERE id = ? AND project_id = ?")
          .get(stageId, projectId) as { kind: string; last_seen_at: number } | undefined;
        if (!row) return 0;
        if (row.kind === "custom" || row.kind === "ephemeral") return Number(row.last_seen_at);
      }
      const row = db.prepare("SELECT last_seen_at FROM projects WHERE id = ?").get(projectId) as
        { last_seen_at: number } | undefined;
      return row ? Number(row.last_seen_at) : 0;
    },
  };
  Object.assign(store, methods);
  return store;
}
