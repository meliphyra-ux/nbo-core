// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validate } from "@nbo/validate";
import { contentId } from "@nbo/digest";
import { type AdapterCapabilities, evaluate, loadFromDir, planToString } from "@nbo/planner";
import { createProgress, type ProgressOptions } from "./progress.js";
import { checkRequired, type UserEnv } from "./env.js";
import { hasPrerenderRoutes } from "./isr.js";

export interface DeployResult {
  contentID: string;
  alreadyLive: boolean;
  url: string;
  // plan is the readable plan report when a planner was configured
  // (empty otherwise), set on every successful return so a passing
  // plan's warnings and emulations — not just a failing one's —
  // reach the caller instead of being discarded.
  plan: string;
}

// Deployer's cluster-touching operations are injectable functions so
// the no-op/deploy decision logic can be tested without a real
// cluster — the real wiring (createKubernetesTarget/
// createCloudRunTarget) fills these in with sub-project 5a's own
// adapter packages.
export interface Deployer {
  // capabilities is optional — undefined, or a name of "", means no
  // planner is configured and deploy skips the plan entirely.
  capabilities?: AdapterCapabilities;
  // fingerprint is the env fingerprint stored next to the live content
  // id (absent when none is stored).
  liveContentID: (appName: string) => Promise<{ id: string; ok: boolean; fingerprint?: string | null }>;
  // userEnv is the project's variable snapshot for this deploy. When
  // set, deploy() checks the build's required names before any cloud
  // call, and "already live" also needs the stored fingerprint to equal
  // userEnv.fingerprint. Undefined: no fingerprint (the CLI's case).
  userEnv?: UserEnv;
  // providedEnvNames lists the names NBO itself supplies to the app
  // (its own extraEnv, and in dev NBO's own environment as a fallback),
  // which count as available for the required check.
  providedEnvNames?: () => string[];
  // deployFunctions is optional — undefined for a static-only build.
  // When the manifest's functions array is non-empty, it's called
  // once, before buildAndDeploy, with every function name.
  deployFunctions?: (nboDir: string, appName: string, functionNames: string[]) => Promise<Record<string, string>>;
  // deployIsrCache deploys `<app>-isr` for a build with prerender
  // routes and returns its URL; deploy() calls it after the "already
  // live" check and before deployFunctions, so the URL is known when the
  // app image is built. Targets expose it as a getter, defined only
  // while their isr.enabled holds (read at call time, like userEnv).
  // Undefined with prerender routes (the `nbo deploy` CLI): the pages
  // are served uncached, and deploy() says so once.
  deployIsrCache?: (nboDir: string, appName: string) => Promise<string>;
  // removeIsrCache removes `<app>-isr` after the new app is live, for
  // a build with no prerender routes. A getter defined only while the
  // target's isr.removeCache holds. Best effort: a rejection becomes a
  // progress line, never a failed deploy.
  removeIsrCache?: (appName: string) => Promise<void>;
  buildAndDeploy: (nboDir: string, appName: string, contentID: string) => Promise<void>;
  urlFor?: (appName: string) => string;
  // idsMatch compares the live content id liveContentID returned
  // against the one just computed from the build — optional;
  // undefined means ordinary string equality (Kubernetes' case: its
  // annotation storage holds the full id). Cloud Run's own storage, a
  // GCP label, can't hold the full id (63-char limit) and stores a
  // truncated form instead, so its wiring supplies a comparator that
  // truncates the computed id the same way before comparing.
  idsMatch?: (liveID: string, wantID: string) => boolean;
}

// manifestFunctionNames reads manifest["functions"] (already parsed
// by deploy) as a string[], returning [] for a static-only build (an
// empty or absent array, or any entry that isn't a string — matching
// Go's own []any type-switch, which silently skips a non-string
// entry rather than erroring or including it).
function manifestFunctionNames(manifest: Record<string, unknown>): string[] {
  const raw = manifest.functions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

function urlFor(d: Deployer, appName: string): string {
  return d.urlFor ? d.urlFor(appName) : "";
}

export async function deploy(
  d: Deployer,
  nboDir: string,
  appName: string,
  progress?: ProgressOptions,
): Promise<DeployResult> {
  const p = createProgress(progress);
  await p.timed("build validated", "build validation", async () => {
    const errs = validate(nboDir);
    if (errs.length > 0) {
      throw new Error(`refusing to deploy an invalid build: ${errs.map((e) => e.message).join("; ")}`);
    }
  });

  const userEnv = d.userEnv;
  if (userEnv) {
    await checkRequired(nboDir, new Set([...Object.keys(userEnv.vars), ...(d.providedEnvNames?.() ?? [])]));
  }

  let planReport = "";
  const caps = d.capabilities;
  if (caps?.name) {
    planReport = await p.timed("plan evaluated", "plan evaluation", async () => {
      const { manifest, functions } = await loadFromDir(nboDir);
      const plan = evaluate(manifest, functions, caps);
      if (!plan.ok) {
        throw new Error(`refusing to deploy: plan failed for target "${caps.name}"\n${planToString(plan)}`);
      }
      return planToString(plan);
    });
  }

  const raw = await readFile(join(nboDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  const id = contentId(manifest);

  const live = await p.timed("live content id checked", "live content id check", () => d.liveContentID(appName));
  const idsMatch = d.idsMatch ?? ((a: string, b: string) => a === b);
  // Absent and null both mean "no variables": a project without
  // variables skips exactly as before.
  const fingerprintMatches = (live.fingerprint ?? null) === (userEnv?.fingerprint ?? null);
  if (live.ok && idsMatch(live.id, id) && fingerprintMatches) {
    p.report(`content id ${id} is already live, skipped`);
    return { contentID: id, alreadyLive: true, url: urlFor(d, appName), plan: planReport };
  }

  const prerender = await hasPrerenderRoutes(nboDir);
  if (prerender) {
    const deployIsrCache = d.deployIsrCache;
    if (deployIsrCache) {
      await deployIsrCache(nboDir, appName);
    } else {
      p.report("prerender routes are served uncached: this deploy runs no ISR cache");
    }
  }

  const functionNames = manifestFunctionNames(manifest);
  if (functionNames.length > 0 && d.deployFunctions) {
    await d.deployFunctions(nboDir, appName, functionNames);
  }

  await d.buildAndDeploy(nboDir, appName, id);

  if (!prerender) {
    const removeIsrCache = d.removeIsrCache;
    if (removeIsrCache) {
      try {
        await removeIsrCache(appName);
      } catch (err) {
        const first = (err instanceof Error ? err.message : String(err)).split("\n")[0];
        p.report(`ISR cache not removed (the new app is live): ${first}`);
      }
    }
  }
  return { contentID: id, alreadyLive: false, url: urlFor(d, appName), plan: planReport };
}
