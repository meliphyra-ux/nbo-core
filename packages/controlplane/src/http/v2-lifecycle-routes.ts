// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// v2 routes for a project's life: delete it, deploy a chosen build, per-cloud settings and archiving.
import { deployAppName } from "../deploys/deploy.js";
import { hasOwnHost } from "../stages/stages.js";
import { certSecretName } from "../edge/edge-manifests.js";
import type { Store } from "../store/store.js";
import { withoutDetails } from "../git/git.js";
import type { Router } from "./router.js";
import { isRecord, writeJSON, writeError, errorMessage } from "./handlers.js";
import { parseSuppliedValues } from "../variables/supplied-values.js";
import type { V2 } from "../v2.js";
import { environmentView } from "./project-summary.js";
import { fail, readJSON } from "./v2-route-util.js";

export function registerLifecycleRoutes(router: Router, store: Store, v2: V2): void {
  // Deleting a project removes its NBO records and its edge route.
  // ?resources=true first deletes what it runs on each cloud; if that
  // fails nothing is deleted, so the operator can retry or choose to
  // keep the cloud side.
  router.handle("DELETE", "/projects/{projectID}", async (request, params) => {
    const projectId = params.projectID!;
    try {
      const project = store.getProject(projectId);
      if (store.findRunningBuild(projectId) || store.nextQueuedJob(projectId))
        return writeError(409, "a build is running — wait for it to finish, then delete");
      if (store.getActiveTransfer(projectId)) return writeError(409, "a transfer is in progress — stop it first");
      if (project.setupStatus === "provisioning")
        return writeError(409, "setup is still running — wait for it to finish");
      const keepsCloud = new URL(request.url).searchParams.get("resources") !== "true";
      if (keepsCloud) {
        const mappedHosts = store
          .listDomains(projectId)
          .filter((d) => d.serving === "cloudrun" || d.mappingKept)
          .map((d) => d.host);
        if (mappedHosts.length > 0)
          console.error(
            `control-plane: project ${project.name} deleted without its cloud resources; Google still maps ${mappedHosts.join(", ")}`,
          );
      }
      if (!keepsCloud) {
        // Every environment's clouds, custom ones included.
        for (const env of store.listEnvironments(projectId, { includeArchived: true, allStages: true })) {
          try {
            await v2.cloudTeardown.remove({
              target: env.target,
              appName: deployAppName(env),
              projectId: env.projectId,
              config: JSON.parse(env.config) as Record<string, unknown>,
            });
          } catch (err) {
            return writeError(502, errorMessage(err));
          }
        }
      }
      // Production's host and every custom environment's.
      for (const host of [
        project.edgeHost,
        ...store
          .listStages(projectId, { includeEphemeral: true })
          .filter(hasOwnHost)
          .map((s) => s.host),
      ]) {
        try {
          await v2.edgeSync.remove(host);
        } catch (err) {
          console.error(`control-plane: removing ${host} from the edge failed: ${errorMessage(err)}`);
        }
      }
      const certHosts =
        v2.mode === "production" && store.getServerSettings().edgeClusterId !== ""
          ? store.listDomains(projectId).map((d) => d.host)
          : [];
      store.deleteProject(projectId);
      if (certHosts.length > 0) {
        // The table first, so the edge is never told to use a Secret that is gone.
        try {
          await v2.edgeSync.push(projectId);
        } catch (err) {
          console.error(
            `control-plane: project ${project.name} deleted, but updating the edge route table failed: ${errorMessage(err)}`,
          );
        }
        for (const host of certHosts) {
          try {
            await v2.certs.deleteCert(certSecretName(host));
          } catch (err) {
            console.error(
              `control-plane: project ${project.name} deleted, but deleting the certificate Secret of ${host} failed: ${errorMessage(err)}`,
            );
          }
        }
      }
      return new Response(null, { status: 204 });
    } catch (err) {
      return fail(err);
    }
  });

  // Deploy a chosen build: queue a promote job deploying the build's
  // stored .nbo/ to one environment of its project (no rebuild).
  router.handle("POST", "/builds/{buildID}/deploy", async (request, params) => {
    try {
      const body = await readJSON(request);
      if (!isRecord(body) || typeof body.environmentId !== "string" || !body.environmentId)
        return writeError(400, "environmentId is required");
      const build = store.getBuild(params.buildID!);
      const sourceId = build.kind === "promote" ? build.sourceBuildId : build.id;
      const dup = store
        .listBuilds(build.projectId)
        .some(
          (b) =>
            b.kind === "promote" &&
            (b.status === "queued" || b.status === "running") &&
            b.sourceBuildId === sourceId &&
            b.targetEnvironmentId === body.environmentId,
        );
      if (dup) return writeError(409, "A deploy of this build to this cloud is already queued");
      const values = parseSuppliedValues(body.values);
      const job = v2.queue.enqueuePromote(
        build.projectId,
        build.id,
        body.environmentId,
        values === undefined ? undefined : { values },
      );
      return writeJSON(withoutDetails(job), 202);
    } catch (err) {
      return fail(err);
    }
  });

  // Per-cloud settings: autoDeploy decides whether new commits deploy here.
  router.handle("PATCH", "/environments/{environmentID}", async (request, params) => {
    try {
      const body = await readJSON(request);
      if (
        !isRecord(body) ||
        typeof body.autoDeploy !== "boolean" ||
        Object.keys(body).some((k) => k !== "autoDeploy")
      ) {
        return writeError(400, "body must be { autoDeploy: boolean }");
      }
      if (store.getEnvironment(params.environmentID!).archived) return writeError(400, "this environment is archived");
      store.setEnvironmentAutoDeploy(params.environmentID!, body.autoDeploy);
      const env = store.getEnvironment(params.environmentID!);
      return writeJSON(environmentView(store, v2.mode, env), 200);
    } catch (err) {
      return fail(err);
    }
  });

  // Archiving only stops NBO deploying and routing there; the running
  // cloud service is left in place for the operator to delete.
  router.handle("POST", "/environments/{environmentID}/archive", async (_request, params) => {
    try {
      const env = store.getEnvironment(params.environmentID!);
      if (env.archived) return new Response(null, { status: 204 });
      if (env.trafficWeight > 0) return writeError(400, "move all traffic off this environment first");
      // Counted within the row's own environment (Production or a custom one).
      const production = store.productionStage(env.projectId).id === env.stageId;
      if (store.listEnvironments(env.projectId, { stageId: env.stageId }).length <= 1) {
        return writeError(
          400,
          production ? "this is the project's only environment" : "this is the only cloud of its environment",
        );
      }
      const active = store.getActiveTransfer(env.projectId);
      if (active && (active.fromEnvId === env.id || active.toEnvId === env.id))
        return writeError(409, "a transfer involving this environment is in progress");
      // NBO reaches a domain mapping through this environment (Production's only).
      if (env.target === "cloudrun" && production) {
        const mapped = store
          .listDomains(env.projectId)
          .filter((d) => d.serving === "cloudrun" || d.mappingKept)
          .map((d) => d.host);
        if (mapped.length > 0)
          return writeError(
            409,
            `Cloud Run still has domain mappings for ${mapped.join(", ")}. Remove these domains, or wait for moved ones to finish, before archiving this environment.`,
          );
      }
      store.archiveEnvironment(env.id);
      return new Response(null, { status: 204 });
    } catch (err) {
      return fail(err);
    }
  });
}
