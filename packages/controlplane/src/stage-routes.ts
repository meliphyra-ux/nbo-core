// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { ErrDuplicateName, ErrInvalidEnvironmentConfig, ErrNotFound, type Store } from "./store.js";
import { ErrConflict, ErrInvalid } from "./errors.js";
import { cannotTakeTrafficReason } from "./edge-table.js";
import type { Build, GitConfig } from "./git.js";
import type { Router } from "./router.js";
import { isRecord, writeJSON, writeError, statusForStoreError, errorMessage } from "./handlers.js";
import { parseClouds } from "./setup.js";
import { stageUrlFor, domainUrlFor, type V2 } from "./v2.js";
import { deployAppName } from "./deploy.js";
import { liveBuild } from "./artifacts.js";
import { branchInUse, hasOwnHost, validateHostLabel, validateStageName, type Stage, type StageKind, type StageRemoval } from "./stages.js";
import { defaultHostFor, placeholderSuffix, stageHostLabel } from "./hosts.js";
import { certSecretName } from "./edge-manifests.js";
import { forgetPolledStage } from "./poller.js";
import { removeStage } from "./stage-expiry.js";
import { busiest, environmentSummaries, type EnvironmentSummary } from "./v2-routes.js";

// Stages are what the dashboard calls environments (stages.ts). These routes
// list them, create, change and delete custom ones, and create, change and
// remove ephemeral ones (an own branch and address with a time to live).

export interface StageView {
  id: string;
  name: string;
  kind: StageKind;
  // Production's is the git config's production branch.
  branch: string;
  autoDeploy: boolean;
  // Production's is the project's edge host; Preview and Development have none.
  host: string;
  url: string;
  // Its cloud rows (Production's are the summary's environments).
  environments: EnvironmentSummary[];
  // The build its busiest cloud serves, or null.
  liveBuild: EnvironmentSummary["liveBuild"];
  // Ephemeral stages: when core removes it ("" = never), the label it was
  // made with, and its removal state ("" while it runs). "" for the others.
  expiresAt: string;
  label: string;
  removal: StageRemoval;
  removalError: string;
  removedAt: string;
}

// stageViews: every stage of a project, built-ins first. ctx passes what
// the summary already read, so nothing is read twice.
export function stageViews(
  store: Store,
  v2: Pick<V2, "mode" | "edgePublicPort">,
  projectId: string,
  ctx: { builds?: Build[]; git?: GitConfig | null; production?: EnvironmentSummary[]; includeEphemeral?: boolean } = {},
): StageView[] {
  const project = store.getProject(projectId);
  const builds = ctx.builds ?? store.listBuilds(projectId);
  let git = ctx.git;
  if (git === undefined) {
    try {
      git = store.getGitConfig(projectId);
    } catch (err) {
      if (!(err instanceof ErrNotFound)) throw err;
      git = null;
    }
  }
  const urlCtx = { store, mode: v2.mode, edgePublicPort: v2.edgePublicPort };
  return store.listStages(projectId, { includeEphemeral: ctx.includeEphemeral === true }).map((stage) => {
    const hasClouds = stage.kind === "production" || stage.kind === "custom" || stage.kind === "ephemeral";
    const envs = !hasClouds ? [] : store.listEnvironments(projectId, stage.kind === "production" ? undefined : { stageId: stage.id });
    const environments = stage.kind === "production" && ctx.production ? ctx.production : environmentSummaries(store, v2.mode, envs, builds);
    const top = busiest(envs);
    const live = top ? liveBuild(store, top, builds) : null;
    return {
      id: stage.id,
      name: stage.name,
      kind: stage.kind,
      branch: stage.kind === "production" ? (git?.productionBranch ?? "") : stage.branch,
      autoDeploy: stage.autoDeploy,
      host: stage.kind === "production" ? project.edgeHost : stage.host,
      url: stage.kind === "production" ? domainUrlFor(project, urlCtx) : stageUrlFor(stage, urlCtx),
      environments,
      liveBuild: live ? { id: live.id, revision: live.revision, message: live.commit?.message ?? "", artifact: live.artifact === true } : null,
      expiresAt: stage.expiresAt,
      label: stage.label,
      removal: stage.removal,
      removalError: stage.removalError,
      removedAt: stage.removedAt,
    };
  });
}

