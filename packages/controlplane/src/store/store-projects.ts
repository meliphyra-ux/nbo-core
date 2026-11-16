// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Store methods for projects: create, read, update and delete with everything under them.
import type { DatabaseSync } from "node:sqlite";
import { ErrDuplicateName, ErrNotFound } from "./errors.js";
import { removeArtifactsSync } from "../builds/artifacts.js";
import { insertBuiltInStages } from "../stages/stages.js";
import {
  isUniqueConstraintViolation,
  newID,
  nowUTC,
  projectColumns,
  rowToProject,
  type ProjectRow,
} from "./store-rows.js";
import type { Project, ProjectPatch, Store } from "./store-types.js";

// options.artifactsDir: deleting a project also deletes its builds' stored output there.
export function projectMethods(
  db: DatabaseSync,
  options?: { artifactsDir?: string },
): Pick<Store, "createProject" | "listProjects" | "getProject" | "updateProject" | "deleteProject"> & ThisType<Store> {
  return {
    createProject(name: string): Project {
      const p: Project = {
        id: newID("proj"),
        name,
        createdAt: nowUTC(),
        edgeHost: "",
        pollingEnabled: true,
        lastSeenSha: "",
        setupStatus: "ready",
        setupError: "",
        speedInsights: false,
        speedInsightsInject: true,
        speedInsightsSampleRate: 100,
        lastWebhookAt: "",
        skipFirstBuild: false,
        keyWaitSince: "",
      };
      // The project and its built-in stages, together.
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(p.id, p.name, p.createdAt);
        insertBuiltInStages(db, p.id, p.createdAt);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        if (isUniqueConstraintViolation(err)) {
          throw new ErrDuplicateName(`project "${name}" already exists`);
        }
        throw err;
      }
      return p;
    },

    listProjects(): Project[] {
      const rows = db.prepare(`SELECT ${projectColumns} FROM projects ORDER BY created_at`).all() as ProjectRow[];
      return rows.map(rowToProject);
    },

    getProject(id: string): Project {
      const row = db.prepare(`SELECT ${projectColumns} FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
      if (!row) throw new ErrNotFound(`project "${id}"`);
      return rowToProject(row);
    },

    updateProject(id: string, patch: ProjectPatch): Project {
      const current = this.getProject(id);
      const next = { ...current, ...patch };
      db.prepare(
        "UPDATE projects SET edge_host = ?, polling_enabled = ?, last_seen_sha = ?, setup_status = ?, setup_error = ?, speed_insights = ?, speed_insights_inject = ?, speed_insights_sample = ?, last_webhook_at = ?, skip_first_build = ?, key_wait_since = ? WHERE id = ?",
      ).run(
        next.edgeHost,
        next.pollingEnabled ? 1 : 0,
        next.lastSeenSha,
        next.setupStatus,
        next.setupError,
        next.speedInsights ? 1 : 0,
        next.speedInsightsInject ? 1 : 0,
        next.speedInsightsSampleRate,
        next.lastWebhookAt,
        next.skipFirstBuild ? 1 : 0,
        next.keyWaitSince,
        id,
      );
      // A head set here (setup's first read) gets its time, as advanceHead
      // records one, so an older push replayed later can't pass as newer.
      if (next.lastSeenSha !== current.lastSeenSha)
        db.prepare("UPDATE projects SET last_seen_at = ? WHERE id = ?").run(Date.now(), id);
      return next;
    },

    deleteProject(id: string): void {
      this.getProject(id);
      const envIds = (db.prepare("SELECT id FROM environments WHERE project_id = ?").all(id) as { id: string }[]).map(
        (r) => r.id,
      );
      const buildIds = (db.prepare("SELECT id FROM builds WHERE project_id = ?").all(id) as { id: string }[]).map(
        (r) => r.id,
      );
      const hasTable = (name: string): boolean =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
      db.exec("BEGIN");
      try {
        for (const envId of envIds) {
          db.prepare("DELETE FROM deployments WHERE environment_id = ?").run(envId);
          db.prepare("DELETE FROM crons WHERE environment_id = ?").run(envId);
          db.prepare("DELETE FROM environment_cron_secrets WHERE environment_id = ?").run(envId);
        }
        db.prepare("DELETE FROM environments WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM builds WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM transfers WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM project_git_config WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM project_webhook_secrets WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM project_git_credentials WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM env_vars WHERE project_id = ?").run(id);
        db.prepare(
          "DELETE FROM domain_pending_certs WHERE domain_id IN (SELECT id FROM domains WHERE project_id = ?)",
        ).run(id);
        db.prepare(
          "DELETE FROM domain_pasted_certs WHERE domain_id IN (SELECT id FROM domains WHERE project_id = ?)",
        ).run(id);
        db.prepare("DELETE FROM domains WHERE project_id = ?").run(id);
        // Ephemeral certificate orders stay: they count against Let's Encrypt
        // whatever happens to the project. An earlier NBO's preview and Speed
        // Insights tables (gone from a fresh database) lose the project's rows
        // only where they exist.
        for (const t of ["vitals", "preview_settings", "previews", "preview_branch_heads"]) {
          if (hasTable(t)) db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(id);
        }
        db.prepare(
          "DELETE FROM stage_revalidate_tokens WHERE stage_id IN (SELECT id FROM stages WHERE project_id = ?)",
        ).run(id);
        db.prepare("DELETE FROM stages WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM projects WHERE id = ?").run(id);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      // After the commit: the rows are gone either way; a file that
      // cannot be removed must not undo the delete.
      if (options?.artifactsDir) {
        try {
          removeArtifactsSync(options.artifactsDir, buildIds);
        } catch {
          // best effort
        }
      }
    },
  };
}
