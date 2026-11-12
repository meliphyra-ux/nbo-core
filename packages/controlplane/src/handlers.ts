// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { ErrNotFound, ErrDuplicateName, ErrInvalidEnvironmentConfig, ErrInvalidGitConfig, type Store, type Deployment, type Environment } from "./store.js";
import { ErrConflict, ErrInvalid, ErrInvalidEnvVar } from "./errors.js";
import { createRouter } from "./router.js";
import { registerGitConfigRoutes, registerWebhookRoutes, type BuildTrigger } from "./webhooks.js";
import { registerV2Routes } from "./v2-routes.js";
import { registerEnvRoutes } from "./env-routes.js";
import { registerTerraformProviderRoutes } from "./terraform-provider-routes.js";
import { guardRequest, isLoopbackRequest, isTokenRequest, registerApiTokenRoutes } from "./api-tokens.js";
import { routeAccess } from "./access.js";
import type { V2 } from "./v2.js";
import type { ResolvedEnv } from "./env-vars.js";
import type { Mode } from "./mode.js";
import { envNameFor } from "./setup.js";
import { environmentClusterId } from "./connections.js";

// serializeEnvironment parses the stored config string back into a
// real JSON value before it reaches a client — Environment.config is
// a json.RawMessage in Go, sent as a JSON object; stored as a plain
// string on the TS side (store.ts), it was being sent back
// double-encoded (a JSON string of JSON) until this fix.
function serializeEnvironment(e: Environment): Record<string, unknown> {
  return { ...e, config: JSON.parse(e.config) };
}

// isRecord rejects null, arrays, and primitives — the shapes that
// made `body.name`/`body.target`/`body.nboDir` throw a TypeError
// outside any try below instead of producing a clean 400. Exported
// for webhooks.ts's own git-config/build routes — the other half of
// this same "small Fetch-style HTTP helpers" concern, kept in its own
// file only because its webhook-signature logic differs materially
// from this file's plain request.json() pattern.
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// DeploymentTrigger is the minimal shape the deployment route needs
// — not named Orchestrator (deploy.ts's own Orchestrator is a plain
// { store } data bag the free function triggerDeploy operates on, a
// different shape entirely); a caller wiring createMux to a real
// deploy.ts Orchestrator passes
// `{ triggerDeploy: (id, dir) => triggerDeploy(orchestrator, id, dir) }`.
export interface DeploymentTrigger {
  // onProgress receives timed deploy sub-step messages (no timestamp).
  // buildId is recorded on the deployment row (which build it runs).
  // redact: values never to record in an error (the runner's list).
  triggerDeploy(
    environmentId: string,
    nboDir: string,
    opts?: { progress?: (message: string) => void; env?: ResolvedEnv; fingerprint?: string | null; buildId?: string; redact?: string[] },
  ): Promise<Deployment>;
}

export function writeJSON(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export function writeError(status: number, message: string): Response {
  return writeJSON({ error: message }, status);
}

// statusForStoreError maps this package's own error classes to the
// HTTP status a client should see; anything else is a 500 — port of
// statusForStoreError (handlers.go lines 30-41), using `instanceof`
// in place of Go's own `errors.Is`.
export function statusForStoreError(err: unknown): number {
  if (err instanceof ErrNotFound) return 404;
  if (err instanceof ErrDuplicateName) return 409;
  if (err instanceof ErrConflict) return 409;
  if (err instanceof ErrInvalid) return 400;
  if (err instanceof ErrInvalidEnvVar) return 400;
  if (err instanceof ErrInvalidEnvironmentConfig) return 400;
  if (err instanceof ErrInvalidGitConfig) return 400;
  return 500;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function registerProjectRoutes(router: ReturnType<typeof createRouter>, store: Store): void {
  router.handle("POST", "/projects", async (request) => {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return writeError(400, "name is required");
    }
    if (!isRecord(parsed) || typeof parsed.name !== "string" || !parsed.name) return writeError(400, "name is required");
    const body = parsed as { name: string };
    // An environment's host is <label>--<project>, so "--" could collide with it.
    if (body.name.includes("--")) return writeError(400, 'name can\'t contain "--" (two hyphens in a row)');
    try {
      const p = store.createProject(body.name);
      return writeJSON(p, 201);
    } catch (err) {
      return writeError(statusForStoreError(err), errorMessage(err));
    }
  });

  router.handle("GET", "/projects", async () => {
    try {
      return writeJSON(store.listProjects(), 200);
    } catch (err) {
      return writeError(500, errorMessage(err));
    }
  });

  router.handle("GET", "/projects/{projectID}", async (_request, params) => {
    try {
      return writeJSON(store.getProject(params.projectID!), 200);
    } catch (err) {
      return writeError(statusForStoreError(err), errorMessage(err));
    }
  });
}

// productionKubernetesCheck applies the v2 rules to a Kubernetes
// environment made through the legacy route in production: it names a
// connected cluster (config.clusterId), is named as setup would name it,
// and is the project's only live environment on that cluster.
function productionKubernetesCheck(store: Store, projectId: string, name: string, config: unknown): Response | null {
  const clusterId = isRecord(config) ? config.clusterId : undefined;
  const cluster = typeof clusterId === "string" ? store.getKubernetesConnection(clusterId) : null;
  if (!cluster) return writeError(400, "a Kubernetes environment needs config.clusterId naming a connected cluster");
  const want = envNameFor("kubernetes", cluster);
  if (name !== want) return writeError(400, `an environment on cluster ${cluster.name} is named "${want}"`);
  // Production's clouds only: a custom environment's row on the same
  // cluster is another app and never collides.
  if (store.listEnvironments(projectId).some((e) => e.target === "kubernetes" && environmentClusterId(e.config) === cluster.id)) {
    return writeError(409, `this project already runs on ${cluster.name}`);
  }
  return null;
}

function registerEnvironmentRoutes(router: ReturnType<typeof createRouter>, store: Store, mode: Mode): void {
  router.handle("POST", "/projects/{projectID}/environments", async (request, params) => {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return writeError(400, "name and target are required");
    }
    if (!isRecord(parsed) || typeof parsed.name !== "string" || !parsed.name || typeof parsed.target !== "string" || !parsed.target) {
      return writeError(400, "name and target are required");
    }
    const body = parsed as { name: string; target: string; config?: unknown };
    if (mode === "production" && body.target === "kubernetes") {
      const refused = productionKubernetesCheck(store, params.projectID!, body.name, body.config);
      if (refused) return refused;
    }
    try {
      const config = body.config !== undefined ? JSON.stringify(body.config) : undefined;
      const e = store.createEnvironment(params.projectID!, body.name, body.target, config);
      return writeJSON(serializeEnvironment(e), 201);
    } catch (err) {
      return writeError(statusForStoreError(err), errorMessage(err));
    }
  });

  router.handle("GET", "/projects/{projectID}/environments", async (_request, params) => {
    try {
      return writeJSON(store.listEnvironments(params.projectID!).map(serializeEnvironment), 200);
    } catch (err) {
      return writeError(500, errorMessage(err));
    }
  });

  router.handle("GET", "/environments/{environmentID}", async (_request, params) => {
    try {
      return writeJSON(serializeEnvironment(store.getEnvironment(params.environmentID!)), 200);
    } catch (err) {
      return writeError(statusForStoreError(err), errorMessage(err));
    }
  });
}

