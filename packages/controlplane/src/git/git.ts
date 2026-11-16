// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ErrNotFound } from "../store/errors.js";
import type { Store } from "../store/store.js";
import type { BuildCommit, BuildInput, OutputSummary, TimelineEntry } from "../builds/build-details.js";

// GitConfig is one project's own git-integration settings — the
// production branch to build on push, the framework (determines
// whether the build command alone produces .nbo/, or whether the
// runner must also call @nbo/producer-static's produce() against
// outputDir afterward), the build command itself, and an optional
// Vercel-style ignored-build-step gate.
export interface GitConfig {
  repo: string;
  productionBranch: string;
  framework: "nextjs" | "static";
  buildCommand: string;
  outputDir?: string;
  spa?: boolean;
  ignoredBuildStepCommand?: string;
  // rootDirectory is where the app lives inside the repository (Vercel's
  // "Root Directory"): the build command, outputDir and .nbo/ are all
  // relative to it. Unset means the repository root.
  rootDirectory?: string;
  // github: set when the project is linked to the NBO GitHub App; repo is
  // then the repository's URL on GitHub, built by NBO.
  // accessLost: set when GitHub said the repository was removed from the
  // app's installation; cleared when it is added back. The link stays, so
  // builds fail with the lost-access message and re-adding needs no relink.
  github?: { installationId: number; repoId: number; fullName: string; accessLost?: "repository-removed" };
}

// Build is a build-and-deploy attempt, separate from Deployment — a
// build can fail before any deployment ever exists (clone failure,
// build command failure, missing .nbo/). A successful build calls
// the existing triggerDeploy, which creates its own Deployment row;
// deploymentId links to it once that happens.
export type BuildStatus = "queued" | "running" | "skipped" | "succeeded" | "failed";

// BuildKind: "build" clones, builds and deploys a commit; "promote"
// deploys an already-stored build's .nbo/ (sourceBuildId) to one
// environment (targetEnvironmentId) without rebuilding. Both run in the
// project's one build queue and show in its Deployments list.
export type BuildKind = "build" | "promote";

export interface Build {
  id: string;
  projectId: string;
  revision: string;
  status: BuildStatus;
  // deploymentId is the first of deploymentIds (kept for pre-v2
  // callers); a v2 build fans out to every environment and records one
  // deployment per environment in deploymentIds.
  deploymentId: string;
  deploymentIds: string[];
  error: string;
  log: string;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
  // manual marks a full rebuild requested by hand (Redeploy): it bypasses
  // the ignored-build-step command.
  manual: boolean;
  // Details captured during the build (build-details.ts); null for builds
  // made before NBO kept them, and until each is captured.
  commit?: BuildCommit | null;
  input?: BuildInput | null;
  timeline?: TimelineEntry[] | null;
  outputSummary?: OutputSummary | null;
  // contentId of the build's .nbo/ ("" until produced).
  contentId: string;
  // artifact: the build's .nbo/ is kept in the artifact store.
  artifact: boolean;
  kind: BuildKind;
  // Promote jobs only ("" for builds).
  sourceBuildId: string;
  targetEnvironmentId: string;
  // note: an outcome worth showing that is not an error ("" when none).
  note: string;
  // stageId: the stage (stages.ts) this job belongs to. A commit build gets
  // that stage's variables and deploys to its clouds; a promote job takes
  // its target cloud's stage. Production when not given.
  stageId: string;
}

// withoutDetails drops what only one build's own page needs (the log and
// the captured details) so lists stay small.
export type BuildListItem = Omit<Build, "log" | "input" | "timeline" | "outputSummary" | "commit">;
export function withoutDetails(b: Build): BuildListItem {
  const { log: _log, input: _input, timeline: _timeline, outputSummary: _output, commit: _commit, ...rest } = b;
  return rest;
}

// EphemeralBuildInfo is on the views of an ephemeral stage's builds: its
// branch and the label it was made with, read from the stage at read time
// (nothing is stored on the build).
export interface EphemeralBuildInfo {
  ephemeralBranch?: string;
  ephemeralLabel?: string;
}

