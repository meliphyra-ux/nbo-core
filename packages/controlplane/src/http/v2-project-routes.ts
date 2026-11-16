// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// v2 routes for a project: setup and retry, summaries, git poll, manual builds and settings.
import { HeadsUnreadable } from "../git/poller.js";
import { parseSuppliedValues } from "../variables/supplied-values.js";
import { variableStage } from "../stages/stages.js";
import { withGitAuth } from "../git/git-credentials.js";
import { ErrInvalidEnvironmentConfig, type ProjectPatch, type Store } from "../store/store.js";
import type { Router } from "./router.js";
import { isRecord, writeJSON, writeError, errorMessage } from "./handlers.js";
import { parseSetupRequest } from "../deploys/setup.js";
import { credentialInput } from "../git/git-credentials.js";
import type { V2 } from "../v2.js";
import { summarize } from "./project-summary.js";
import { fail, readJSON } from "./v2-route-util.js";

const sampleRates = [100, 50, 25, 10];

// parseSettingsPatch validates the project settings PATCH body: an error
// message, or the patch to apply.
function parseSettingsPatch(body: unknown): ProjectPatch | string {
  const allowed =
    "pollingEnabled, speedInsights, speedInsightsInject (booleans) and speedInsightsSampleRate (100, 50, 25 or 10)";
  if (!isRecord(body)) return `settings body may contain only ${allowed}`;
  const patch: ProjectPatch = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "pollingEnabled" || k === "speedInsights" || k === "speedInsightsInject") {
      if (typeof v !== "boolean") return `${k} must be a boolean`;
      patch[k] = v;
    } else if (k === "speedInsightsSampleRate") {
      if (typeof v !== "number" || !sampleRates.includes(v)) return "speedInsightsSampleRate must be 100, 50, 25 or 10";
      patch.speedInsightsSampleRate = v;
    } else {
      return `settings body may contain only ${allowed}`;
    }
  }
  return patch;
}

