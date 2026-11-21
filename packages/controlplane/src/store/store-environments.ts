// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Store methods for a project's cloud environments: create, list, update, archive and revive.
import type { DatabaseSync } from "node:sqlite";
import { ErrDuplicateName, ErrInvalidEnvironmentConfig, ErrNotFound } from "./errors.js";
import {
  environmentColumns,
  isUniqueConstraintViolation,
  newID,
  nowUTC,
  rowToEnvironment,
  validEnvironmentName,
  validTargets,
  type EnvironmentRow,
} from "./store-rows.js";
import type { Environment, Store } from "./store-types.js";

export function environmentMethods(
  db: DatabaseSync,
): Pick<
  Store,
  | "createEnvironment"
  | "listEnvironments"
  | "getEnvironment"
  | "updateEnvironmentConfig"
  | "setTrafficWeights"
  | "archiveEnvironment"
  | "reviveEnvironment"
  | "setEnvironmentAutoDeploy"
> &
  ThisType<Store> {
  return {
    createEnvironment(projectId: string, name: string, target: string, config?: string, stageId?: string): Environment {
      this.getProject(projectId); // throws ErrNotFound if missing
      // A row made without a stage is Production's, never "" (which every
      // default listEnvironments caller would miss).
      const stage =
        stageId === undefined
          ? (this as unknown as Store).productionStage(projectId)
          : (this as unknown as Store).getStage(stageId);
      if (stage.projectId !== projectId)
        throw new ErrNotFound(`environment stage "${stageId}" in project "${projectId}"`);
      if (!validEnvironmentName.test(name)) {
        throw new ErrInvalidEnvironmentConfig(
          `environment name "${name}" must be a short, lowercase, DNS-1123-shaped identifier`,
        );
      }
      if (!validTargets[target]) {
        throw new ErrInvalidEnvironmentConfig(`unknown target "${target}" (known: kubernetes, cloudrun, lambda)`);
      }
      const cfg = config && config.length > 0 ? config : "{}";
      // Adding a cloud back after archiving it revives the archived row
      // of that name (names are unique per project, archived ones too).
      const archived = db
        .prepare(`SELECT ${environmentColumns} FROM environments WHERE project_id = ? AND name = ? AND archived = 1`)
        .get(projectId, name) as EnvironmentRow | undefined;
      if (archived) {
        if (archived.target !== target)
          throw new ErrDuplicateName(`an archived ${archived.target} environment of this project is named "${name}"`);
        if (archived.stage_id !== stage.id)
          throw new ErrDuplicateName(`an archived environment of another stage of this project is named "${name}"`);
        return this.reviveEnvironment(archived.id, cfg);
      }
      const e: Environment = {
        id: newID("env"),
        projectId,
        name,
        target,
        config: cfg,
        createdAt: nowUTC(),
        trafficWeight: 0,
        archived: false,
        autoDeploy: true,
        stageId: stage.id,
      };
      try {
        db.prepare(
          "INSERT INTO environments (id, project_id, name, target, config, created_at, stage_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(e.id, e.projectId, e.name, e.target, e.config, e.createdAt, e.stageId);
      } catch (err) {
        if (isUniqueConstraintViolation(err)) {
          throw new ErrDuplicateName(`environment "${name}" in project "${projectId}"`);
        }
        throw err;
      }
      return e;
    },

    listEnvironments(
      projectId: string,
      options?: { includeArchived?: boolean; stageId?: string; allStages?: boolean },
    ): Environment[] {
      // Without stageId or allStages: Production's rows only, so a custom
      // stage's row never joins Production's split, transfers or summary.
      const where = ["project_id = ?"];
      const args: string[] = [projectId];
      if (!options?.includeArchived) where.push("archived = 0");
      if (options?.stageId !== undefined) {
        where.push("stage_id = ?");
        args.push(options.stageId);
      } else if (!options?.allStages) {
        where.push("stage_id = (SELECT id FROM stages WHERE project_id = ? AND name = 'production')");
        args.push(projectId);
      }
      const rows = db
        .prepare(`SELECT ${environmentColumns} FROM environments WHERE ${where.join(" AND ")} ORDER BY created_at`)
        .all(...args) as EnvironmentRow[];
      return rows.map(rowToEnvironment);
    },

    getEnvironment(id: string): Environment {
      const row = db.prepare(`SELECT ${environmentColumns} FROM environments WHERE id = ?`).get(id) as
        EnvironmentRow | undefined;
      if (!row) throw new ErrNotFound(`environment "${id}"`);
      return rowToEnvironment(row);
    },

    updateEnvironmentConfig(id: string, config: string): void {
      this.getEnvironment(id);
      db.prepare("UPDATE environments SET config = ? WHERE id = ?").run(config, id);
    },

    setTrafficWeights(projectId: string, weights: Record<string, number>, stageId?: string): void {
      const live = new Set(this.listEnvironments(projectId, stageId ? { stageId } : undefined).map((e) => e.id));
      for (const envId of Object.keys(weights)) {
        if (!live.has(envId)) throw new ErrNotFound(`environment "${envId}" in project "${projectId}"`);
      }
      for (const [envId, weight] of Object.entries(weights)) {
        db.prepare("UPDATE environments SET traffic_weight = ? WHERE id = ?").run(weight, envId);
      }
    },

    archiveEnvironment(id: string): void {
      this.getEnvironment(id);
      db.prepare("UPDATE environments SET archived = 1, traffic_weight = 0 WHERE id = ?").run(id);
    },

    reviveEnvironment(id: string, config: string): Environment {
      if (!this.getEnvironment(id).archived) throw new ErrDuplicateName(`environment "${id}" is not archived`);
      const last = db
        .prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM deployments WHERE environment_id = ?")
        .get(id) as { n: number };
      db.prepare(
        "UPDATE environments SET archived = 0, traffic_weight = 0, auto_deploy = 1, config = ?, deployments_after = ? WHERE id = ?",
      ).run(config && config.length > 0 ? config : "{}", last.n, id);
      return this.getEnvironment(id);
    },

    setEnvironmentAutoDeploy(id: string, on: boolean): void {
      this.getEnvironment(id);
      db.prepare("UPDATE environments SET auto_deploy = ? WHERE id = ?").run(on ? 1 : 0, id);
    },
  };
}
