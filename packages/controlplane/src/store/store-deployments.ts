// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Store methods for deployments and cloud-to-cloud transfers.
import type { DatabaseSync } from "node:sqlite";
import { ErrNotFound } from "./errors.js";
import {
  deploymentColumns,
  newID,
  nowUTC,
  rowToDeployment,
  rowToTransfer,
  transferColumns,
  type DeploymentRow,
  type TransferRow,
} from "./store-rows.js";
import type { Deployment, Store, Transfer } from "./store-types.js";

export function deploymentMethods(
  db: DatabaseSync,
): Pick<
  Store,
  | "createDeployment"
  | "completeDeployment"
  | "failDeployment"
  | "listDeployments"
  | "getDeployment"
  | "createTransfer"
  | "updateTransfer"
  | "getTransfer"
  | "getLatestTransfer"
  | "getActiveTransfer"
> &
  ThisType<Store> {
  return {
    createDeployment(environmentId: string, opts?: { buildId?: string }): Deployment {
      this.getEnvironment(environmentId); // throws ErrNotFound if missing
      const d: Deployment = {
        id: newID("dep"),
        environmentId,
        contentId: "",
        status: "pending",
        url: "",
        error: "",
        createdAt: nowUTC(),
        buildId: opts?.buildId ?? "",
      };
      db.prepare(
        "INSERT INTO deployments (id, environment_id, status, created_at, build_id) VALUES (?, ?, ?, ?, ?)",
      ).run(d.id, d.environmentId, d.status, d.createdAt, d.buildId);
      return d;
    },

    completeDeployment(id: string, contentId: string, url: string): void {
      db.prepare("UPDATE deployments SET status = 'succeeded', content_id = ?, url = ? WHERE id = ?").run(
        contentId,
        url,
        id,
      );
    },

    failDeployment(id: string, errMsg: string): void {
      db.prepare("UPDATE deployments SET status = 'failed', error = ? WHERE id = ?").run(errMsg, id);
    },

    listDeployments(environmentId: string): Deployment[] {
      const rows = db
        .prepare(
          `SELECT ${deploymentColumns} FROM deployments WHERE environment_id = ? AND rowid > COALESCE((SELECT deployments_after FROM environments WHERE id = ?), 0) ORDER BY created_at, rowid`,
        )
        .all(environmentId, environmentId) as DeploymentRow[];
      return rows.map(rowToDeployment);
    },

    getDeployment(id: string): Deployment {
      const row = db.prepare(`SELECT ${deploymentColumns} FROM deployments WHERE id = ?`).get(id) as
        DeploymentRow | undefined;
      if (!row) throw new ErrNotFound(`deployment "${id}"`);
      return rowToDeployment(row);
    },

    createTransfer(projectId: string, fromEnvId: string, toEnvId: string): Transfer {
      const t: Transfer = {
        id: newID("xfer"),
        projectId,
        fromEnvId,
        toEnvId,
        status: "provisioning",
        weight: 0,
        error: "",
        createdAt: nowUTC(),
      };
      db.prepare(
        "INSERT INTO transfers (id, project_id, from_env_id, to_env_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(t.id, t.projectId, t.fromEnvId, t.toEnvId, t.status, t.createdAt);
      return t;
    },

    updateTransfer(id: string, patch: Partial<Pick<Transfer, "status" | "weight" | "error" | "toEnvId">>): Transfer {
      const next = { ...this.getTransfer(id), ...patch };
      db.prepare("UPDATE transfers SET status = ?, weight = ?, error = ?, to_env_id = ? WHERE id = ?").run(
        next.status,
        next.weight,
        next.error,
        next.toEnvId,
        id,
      );
      return next;
    },

    getTransfer(id: string): Transfer {
      const row = db.prepare(`SELECT ${transferColumns} FROM transfers WHERE id = ?`).get(id) as
        TransferRow | undefined;
      if (!row) throw new ErrNotFound(`transfer "${id}"`);
      return rowToTransfer(row);
    },

    getLatestTransfer(projectId: string): Transfer | undefined {
      const row = db
        .prepare(
          `SELECT ${transferColumns} FROM transfers WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(projectId) as TransferRow | undefined;
      return row ? rowToTransfer(row) : undefined;
    },

    getActiveTransfer(projectId: string): Transfer | undefined {
      const row = db
        .prepare(
          `SELECT ${transferColumns} FROM transfers WHERE project_id = ? AND status NOT IN ('done', 'failed', 'cancelled') ORDER BY created_at DESC LIMIT 1`,
        )
        .get(projectId) as TransferRow | undefined;
      return row ? rowToTransfer(row) : undefined;
    },
  };
}