function stageView(store: Store, v2: V2, stage: Stage): StageView {
  return stageViews(store, v2, stage.projectId, { includeEphemeral: true }).find((s) => s.id === stage.id)!;
}

async function readJSON(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function fail(err: unknown): Response {
  return writeError(statusForStoreError(err), errorMessage(err));
}

// A branch name that is safe as a git argument and a ref: no whitespace or
// characters git refuses, no leading "-", no "..".
function branchProblem(branch: unknown): string | null {
  if (typeof branch !== "string" || branch === "") return "branch is required";
  if (branch.length > 250 || branch.startsWith("-") || branch.includes("..") || !/^[^\s~^:?*[\\]+$/.test(branch)) return `"${branch}" isn't a branch name git accepts`;
  return null;
}

function onlyKeys(body: Record<string, unknown>, allowed: string[]): string | null {
  const extra = Object.keys(body).find((k) => !allowed.includes(k));
  return extra === undefined ? null : `the body may contain only ${allowed.join(", ")}`;
}

// customStage: the project's stage by id, which must be a custom one.
function customStage(store: Store, projectId: string, stageId: string): Stage {
  const stage = store.getStage(stageId);
  if (stage.projectId !== projectId) throw new ErrNotFound(`environment "${stageId}"`);
  if (stage.kind !== "custom") throw new ErrInvalid(`the ${stage.name} environment is built in and can't be changed or deleted`);
  return stage;
}

// hostInUse: is host already some project's or environment's address, or a domain?
function hostInUse(store: Store, host: string): boolean {
  if (store.listDomains().some((d) => d.host === host)) return true;
  for (const p of store.listProjects()) {
    if (p.edgeHost === host) return true;
    if (store.listStages(p.id, { includeEphemeral: true }).some((s) => hasOwnHost(s) && s.host === host)) return true;
  }
  return false;
}

const HOUR = 3_600_000;
// The longest time to live: 90 days.
const maxTtlHours = 2160;

// parseExpiresAt: an ephemeral stage's expiry as a normalized ISO time, or
// why not. At most 90 days after now; a time already past expires the
// stage on the next pass.
function parseExpiresAt(value: unknown, now: Date): string | { error: string } {
  if (typeof value !== "string" || value === "" || !Number.isFinite(Date.parse(value))) return { error: "expiresAt must be a date and time such as 2026-11-20T12:00:00Z" };
  const at = Date.parse(value);
  if (at > now.getTime() + maxTtlHours * HOUR) return { error: `expiresAt can be at most ${maxTtlHours} hours (90 days) from now` };
  return new Date(at).toISOString();
}

// createEphemeral: POST /projects/{id}/stages with kind "ephemeral". The
// stage is named pv-<8 hex> and lives on <hostLabel>--<project>; it builds
// nothing until a push to its branch (or POST .../builds).
async function createEphemeral(store: Store, v2: V2, projectId: string, body: Record<string, unknown>): Promise<Response> {
  const extra = onlyKeys(body, ["kind", "branch", "hostLabel", "clouds", "expiresAt", "ttlHours", "label"]);
  if (extra) return writeError(400, extra);
  const badBranch = branchProblem(body.branch);
  if (badBranch) return writeError(400, badBranch);
  const labelProblem = validateHostLabel(body.hostLabel);
  if (labelProblem) return writeError(400, labelProblem);
  if (body.label !== undefined && (typeof body.label !== "string" || body.label.length > 200)) return writeError(400, "label must be text of at most 200 characters");
  if ((body.expiresAt === undefined) === (body.ttlHours === undefined)) return writeError(400, "give exactly one of expiresAt or ttlHours");
  const now = v2.now();
  let expiresAt: string;
  if (body.ttlHours !== undefined) {
    const ttl = body.ttlHours;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > maxTtlHours) return writeError(400, `ttlHours must be a whole number from 1 to ${maxTtlHours}`);
    expiresAt = new Date(now.getTime() + ttl * HOUR).toISOString();
  } else {
    const at = parseExpiresAt(body.expiresAt, now);
    if (typeof at !== "string") return writeError(400, at.error);
    if (Date.parse(at) <= now.getTime()) return writeError(400, "expiresAt must be in the future");
    expiresAt = at;
  }
  const clouds = parseClouds(body.clouds);
  // One cloud, as previews always had: an ephemeral environment has no split to manage.
  if (clouds.length !== 1) return writeError(400, "an ephemeral environment runs on exactly one cloud");
  const project = store.getProject(projectId);
  const branch = body.branch as string;
  const hostLabel = body.hostLabel as string;
  const label = `${hostLabel}--${project.name}`;
  if (label.length > 63) return writeError(400, `the address label "${label}" is longer than 63 characters; choose a shorter hostLabel`);
  const taken = branchInUse(store, projectId, branch);
  if (taken) return writeError(409, `the branch "${branch}" already builds the ${taken} environment`);
  if (store.listStages(projectId, { includeEphemeral: true }).some((s) => s.kind === "ephemeral" && s.removal === "" && s.branch === branch)) {
    return writeError(409, `the branch "${branch}" already has an ephemeral environment`);
  }

  const settings = store.getServerSettings();
  const { host, needsBaseDomain } = defaultHostFor(label, settings, v2.mode);
  if (hostInUse(store, host)) return writeError(409, "that address is taken");
  const recordDomain = v2.mode === "production" && settings.edgeClusterId !== "" && !needsBaseDomain && !host.endsWith(placeholderSuffix);

  const stage = store.createEphemeralStage(projectId, { branch, host, expiresAt, label: (body.label as string | undefined) ?? "" });
  try {
    for (const cloud of clouds) {
      const env = await v2.setup.addCloud(projectId, cloud, { stageId: stage.id });
      const reason = cannotTakeTrafficReason(store, v2.mode, env);
      if (reason) throw new ErrConflict(`${reason} The ${stage.name} environment can't use it until then.`);
    }
  } catch (err) {
    // All or nothing: nothing has built or deployed yet.
    store.discardEphemeralStage(stage.id);
    if (err instanceof ErrDuplicateName || err instanceof ErrInvalidEnvironmentConfig || err instanceof ErrNotFound || err instanceof ErrInvalid || err instanceof ErrConflict) return fail(err);
    return writeError(502, errorMessage(err));
  }
  if (recordDomain) {
    try {
      store.addDomain(projectId, host, "default", "edge", stage.id);
    } catch (err) {
      console.error(`control-plane: project ${project.name}'s ${stage.name} environment: default domain ${host} not recorded: ${errorMessage(err)}`);
    }
  }
  return writeJSON(stageView(store, v2, stage), 201);
}

const removedListedMs = 7 * 24 * 3_600_000;

export function registerStageRoutes(router: Router, store: Store, v2: V2): void {
  // A removed ephemeral stage is listed for 7 days after its removal;
  // ?all=1 lists every one.
  router.handle("GET", "/projects/{projectID}/stages", async (request, params) => {
    try {
      const all = new URL(request.url).searchParams.get("all") === "1";
      const cutoff = v2.now().getTime() - removedListedMs;
      const views = stageViews(store, v2, params.projectID!, { includeEphemeral: true });
      const gone = new Set(
        store
          .listStages(params.projectID!, { includeEphemeral: true })
          .filter((s) => s.removal === "removed" && !(Date.parse(s.removedAt) >= cutoff))
          .map((s) => s.id),
      );
      return writeJSON(all ? views : views.filter((v) => !gone.has(v.id)), 200);
    } catch (err) {
      return fail(err);
    }
  });

  // Create a custom environment with its clouds and address. It builds
  // nothing: the next push or poll of its branch does, or POST .../builds.
  router.handle("POST", "/projects/{projectID}/stages", async (request, params) => {
    const projectId = params.projectID!;
    try {
      const body = await readJSON(request);
      if (!isRecord(body)) return writeError(400, "the request body must be a JSON object");
      if (body.kind === "ephemeral") return await createEphemeral(store, v2, projectId, body);
      if (body.kind !== undefined && body.kind !== "custom") return writeError(400, "kind must be \"custom\" or \"ephemeral\"");
      const extra = onlyKeys(body, ["kind", "name", "branch", "clouds", "autoDeploy"]);
      if (extra) return writeError(400, extra);
      if (typeof body.name !== "string") return writeError(400, "name is required");
      const nameProblem = validateStageName(body.name);
      if (nameProblem) return writeError(400, nameProblem);
      const badBranch = branchProblem(body.branch);
      if (badBranch) return writeError(400, badBranch);
      if (body.autoDeploy !== undefined && typeof body.autoDeploy !== "boolean") return writeError(400, "autoDeploy must be true or false");
      const clouds = parseClouds(body.clouds);
      const project = store.getProject(projectId);
      const name = body.name;
      const branch = body.branch as string;

      // The address, by the rules a project's own follows. With an edge it is
      // also a default domain row (DNS check, certificate), as setup records one.
      const settings = store.getServerSettings();
      const { host, needsBaseDomain } = defaultHostFor(stageHostLabel({ name }, project), settings, v2.mode);
      const recordDomain = v2.mode === "production" && settings.edgeClusterId !== "" && !needsBaseDomain && !host.endsWith(placeholderSuffix);
      if (store.listStages(projectId).some((s) => s.name === name)) throw new ErrDuplicateName(`an environment named "${name}" already exists`);
      if (hostInUse(store, host)) throw new ErrDuplicateName(`the address "${host}" is already in use`);

      const stage = store.createStage(projectId, { name, branch, autoDeploy: body.autoDeploy as boolean | undefined, host });
      try {
        for (const cloud of clouds) {
          const env = await v2.setup.addCloud(projectId, cloud, { stageId: stage.id });
          // As a transfer does: a cluster with no public entry would be accepted and never routed.
          const reason = cannotTakeTrafficReason(store, v2.mode, env);
          if (reason) throw new ErrConflict(`${reason} The ${name} environment can't use it until then.`);
        }
      } catch (err) {
        // All or nothing: the clouds added so far are only rows (nothing deploys before a build).
        store.deleteStage(stage.id);
        if (err instanceof ErrDuplicateName || err instanceof ErrInvalidEnvironmentConfig || err instanceof ErrNotFound || err instanceof ErrInvalid || err instanceof ErrConflict) return fail(err);
        return writeError(502, errorMessage(err));
      }
      if (recordDomain) {
        try {
          store.addDomain(projectId, host, "default", "edge", stage.id);
        } catch (err) {
          // As for a project: the environment still routes on its host, just without a certificate.
          console.error(`control-plane: project ${project.name}'s ${name} environment: default domain ${host} not recorded: ${errorMessage(err)}`);
        }
      }
      return writeJSON(stageView(store, v2, stage), 201);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("PATCH", "/projects/{projectID}/stages/{stageID}", async (request, params) => {
    const projectId = params.projectID!;
    try {
      const own = store.getStage(params.stageID!);
      if (own.projectId === projectId && own.kind === "ephemeral") {
        const body = await readJSON(request);
        if (!isRecord(body)) return writeError(400, "the request body must be a JSON object");
        const extra = onlyKeys(body, ["expiresAt"]);
        if (extra) return writeError(400, extra);
        if (own.removal !== "") return writeError(409, `the ${own.name} environment is being removed`);
        if (body.expiresAt === undefined) return writeJSON(stageView(store, v2, own), 200);
        const at = parseExpiresAt(body.expiresAt, v2.now());
        if (typeof at !== "string" || at === "") return writeError(400, typeof at === "string" ? "expiresAt is required" : at.error);
        return writeJSON(stageView(store, v2, store.updateStage(own.id, { expiresAt: at })), 200);
      }
      const stage = customStage(store, projectId, params.stageID!);
      const body = await readJSON(request);
      if (!isRecord(body)) return writeError(400, "the request body must be a JSON object");
      const extra = onlyKeys(body, ["branch", "autoDeploy"]);
      if (extra) return writeError(400, extra);
      const patch: { branch?: string; autoDeploy?: boolean } = {};
      if (body.branch !== undefined) {
        const badBranch = branchProblem(body.branch);
        if (badBranch) return writeError(400, badBranch);
        const taken = branchInUse(store, projectId, body.branch as string, stage.id);
        if (taken) return writeError(409, `the branch "${body.branch as string}" already builds the ${taken} environment`);
        patch.branch = body.branch as string;
      }
      if (body.autoDeploy !== undefined) {
        if (typeof body.autoDeploy !== "boolean") return writeError(400, "autoDeploy must be true or false");
        patch.autoDeploy = body.autoDeploy;
      }
      return writeJSON(stageView(store, v2, store.updateStage(stage.id, patch)), 200);
    } catch (err) {
      return fail(err);
    }
  });

  // Deleting a custom environment: ?resources=true first deletes what each
  // of its clouds runs (that app only, never Production's or another
  // environment's; if that fails nothing is deleted), then its records
  // (clouds, variables, domains), then its address on the edge. Its builds
  // stay in history.
  router.handle("DELETE", "/projects/{projectID}/stages/{stageID}", async (request, params) => {
    const projectId = params.projectID!;
    try {
      const project = store.getProject(projectId);
      const own = store.getStage(params.stageID!);
      if (own.projectId === projectId && own.kind === "ephemeral") {
        // Removal runs in the background (a teardown may take minutes), after
        // any expiry pass already running; the stage is marked at once.
        if (own.removal === "removed") return writeError(409, `the ${own.name} environment is already removed`);
        const marked = own.removal === "" ? store.updateStage(own.id, { removal: "removing" }) : own;
        void removeStage(v2.stageExpiry, own.id, "manual").catch((err: unknown) => console.error(`control-plane: removing environment ${own.name} failed: ${errorMessage(err)}`));
        return writeJSON(stageView(store, v2, marked), 202);
      }
      const stage = customStage(store, projectId, params.stageID!);
      const busy = () => store.listBuilds(projectId).some((b) => b.stageId === stage.id && (b.status === "queued" || b.status === "running"));
      const busyMessage = `a build of the ${stage.name} environment is queued or running. Wait for it to finish, then delete.`;
      if (busy()) return writeError(409, busyMessage);
      if (new URL(request.url).searchParams.get("resources") === "true") {
        // No push or poll starts a build while its clouds go away; restored if
        // the deletion stops.
        store.updateStage(stage.id, { autoDeploy: false });
        const keep = store
          .listEnvironments(projectId, { allStages: true, includeArchived: true })
          .filter((e) => e.stageId !== stage.id)
          .map(deployAppName);
        for (const env of store.listEnvironments(projectId, { stageId: stage.id, includeArchived: true })) {
          try {
            await v2.cloudTeardown.remove({
              target: env.target,
              appName: deployAppName(env),
              projectId,
              config: JSON.parse(env.config) as Record<string, unknown>,
              scope: "app",
              keep,
            });
          } catch (err) {
            store.updateStage(stage.id, { autoDeploy: stage.autoDeploy });
            return writeError(502, `${errorMessage(err)} (retry to finish deleting the ${stage.name} environment)`);
          }
        }
        // A build queued some other way (the API) during the teardown would
        // deploy again; keep the environment so its clouds stay visible.
        if (busy()) {
          store.updateStage(stage.id, { autoDeploy: stage.autoDeploy });
          return writeError(409, busyMessage);
        }
      }
      const ownDomains = store.listDomains(projectId).filter((d) => d.stageId === stage.id);
      const certHosts = v2.mode === "production" && store.getServerSettings().edgeClusterId !== "" ? ownDomains.map((d) => d.host) : [];
      // The records first, so an edge reconcile running meanwhile can't push the host back.
      store.deleteStage(stage.id);
      forgetPolledStage(projectId, stage.id);
      try {
        await v2.edgeSync.remove(stage.host);
      } catch (err) {
        console.error(`control-plane: removing ${stage.host} from the edge failed: ${errorMessage(err)}`);
      }
      if (certHosts.length > 0) {
        // The table first, so the edge is never told to use a Secret that is gone.
        try {
          await v2.edgeSync.push(projectId);
        } catch (err) {
          console.error(`control-plane: project ${project.name}'s ${stage.name} environment deleted, but updating the edge route table failed: ${errorMessage(err)}`);
        }
        for (const host of certHosts) {
          try {
            await v2.certs.deleteCert(certSecretName(host));
          } catch (err) {
            console.error(`control-plane: project ${project.name}'s ${stage.name} environment deleted, but deleting the certificate Secret of ${host} failed: ${errorMessage(err)}`);
          }
        }
      }
      return new Response(null, { status: 204 });
    } catch (err) {
      return fail(err);
    }
  });
}
