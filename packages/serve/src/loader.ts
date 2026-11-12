// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoutesDoc, TrailingSlashPolicy } from "@nbo/router";

export interface StaticEntry {
  file: string;
  contentType: string;
  cache: string;
}

// loadStaticIndex reads static.index.json and returns its files map
// as a lookup keyed by URL path — port of loadStaticIndex (serve.go
// lines 205-217).
export async function loadStaticIndex(nboDir: string): Promise<Map<string, StaticEntry>> {
  const raw = await readFile(join(nboDir, "static.index.json"), "utf8");
  const index = JSON.parse(raw) as { files: Record<string, StaticEntry> };
  return new Map(Object.entries(index.files));
}

// trailingSlashPolicy maps manifest.json's routing.trailingSlash
// string onto @nbo/router's own TrailingSlashPolicy, defaulting to
// "never" when absent or empty — port of trailingSlashPolicy
// (serve.go lines 189-203).
function trailingSlashPolicy(value: string): TrailingSlashPolicy {
  switch (value) {
    case "":
    case "never":
      return "never";
    case "always":
      return "always";
    case "preserve":
      return "preserve";
    default:
      throw new Error(`manifest.json: unknown routing.trailingSlash "${value}"`);
  }
}

// loadRoutesDoc reads routes.json directly as a RoutesDoc — its own
// field names (beforeFiles, pathNot, continue, …) already match
// @nbo/router's own camelCase shape, so no translation layer is
// needed here the way serve.go's own jsonRule/toRouterDoc dance was
// — port of loadRoutesDoc (serve.go lines 219-229), simplified.
export async function loadRoutesDoc(nboDir: string): Promise<RoutesDoc> {
  const raw = await readFile(join(nboDir, "routes.json"), "utf8");
  return JSON.parse(raw) as RoutesDoc;
}

// loadTrailingSlashPolicy reads manifest.json's routing.trailingSlash.
// manifest.json is optional — a missing file just means the default
// trailing-slash policy; a present-but-malformed file, or an
// unrecognized trailingSlash value, is still a hard error — port of
// loadTrailingSlashPolicy (serve.go lines 231-254).
export async function loadTrailingSlashPolicy(nboDir: string): Promise<TrailingSlashPolicy> {
  let raw: string;
  try {
    raw = await readFile(join(nboDir, "manifest.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "never";
    throw err;
  }
  const manifest = JSON.parse(raw) as { routing?: { trailingSlash?: string } };
  return trailingSlashPolicy(manifest.routing?.trailingSlash ?? "");
}
