// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "./artifacts.js";
import { listFunctions } from "./build-details.js";
import { errorMessage, statusForStoreError, writeError, writeJSON } from "./handlers.js";
import type { Router } from "./router.js";
import type { Store } from "./store.js";

const cleanedUp = "This build's output was cleaned up: redeploy to rebuild it";
const defaultLimit = 200;
const maxLimit = 500;

interface StaticEntry {
  contentType?: string;
  size?: number;
  cache?: string;
}

// registerBuildRoutes serves the stored output of a build for the build
// page: the static files (paged) and the functions. Everything is read
// from the build's artifact directory, found by build id only; request
// values (prefix, cursor) are filters on names, never filesystem paths.
export function registerBuildRoutes(router: Router, store: Store, artifacts: ArtifactStore | undefined): void {
  // outputDir: the build's stored .nbo/, or the error response.
  // A promote job shows the output of the build it deployed.
  const outputDir = (buildId: string): string | Response => {
    let stored = buildId;
    try {
      const build = store.getBuild(buildId);
      if (build.kind === "promote") stored = build.sourceBuildId;
    } catch (err) {
      return writeError(statusForStoreError(err), errorMessage(err));
    }
    return artifacts?.path(stored) ?? writeError(404, cleanedUp);
  };

  router.handle("GET", "/builds/{buildID}/files", async (request, params) => {
    const dir = outputDir(params.buildID!);
    if (typeof dir !== "string") return dir;
    const url = new URL(request.url);
    const prefix = url.searchParams.get("prefix") ?? "";
    const cursor = url.searchParams.get("cursor") ?? "";
    const rawLimit = url.searchParams.get("limit");
    let limit = defaultLimit;
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1) return writeError(400, "limit must be a positive whole number");
      limit = Math.min(limit, maxLimit);
    }
    try {
      let files: Record<string, StaticEntry> = {};
      try {
        files = (JSON.parse(await readFile(join(dir, "static.index.json"), "utf8")) as { files?: Record<string, StaticEntry> }).files ?? {};
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const paths = Object.keys(files)
        .filter((p) => p.startsWith(prefix) && (cursor === "" || p > cursor))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const page = paths.slice(0, limit);
      const items = page.map((path) => ({ path, contentType: files[path]!.contentType ?? "", size: files[path]!.size ?? 0, cache: files[path]!.cache ?? "" }));
      return writeJSON({ files: items, nextCursor: paths.length > limit ? page[page.length - 1]! : null }, 200);
    } catch (err) {
      return writeError(500, errorMessage(err));
    }
  });

  router.handle("GET", "/builds/{buildID}/functions", async (_request, params) => {
    const dir = outputDir(params.buildID!);
    if (typeof dir !== "string") return dir;
    try {
      return writeJSON({ functions: await listFunctions(dir) }, 200);
    } catch (err) {
      return writeError(500, errorMessage(err));
    }
  });
}