// ephemeralInfo returns a function that adds EphemeralBuildInfo to a build
// view of an ephemeral stage and leaves every other build as it is. It
// looks each stage up once.
export function ephemeralInfo(store: Store): <T extends { stageId: string }>(build: T) => T & EphemeralBuildInfo {
  const byStage = new Map<string, EphemeralBuildInfo | null>();
  const infoOf = (stageId: string): EphemeralBuildInfo | null => {
    if (!byStage.has(stageId)) {
      let info: EphemeralBuildInfo | null = null;
      try {
        const stage = store.getStage(stageId);
        if (stage.kind === "ephemeral") info = { ephemeralBranch: stage.branch, ephemeralLabel: stage.label };
      } catch (err) {
        if (!(err instanceof ErrNotFound)) throw err;
      }
      byStage.set(stageId, info);
    }
    return byStage.get(stageId)!;
  };
  return (build) => {
    const info = build.stageId ? infoOf(build.stageId) : null;
    return info ? { ...build, ...info } : build;
  };
}

// BuildDetailsPatch sets any of a build's captured details.
export interface BuildDetailsPatch {
  commit?: BuildCommit | null;
  input?: BuildInput | null;
  timeline?: TimelineEntry[] | null;
  outputSummary?: OutputSummary | null;
  contentId?: string;
  artifact?: boolean;
  note?: string;
}

// buildLogCap bounds one build's stored log — a chatty install step
// must not grow a sqlite row without limit.
const buildLogCap = 256 * 1024;
const truncationMarker = "\n[log truncated]\n";

const buildColumns =
  "id, project_id, revision, status, deployment_id, deployment_ids, error, log, started_at, finished_at, created_at, manual, commit_info, input, timeline, output_summary, content_id, artifact, kind, source_build_id, target_environment_id, note, stage_id";
type BuildRow = {
  id: string;
  project_id: string;
  revision: string;
  status: string;
  deployment_id: string;
  deployment_ids: string;
  error: string;
  log: string;
  started_at: string;
  finished_at: string;
  created_at: string;
  manual: number;
  commit_info: string | null;
  input: string | null;
  timeline: string | null;
  output_summary: string | null;
  content_id: string;
  artifact: number;
  kind: string;
  source_build_id: string;
  target_environment_id: string;
  note: string;
  stage_id: string;
};

// parseJson reads a JSON detail column; a corrupt one reads as null (and
// is logged once) so one bad row never breaks getBuild.
let warnedCorruptColumn = false;
function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    if (!warnedCorruptColumn) {
      warnedCorruptColumn = true;
      console.error("control-plane: a build's stored details are not valid JSON; reading them as missing");
    }
    return null;
  }
}
function rowToBuild(r: BuildRow): Build {
  return {
    id: r.id,
    projectId: r.project_id,
    revision: r.revision,
    status: r.status as BuildStatus,
    deploymentId: r.deployment_id,
    deploymentIds: JSON.parse(r.deployment_ids) as string[],
    error: r.error,
    log: r.log,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
    manual: r.manual === 1,
    commit: parseJson<BuildCommit>(r.commit_info),
    input: parseJson<BuildInput>(r.input),
    timeline: parseJson<TimelineEntry[]>(r.timeline),
    outputSummary: parseJson<OutputSummary>(r.output_summary),
    contentId: r.content_id,
    artifact: r.artifact === 1,
    kind: r.kind === "promote" ? "promote" : "build",
    sourceBuildId: r.source_build_id,
    targetEnvironmentId: r.target_environment_id,
    note: r.note,
    stageId: r.stage_id,
  };
}

// Column for each BuildDetailsPatch field.
const detailColumns: Record<keyof BuildDetailsPatch, string> = {
  commit: "commit_info",
  input: "input",
  timeline: "timeline",
  outputSummary: "output_summary",
  contentId: "content_id",
  artifact: "artifact",
  note: "note",
};

export const gitSchema = `
CREATE TABLE IF NOT EXISTS project_git_config (
	project_id TEXT PRIMARY KEY REFERENCES projects(id),
	config TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_webhook_secrets (
	project_id TEXT PRIMARY KEY REFERENCES projects(id),
	secret TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	revision TEXT NOT NULL,
	status TEXT NOT NULL,
	deployment_id TEXT NOT NULL DEFAULT '',
	error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
`;