export function registerProjectRoutes(router: Router, store: Store, v2: V2): void {
  router.handle("GET", "/system/preflight", async () => {
    try {
      return writeJSON(await v2.cloudSetup.preflight(), 200);
    } catch (err) {
      return writeError(500, errorMessage(err));
    }
  });

  router.handle("POST", "/projects/setup", async (request) => {
    try {
      const req = parseSetupRequest(await readJSON(request));
      // A deploy key's pair is made before the project exists, so the
      // background setup reads the repository with it.
      const credential = req.credential
        ? await credentialInput(store, req.credential, undefined, req.name, v2.keygen)
        : undefined;
      const project = v2.setup.start(req, credential === "keep" ? undefined : credential);
      return writeJSON(summarize(store, project.id, v2), 201);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("POST", "/projects/{projectID}/setup/retry", async (request, params) => {
    try {
      const body = await readJSON(request);
      const clouds = isRecord(body) && body.clouds !== undefined ? body.clouds : undefined;
      if (clouds !== undefined && !Array.isArray(clouds))
        throw new ErrInvalidEnvironmentConfig("clouds must be an array");
      v2.setup.retry(params.projectID!, clouds as never);
      return writeJSON(summarize(store, params.projectID!, v2), 202);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("GET", "/projects/summary", async () => {
    try {
      return writeJSON(
        store.listProjects().map((p) => summarize(store, p.id, v2)),
        200,
      );
    } catch (err) {
      return writeError(500, errorMessage(err));
    }
  });

  router.handle("GET", "/projects/{projectID}/summary", async (_request, params) => {
    try {
      return writeJSON(summarize(store, params.projectID!, v2), 200);
    } catch (err) {
      return fail(err);
    }
  });

  // Check the project's branch heads now (what the poll loop does every
  // ~45 s); the loop's own poller, so a push builds once.
  router.handle("POST", "/projects/{projectID}/git/poll", async (request, params) => {
    try {
      const text = await request.text();
      if (text.trim() !== "") {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
        if (!isRecord(body) || Object.keys(body).length > 0) return writeError(400, "this route takes no body");
      }
      return writeJSON(await v2.poller.pollProject(params.projectID!, { nudge: true }), 200);
    } catch (err) {
      if (err instanceof HeadsUnreadable) {
        let repo = "the repository";
        try {
          repo = store.getGitConfig(params.projectID!).repo;
        } catch {
          // the message names the repository when it can
        }
        return writeError(502, `could not read the heads of ${repo}: ${err.message}`);
      }
      return fail(err);
    }
  });

  router.handle("POST", "/projects/{projectID}/builds", async (request, params) => {
    const projectId = params.projectID!;
    try {
      const body = await readJSON(request);
      const revision = isRecord(body) ? body.revision : undefined;
      if (revision !== undefined && (typeof revision !== "string" || !/^[0-9a-f]{40}$/.test(revision))) {
        return writeError(400, "revision must be a 40-character git commit sha");
      }
      // stage: which environment to build for (a stage name, default production).
      const stageName = isRecord(body) && body.stage !== undefined ? body.stage : "production";
      if (typeof stageName !== "string" || !stageName) return writeError(400, "stage must be an environment name");
      const stage = store.getStageByName(projectId, stageName);
      if (stage.kind === "preview" || stage.kind === "development") {
        return writeError(400, `the ${stage.name} environment holds variables only and doesn't deploy`);
      }
      if (stage.kind === "ephemeral" && stage.removal !== "") {
        return writeError(409, `the ${stage.name} environment was removed (or is being removed) and can't build`);
      }
      // values: the stage's variable values when NBO keeps names only
      // (checked now, before the head is read; refused when NBO stores them).
      const values = parseSuppliedValues(isRecord(body) ? body.values : undefined);
      if (store.getServerSettings().envValues === "none" || values !== undefined)
        store.resolveEnv(projectId, variableStage(stage), values);
      const git = store.getGitConfig(projectId);
      const branch = stage.kind === "production" ? git.productionBranch : stage.branch;
      let sha = revision as string | undefined;
      if (sha === undefined) {
        try {
          sha = await withGitAuth(v2.gitAuth, projectId, git, (env) =>
            v2.lsRemote(git.repo, branch, env ? { env } : undefined),
          );
        } catch (err) {
          return writeError(502, `could not read the head of ${branch}: ${errorMessage(err)}`);
        }
        // The poller then doesn't build the same head again; the time kept
        // with it lets a later push whose before isn't this head through.
        if (stage.kind === "production" || stage.kind === "custom" || stage.kind === "ephemeral")
          store.advanceHead(projectId, sha, stage.id, undefined, { at: Date.now() });
        else store.updateStage(stage.id, { lastSeenSha: sha });
      }
      // Names only: an empty stage still gets {} so the build isn't taken for a push.
      const namesOnly = store.getServerSettings().envValues === "none";
      const build = v2.queue.enqueue(projectId, sha, {
        manual: true,
        stageId: stage.id,
        ...(namesOnly ? { values: values ?? {} } : {}),
      });
      const { log: _log, ...rest } = build;
      return writeJSON(rest, 202);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("PATCH", "/projects/{projectID}/settings", async (request, params) => {
    try {
      const body = await readJSON(request);
      const patch = parseSettingsPatch(body);
      if (typeof patch === "string") return writeError(400, patch);
      const before = store.getProject(params.projectID!);
      const after = store.updateProject(params.projectID!, patch);
      // Speed Insights settings travel with the host's edge target; a
      // failed push is retried by the poll loop's reconcile.
      if (
        before.speedInsights !== after.speedInsights ||
        before.speedInsightsInject !== after.speedInsightsInject ||
        before.speedInsightsSampleRate !== after.speedInsightsSampleRate
      ) {
        try {
          await v2.edgeSync.push(params.projectID!);
        } catch (err) {
          console.error(
            `control-plane: pushing Speed Insights settings for ${after.name} to the edge failed: ${errorMessage(err)}`,
          );
        }
      }
      return writeJSON(summarize(store, params.projectID!, v2), 200);
    } catch (err) {
      return fail(err);
    }
  });
}
