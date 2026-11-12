// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ISR_CACHE_KEY is the /functions.json key the app server finds the
// ISR cache under. @nbo/serve exports the same constant; this package
// keeps its own copy rather than depending on @nbo/serve, and a
// @nbo/cli test asserts the two are equal.
export const ISR_CACHE_KEY = "__isrcache";

// IsrOptions is what the control-plane tells a target about the ISR
// cache for one deploy: enabled deploys `<app>-isr` (for a build with
// prerender routes), removeCache removes it after the new app is live
// (the previous live build had prerender routes, this one has none).
// Targets read it at call time, like extraEnv; without it (the `nbo
// deploy` CLI) a target defines neither cache step.
export interface IsrOptions {
  enabled: boolean;
  removeCache: boolean;
}

// hasPrerenderRoutes reports whether the build's prerender.json exists
// and lists at least one prerender route. validate() has already
// checked the file by the time deploy() asks.
export async function hasPrerenderRoutes(nboDir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(nboDir, "prerender.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const doc = JSON.parse(raw) as { prerenders?: unknown };
  return Array.isArray(doc.prerenders) && doc.prerenders.length > 0;
}
