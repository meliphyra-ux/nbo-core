// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { ErrNotFound, type Store } from "../store/store.js";
import type { Router } from "../http/router.js";
import type { Stage } from "./stages.js";
import type { V2 } from "../v2.js";
import { writeError, statusForStoreError, errorMessage } from "../http/handlers.js";
import { parseRevalidateBody, revalidateStage } from "./revalidate.js";
import type { RevalidateToken } from "../variables/revalidate-tokens.js";

// The revalidation routes of a stage (environment): revalidate its ISR
// pages (developer), and show or rotate its secret (admin; access.ts). The
// gate's audit row names only the route and its ids, never the secret.

// projectStage: the project's stage by id; a stage of another project is 404.
function projectStage(store: Store, projectId: string, stageId: string): Stage {
  const stage = store.getStage(stageId);
  if (stage.projectId !== projectId) throw new ErrNotFound(`environment "${stageId}"`);
  return stage;
}

function fail(err: unknown): Response {
  return writeError(statusForStoreError(err), errorMessage(err));
}

// noStore: the secret answers; POST already keeps caches away, this keeps
// a proxy from storing one anyway.
function secretAnswer(t: RevalidateToken): Response {
  return new Response(JSON.stringify({ secret: t.token, createdAt: t.createdAt }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function registerRevalidateRoutes(router: Router, store: Store, v2: V2): void {
  router.handle("POST", "/projects/{projectID}/stages/{stageID}/revalidate", async (request, params) => {
    try {
      const stage = projectStage(store, params.projectID!, params.stageID!);
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return writeError(400, "the request body must be a JSON object");
      }
      const body = parseRevalidateBody(raw);
      if (typeof body === "string") return writeError(400, body);
      const out = await revalidateStage(
        {
          store,
          mode: v2.mode,
          urlContext: { store, mode: v2.mode, edgePublicPort: v2.edgePublicPort },
          fetch: v2.revalidateFetch,
        },
        stage,
        body,
      );
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("POST", "/projects/{projectID}/stages/{stageID}/revalidate-secret", async (_request, params) => {
    try {
      const stage = projectStage(store, params.projectID!, params.stageID!);
      return secretAnswer(store.ensureRevalidateToken(stage.id));
    } catch (err) {
      return fail(err);
    }
  });

  router.handle("POST", "/projects/{projectID}/stages/{stageID}/revalidate-secret/rotate", async (_request, params) => {
    try {
      const stage = projectStage(store, params.projectID!, params.stageID!);
      return secretAnswer(store.rotateRevalidateToken(stage.id));
    } catch (err) {
      return fail(err);
    }
  });
}
