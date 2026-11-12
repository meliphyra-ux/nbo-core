// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// mergeEnvVars returns a new object with every entry of base, then
// every entry of extra overlaid on top (extra wins on a key
// collision) — extra is the caller-computed values (e.g. a cron
// signing secret) that take precedence over anything
// deployTimeEnvVars itself resolved under the same name.
export function mergeEnvVars(base: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  return { ...base, ...extra };
}

// UserEnv is the project's variable snapshot for one deploy (workspace +
// project variables, resolved once per build): vars by name, which of
// them are secret, and the set's fingerprint (null for an empty set).
// Its values are delivered at runtime, never baked into an image.
export interface UserEnv {
  vars: Record<string, string>;
  secretNames: string[];
  fingerprint: string | null;
  // secretHashes: for each secret name, a keyed hash of its value (32
  // hex; never the value), kept as a label on its Secret Manager secret
  // so an unchanged value adds no version and is never read back.
  secretHashes?: Record<string, string>;
}

// isrOptionalEnvNames are ISR's own two env names (NBO_ISRCACHE_URL,
// NBO_PRERENDER_BYPASS) — folded into this general mechanism as
// optional names every build implicitly carries, rather than kept as
// a separate, special-cased resolution path.
const isrOptionalEnvNames = ["NBO_ISRCACHE_URL", "NBO_PRERENDER_BYPASS"];

interface ManifestEnvDoc {
  env?: { required?: string[]; optional?: string[] };
  bindings?: { name: string; type: string }[];
}

async function readManifestEnvDoc(nboDir: string): Promise<ManifestEnvDoc> {
  const raw = await readFile(join(nboDir, "manifest.json"), "utf8");
  return JSON.parse(raw) as ManifestEnvDoc;
}

// requiredNames is every name a build cannot run without: env.required
// plus each declared binding's <NAME>_URL.
function requiredNames(doc: ManifestEnvDoc): string[] {
  return [...(doc.env?.required ?? []), ...(doc.bindings ?? []).map((b) => `${b.name.toUpperCase()}_URL`)];
}

// checkRequired fails, naming every missing name at once, when a name
// the build requires is not in available (the user's variables, the
// names NBO itself provides, and in dev NBO's own environment).
export async function checkRequired(nboDir: string, available: Set<string>): Promise<void> {
  const missing = requiredNames(await readManifestEnvDoc(nboDir)).filter((n) => !available.has(n));
  if (missing.length > 0) {
    throw new Error(`deploy: missing required environment variable(s): ${missing.join(", ")} - set them with PUT /projects/{id}/env/{name} or Terraform's nbo_env_var`);
  }
}

// deployTimeEnvVars resolves manifest.json's own env.required/
// env.optional and every declared binding's own <NAME>_URL from the
// deploying operator's own shell environment. A required name (and
// every binding — bindings have no required/optional distinction of
// their own in the schema, so every declared binding is required)
// with no value anywhere in that environment fails with one combined
// error naming every missing name at once, not just the first, so an
// operator sees everything they need to set in a single deploy
// attempt. The result is baked into the deployed app's image as
// /env.json (@nbo/adapter-k8s's own buildImage).
//
// opts.source is where values are read from (default: NBO's own
// process.env, the dev behaviour). Production deploys pass `{}`: an
// app gets only NBO's own values (e.g. its cron signing secret, merged
// in by the caller), never NBO's own environment; the project's own
// variables are delivered at runtime (see opts.delivered).
//
// opts.delivered names the user's variables: they reach the app at
// runtime instead, so they are never read from source (not baked into
// the image) and never count as missing.
export async function deployTimeEnvVars(nboDir: string, opts?: { source?: Record<string, string | undefined>; delivered?: Iterable<string> }): Promise<Record<string, string>> {
  const delivered = new Set(opts?.delivered ?? []);
  const given = opts?.source ?? process.env;
  const source = (name: string): string | undefined => (delivered.has(name) ? undefined : given[name]);
  const doc = await readManifestEnvDoc(nboDir);

  const out: Record<string, string> = {};
  const missing: string[] = [];

  const required = doc.env?.required ?? [];
  const optional = [...isrOptionalEnvNames, ...(doc.env?.optional ?? [])];

  for (const name of required) {
    if (delivered.has(name)) continue;
    const v = source(name);
    if (v) {
      out[name] = v;
    } else {
      missing.push(name);
    }
  }
  for (const b of doc.bindings ?? []) {
    const name = `${b.name.toUpperCase()}_URL`;
    if (delivered.has(name)) continue;
    const v = source(name);
    if (v) {
      out[name] = v;
    } else {
      missing.push(name);
    }
  }
  for (const name of optional) {
    const v = source(name);
    if (v) out[name] = v;
  }

  if (missing.length > 0) {
    const hint = opts?.source ? " - NBO does not pass its own environment to apps; set them with PUT /projects/{id}/env/{name} or Terraform's nbo_env_var" : "";
    throw new Error(`deploy: missing required env/binding value(s): ${missing.join(", ")}${hint}`);
  }
  return out;
}

// imageEnvVars is what goes into an image's /env.json: NBO's own values
// only (deployTimeEnvVars plus extraEnv). Connected deploys read nothing
// from NBO's environment; the user's variables (userEnv) are delivered
// at runtime and never baked in. Without userEnv this is exactly the
// pre-variables behaviour.
export async function imageEnvVars(nboDir: string, connected: boolean, extraEnv: Record<string, string>, userEnv?: UserEnv): Promise<Record<string, string>> {
  const delivered = userEnv ? Object.keys(userEnv.vars) : [];
  const vars = await deployTimeEnvVars(nboDir, connected ? { source: {}, delivered } : { delivered });
  return mergeEnvVars(vars, extraEnv);
}

// providedEnvNames is what NBO itself supplies to an app for the
// required check: extraEnv, and in dev NBO's own environment (a
// fallback for names no variable sets).
export function providedEnvNames(connected: boolean, extraEnv: Record<string, string>): string[] {
  const own = connected ? [] : Object.keys(process.env).filter((k) => !!process.env[k]);
  return [...new Set([...Object.keys(extraEnv), ...own])];
}