function registerDeploymentRoutes(router: ReturnType<typeof createRouter>, store: Store, orchestrator?: DeploymentTrigger): void {
  router.handle("POST", "/environments/{environmentID}/deployments", async (request, params) => {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return writeError(400, "nboDir is required");
    }
    if (!isRecord(parsed) || typeof parsed.nboDir !== "string" || !parsed.nboDir) return writeError(400, "nboDir is required");
    const body = parsed as { nboDir: string };
    try {
      const dep = await orchestrator!.triggerDeploy(params.environmentID!, body.nboDir);
      return writeJSON(dep, 201);
    } catch (err) {
      return writeError(statusForStoreError(err), errorMessage(err));
    }
  });

  router.handle("GET", "/environments/{environmentID}/deployments", async (_request, params) => {
    try {
      return writeJSON(store.listDeployments(params.environmentID!), 200);
    } catch (err) {
      return writeError(500, errorMessage(err));
    }
  });
}

// createMux builds the control plane's HTTP API as a single
// Fetch-style handler — port of NewMux (handlers.go lines 9-16), now
// a plain function rather than an http.Handler object, matching this
// whole rewrite's own established function convention. Directly
// unit-testable by constructing a real Request and awaiting the
// Response, with no real socket needed at all.
// isAllowedRequest is the loopback rule for requests that carry no API token
// (see guardRequest in api-tokens.ts, which decides for requests that do).
export function isAllowedRequest(request: Request): boolean {
  return isLoopbackRequest(request);
}

// Mux is createMux's handler; routes() lists every registered route
// ("<METHOD> <pattern>"), which access-table.test.ts holds against access.ts.
export type Mux = ((request: Request) => Promise<Response>) & { routes(): string[] };

export function createMux(store: Store, orchestrator?: DeploymentTrigger, trigger?: BuildTrigger, v2?: V2): Mux {
  const router = createRouter();
  // A liveness answer for Compose and load balancers. It says nothing about
  // the server but that it runs, so it needs no token from any Host.
  router.handle("GET", "/healthz", async () => writeJSON({ ok: true }, 200));
  // v2 first: the router matches in registration order, and
  // GET /projects/summary must win over GET /projects/{projectID}.
  if (v2) registerV2Routes(router, store, v2);
  registerProjectRoutes(router, store);
  registerEnvironmentRoutes(router, store, v2?.mode ?? "dev");
  registerDeploymentRoutes(router, store, orchestrator);
  registerGitConfigRoutes(router, store, { keygen: v2?.keygen });
  registerEnvRoutes(router, store);
  registerWebhookRoutes(router, store, trigger);
  registerApiTokenRoutes(router, store);
  registerTerraformProviderRoutes(router, () => process.env.NBO_TERRAFORM_PROVIDER_DIR || undefined);
  const publicUrl = v2?.publicUrl;
  // The token-only gate: the route's row in access.ts, then guardRequest
  // (api-tokens.ts) for everything but GET /healthz. A route with no row is
  // refused, so a route added without one never opens by accident.
  const mux = async (request: Request): Promise<Response> => {
    const route = router.match(request);
    const level = route ? routeAccess[`${route.method} ${route.pattern}`] : undefined;
    if (route && level === undefined) {
      console.error(`control-plane: route ${route.method} ${route.pattern} has no access level in access.ts; refused`);
      return writeError(403, "this route has no access level");
    }
    // Exactly GET /healthz (see its route above).
    if (level === "public") return router(request);
    const refused = guardRequest(request, new URL(request.url).pathname, store, publicUrl, level);
    if (refused) return refused;
    // guardRequest refuses tokens on local routes by path; the row says so
    // too, and a token never passes a local row whatever the path check said.
    if (level === "local" && isTokenRequest(request)) return writeError(403, "API tokens can't use this route");
    return router(request);
  };
  return Object.assign(mux, { routes: () => router.routes() });
}
