// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { redact } from "@nbo/deploy";
import { ErrInvalidEnvVar, ErrNotFound } from "./errors.js";
import { errorMessage, isRecord, writeError, writeJSON } from "./handlers.js";
import type { Router } from "./router.js";
import type { Store } from "./store.js";

type Scope = { projectId: string | null };

// Variable routes never serialise a secret's value: the store's views omit
// it, and any error text is scrubbed of the request's own value anyway.
export function registerEnvRoutes(router: Router, store: Store): void {
  const fail = (err: unknown, secrets: string[] = []): Response => {
    const message = redact(errorMessage(err), secrets.filter(Boolean));
    if (err instanceof ErrInvalidEnvVar) return writeError(400, message);
    if (err instanceof ErrNotFound) return writeError(404, message);
    return writeError(500, message);
  };

  // ?stage= names the environment; production when absent.
  const stageOf = (request: Request): string => new URL(request.url).searchParams.get("stage") || "production";

  const put = async (request: Request, scope: Scope, name: string): Promise<Response> => {
    let secrets: string[] = [];
    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return writeError(400, "the request body must be JSON");
      }
      if (!isRecord(body)) return writeError(400, "the request body must be a JSON object");
      // No value declares the name (how names are kept while NBO stores no values).
      if (body.value !== undefined && typeof body.value !== "string") return writeError(400, "value must be a string");
      if (typeof body.secret !== "boolean") return writeError(400, "secret must be true or false");
      const value = typeof body.value === "string" ? body.value : null;
      if (value !== null) secrets = [value];
      if (scope.projectId !== null) store.getProject(scope.projectId);
      return writeJSON(store.setEnv(scope, name, value, body.secret, stageOf(request)), 200);
    } catch (err) {
      return fail(err, secrets);
    }
  };

  const del = (request: Request, scope: Scope, name: string): Response => {
    try {
      if (scope.projectId !== null) store.getProject(scope.projectId);
      store.deleteEnv(scope, name, stageOf(request));
      return new Response(null, { status: 204 });
    } catch (err) {
      return fail(err);
    }
  };

  // Whether NBO keeps variable values; anyone may read it (Terraform and
  // the dashboard decide whether to send values with a deploy).
  router.handle("GET", "/workspace/settings", async () => {
    try {
      return writeJSON({ storeEnvValues: store.getServerSettings().envValues !== "none" }, 200);
    } catch (err) {
      return fail(err);
    }
  });
  // Dashboard only (tokens get 403 on /system/*). Turning names only on
  // deletes every stored value, so it needs confirm: "delete values".
  router.handle("PATCH", "/system/workspace-settings", async (request) => {
    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return writeError(400, "the request body must be JSON");
      }
      if (!isRecord(body) || typeof body.storeEnvValues !== "boolean") return writeError(400, "storeEnvValues must be true or false");
      for (const k of Object.keys(body)) if (k !== "storeEnvValues" && k !== "confirm") return writeError(400, `unknown field "${k}"`);
      if (body.storeEnvValues) {
        store.updateServerSettings({ envValues: "stored" });
      } else if (store.getServerSettings().envValues !== "none") {
        if (body.confirm !== "delete values") {
          return writeError(400, 'This deletes every stored variable value. Send confirm: "delete values" to go ahead.');
        }
        store.clearStoredValues();
      }
      return writeJSON({ storeEnvValues: store.getServerSettings().envValues !== "none" }, 200);
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("GET", "/workspace/env", async () => {
    try {
      return writeJSON(store.listWorkspaceEnv(), 200);
    } catch (err) {
      return fail(err);
    }
  });
  router.handle("PUT", "/workspace/env/{name}", (request, params) => put(request, { projectId: null }, params.name!));
  router.handle("DELETE", "/workspace/env/{name}", async (request, params) => del(request, { projectId: null }, params.name!));

  router.handle("GET", "/projects/{projectID}/env", async (_request, params) => {
    try {
      return writeJSON(store.listProjectEnv(params.projectID!), 200);
    } catch (err) {
      return fail(err);
    }
  });
  // The current variables' keyed fingerprint (no names, no values): the
  // build page compares it with a build's recorded one. null when NBO
  // stores no values: there is nothing to compare.
  router.handle("GET", "/projects/{projectID}/env/fingerprint", async (request, params) => {
    try {
      store.getProject(params.projectID!);
      if (store.getServerSettings().envValues === "none") return writeJSON({ fingerprint: null }, 200);
      return writeJSON({ fingerprint: store.envFingerprintFor(store.resolveEnv(params.projectID!, stageOf(request))) }, 200);
    } catch (err) {
      return fail(err);
    }
  });
  router.handle("PUT", "/projects/{projectID}/env/{name}", (request, params) => put(request, { projectId: params.projectID! }, params.name!));
  router.handle("DELETE", "/projects/{projectID}/env/{name}", async (request, params) => del(request, { projectId: params.projectID! }, params.name!));
}