function newID(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowUTC(): string {
  return new Date().toISOString();
}

// productionStageId: the project's Production stage id ("" when the
// project has none, which only a project row made outside createProject has).
function productionStageId(db: DatabaseSync, projectId: string): string {
  const row = db.prepare("SELECT id FROM stages WHERE project_id = ? AND name = 'production'").get(projectId) as
    { id: string } | undefined;
  return row?.id ?? "";
}

// attachGitMethods mutates store in place, adding every git-related
// Store method, and returns it — called once, from store.ts's own
// createStore, after that function has already built every
// non-git method onto the same object. Mirrors cron.ts's own
// attachCronMethods exactly, for the same reason (store.ts and this
// file would otherwise form a circular import).
export function attachGitMethods(db: DatabaseSync, store: Store): Store {
  Object.assign(store, {
    setGitConfig(projectId: string, config: GitConfig): void {
      db.prepare(
        `INSERT INTO project_git_config (project_id, config) VALUES (?, ?)
         ON CONFLICT(project_id) DO UPDATE SET config = excluded.config`,
      ).run(projectId, JSON.stringify(config));
    },

    getGitConfig(projectId: string): GitConfig {
      const row = db.prepare("SELECT config FROM project_git_config WHERE project_id = ?").get(projectId) as
        { config: string } | undefined;
      if (!row) throw new ErrNotFound(`git config for project "${projectId}"`);
      return JSON.parse(row.config) as GitConfig;
    },

    getWebhookSecret(projectId: string): string | undefined {
      const row = db.prepare("SELECT secret FROM project_webhook_secrets WHERE project_id = ?").get(projectId) as
        { secret: string } | undefined;
      return row?.secret;
    },

    ensureWebhookSecret(projectId: string): string {
      const row = db.prepare("SELECT secret FROM project_webhook_secrets WHERE project_id = ?").get(projectId) as
        { secret: string } | undefined;
      if (row) return row.secret;
      const secret = randomBytes(32).toString("hex");
      db.prepare(
        `INSERT INTO project_webhook_secrets (project_id, secret) VALUES (?, ?)
         ON CONFLICT(project_id) DO UPDATE SET secret = excluded.secret`,
      ).run(projectId, secret);
      return secret;
    },

    createBuild(projectId: string, revision: string): Build {
      const now = nowUTC();
      const stageId = productionStageId(db, projectId);
      const b: Build = {
        id: newID("build"),
        projectId,
        revision,
        status: "running",
        deploymentId: "",
        deploymentIds: [],
        error: "",
        log: "",
        startedAt: now,
        finishedAt: "",
        createdAt: now,
        manual: false,
        commit: null,
        input: null,
        timeline: null,
        outputSummary: null,
        contentId: "",
        artifact: false,
        kind: "build",
        sourceBuildId: "",
        targetEnvironmentId: "",
        note: "",
        stageId,
      };
      db.prepare(
        "INSERT INTO builds (id, project_id, revision, status, started_at, created_at, stage_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(b.id, b.projectId, b.revision, b.status, b.startedAt, b.createdAt, b.stageId);
      return b;
    },

    createQueuedBuild(projectId: string, revision: string, opts?: { manual?: boolean; stageId?: string }): Build {
      const b: Build = {
        id: newID("build"),
        projectId,
        revision,
        status: "queued",
        deploymentId: "",
        deploymentIds: [],
        error: "",
        log: "",
        startedAt: "",
        finishedAt: "",
        createdAt: nowUTC(),
        manual: opts?.manual === true,
        commit: null,
        input: null,
        timeline: null,
        outputSummary: null,
        contentId: "",
        artifact: false,
        kind: "build",
        sourceBuildId: "",
        targetEnvironmentId: "",
        note: "",
        stageId: opts?.stageId || productionStageId(db, projectId),
      };
      db.prepare(
        "INSERT INTO builds (id, project_id, revision, status, created_at, manual, stage_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(b.id, b.projectId, b.revision, b.status, b.createdAt, b.manual ? 1 : 0, b.stageId);
      return b;
    },

    startBuild(id: string): void {
      db.prepare("UPDATE builds SET status = 'running', started_at = ? WHERE id = ?").run(nowUTC(), id);
    },

    appendBuildLog(id: string, text: string): void {
      const row = db.prepare("SELECT log FROM builds WHERE id = ?").get(id) as { log: string } | undefined;
      if (!row) throw new ErrNotFound(`build "${id}"`);
      if (row.log.endsWith(truncationMarker)) return;
      let next = row.log + text;
      if (next.length > buildLogCap) next = next.slice(0, buildLogCap) + truncationMarker;
      db.prepare("UPDATE builds SET log = ? WHERE id = ?").run(next, id);
    },

    completeBuild(
      id: string,
      status: "skipped" | "succeeded" | "failed",
      deploymentIds?: string[],
      errMsg?: string,
    ): void {
      const ids = deploymentIds ?? [];
      db.prepare(
        "UPDATE builds SET status = ?, deployment_id = ?, deployment_ids = ?, error = ?, finished_at = ? WHERE id = ?",
      ).run(status, ids[0] ?? "", JSON.stringify(ids), errMsg ?? "", nowUTC(), id);
    },

    setBuildDetails(id: string, patch: BuildDetailsPatch): void {
      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      for (const [key, column] of Object.entries(detailColumns) as [keyof BuildDetailsPatch, string][]) {
        if (!(key in patch)) continue;
        const v = patch[key];
        sets.push(`${column} = ?`);
        if (key === "artifact") values.push(v ? 1 : 0);
        else if (key === "contentId" || key === "note") values.push((v as string | undefined) ?? "");
        else values.push(v == null ? null : JSON.stringify(v));
      }
      if (sets.length === 0) return;
      db.prepare(`UPDATE builds SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    },

    findQueuedBuild(projectId: string, stageId: string): Build | undefined {
      const row = db
        .prepare(
          `SELECT ${buildColumns} FROM builds WHERE project_id = ? AND stage_id = ? AND status = 'queued' AND kind = 'build' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(projectId, stageId) as BuildRow | undefined;
      return row ? rowToBuild(row) : undefined;
    },

    // Production's jobs first (a build with no stage is Production's), then
    // custom stages', then ephemeral ones', each oldest first.
    nextQueuedJob(projectId: string): Build | undefined {
      const row = db
        .prepare(
          `SELECT ${buildColumns
            .split(", ")
            .map((c) => `b.${c}`)
            .join(", ")} FROM builds b LEFT JOIN stages s ON s.id = b.stage_id
           WHERE b.project_id = ? AND b.status = 'queued'
           ORDER BY CASE COALESCE(s.kind, 'production') WHEN 'production' THEN 0 WHEN 'custom' THEN 1 ELSE 2 END, b.created_at, b.rowid LIMIT 1`,
        )
        .get(projectId) as BuildRow | undefined;
      return row ? rowToBuild(row) : undefined;
    },

    createQueuedPromote(projectId: string, sourceBuildId: string, environmentId: string): Build {
      const source = this.getBuild(sourceBuildId);
      const id = newID("build");
      // The job belongs to its target cloud's stage (queue order, variables).
      const target = db.prepare("SELECT stage_id FROM environments WHERE id = ?").get(environmentId) as
        { stage_id: string } | undefined;
      const stageId = target?.stage_id || productionStageId(db, projectId);
      // The job shows the commit and output of the build it deploys.
      db.prepare(
        `INSERT INTO builds (id, project_id, revision, status, created_at, manual, kind, source_build_id, target_environment_id, commit_info, output_summary, content_id, stage_id)
         VALUES (?, ?, ?, 'queued', ?, 1, 'promote', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        projectId,
        source.revision,
        nowUTC(),
        sourceBuildId,
        environmentId,
        source.commit ? JSON.stringify(source.commit) : null,
        source.outputSummary ? JSON.stringify(source.outputSummary) : null,
        source.contentId,
        stageId,
      );
      return this.getBuild(id);
    },

    findRunningBuild(projectId: string): Build | undefined {
      const row = db
        .prepare(
          `SELECT ${buildColumns} FROM builds WHERE project_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1`,
        )
        .get(projectId) as BuildRow | undefined;
      return row ? rowToBuild(row) : undefined;
    },

    listBuilds(projectId: string): Build[] {
      const rows = db
        .prepare(`SELECT ${buildColumns} FROM builds WHERE project_id = ? ORDER BY created_at, rowid`)
        .all(projectId) as BuildRow[];
      return rows.map(rowToBuild);
    },

    getBuild(id: string): Build {
      const row = db.prepare(`SELECT ${buildColumns} FROM builds WHERE id = ?`).get(id) as BuildRow | undefined;
      if (!row) throw new ErrNotFound(`build "${id}"`);
      return rowToBuild(row);
    },
  });
  return store;
}
