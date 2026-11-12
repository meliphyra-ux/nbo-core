// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { contentId } from "@nbo/digest";
import type { GitConfig } from "./git.js";
import type { ResolvedEnv } from "./env-vars.js";

// Details captured while a build runs and stored on its row (JSON
// columns), for the build page. None of them ever holds an environment
// variable value: input lists names and their plain/secret kind only.

export interface BuildCommit {
  sha: string;
  message: string;
  author: string;
  committedAt: string;
}

export interface BuildInput {
  repo: string;
  productionBranch: string;
  framework: string;
  rootDirectory?: string;
  buildCommand: string;
  outputDir?: string;
  ignoredBuildStepCommand?: string;
  manual: boolean;
  // A keyed hash of the variable snapshot (never a value); null when the
  // build had no variables.
  envFingerprint: string | null;
  variables: { name: string; secret: boolean }[];
}

export interface TimelineEntry {
  name: string;
  startedAt: string;
  durationMs: number;
  status: "succeeded" | "failed" | "skipped";
  children?: TimelineEntry[];
}

export interface OutputSummary {
  framework: { name: string; version?: string };
  contentId: string;
  staticFiles: number;
  staticBytes: number;
  functions: { name: string; runtime: string; bundleBytes: number; memoryMb?: number; maxDurationSec?: number; routes: string[] }[];
  prerenders: number;
  images: boolean;
  crons: number;
}

// The format string the runner passes to `git log -1`: fields separated
// by \x1f (unit separator), which never appears in them.
export const commitLogFormat = "--format=%H%x1f%s%x1f%an%x1f%cI";
const maxMessage = 200;

// parseCommit reads `git log -1 --format=<commitLogFormat>` output. The
// captured output mixes stderr in, so the line with the separators is
// the one that counts. null when there is none.
export function parseCommit(output: string): BuildCommit | null {
  const line = output.split(/\r?\n/).find((l) => l.split("\x1f").length === 4);
  if (!line) return null;
  const [sha, message, author, committedAt] = line.split("\x1f") as [string, string, string, string];
  return { sha: sha.trim(), message: message.slice(0, maxMessage), author, committedAt: committedAt.trim() };
}

// buildInput records the settings a build used and the names (never the
// values) of the variables in its snapshot.
export function buildInput(config: GitConfig, manual: boolean, env: ResolvedEnv, envFingerprint: string | null = null): BuildInput {
  const secret = new Set(env.secretNames);
  const input: BuildInput = {
    repo: config.repo,
    productionBranch: config.productionBranch,
    framework: config.framework,
    buildCommand: config.buildCommand,
    manual,
    envFingerprint,
    variables: Object.keys(env.vars)
      .sort()
      .map((name) => ({ name, secret: secret.has(name) })),
  };
  if (config.rootDirectory) input.rootDirectory = config.rootDirectory;
  if (config.outputDir) input.outputDir = config.outputDir;
  if (config.ignoredBuildStepCommand) input.ignoredBuildStepCommand = config.ignoredBuildStepCommand;
  return input;
}

export interface Timeline {
  readonly entries: TimelineEntry[];
  // begin appends an entry (in begin order) and starts its clock.
  begin(name: string): TimelineEntry;
  // end settles an entry: its duration and status.
  end(entry: TimelineEntry, status: TimelineEntry["status"]): void;
}

// createTimeline records the build's phases with the runner's own clock;
// the runner's "done in" log lines are worded from the same durations.
export function createTimeline(now: () => number): Timeline {
  const entries: TimelineEntry[] = [];
  const starts = new WeakMap<TimelineEntry, number>();
  return {
    entries,
    begin(name) {
      const t = now();
      const entry: TimelineEntry = { name, startedAt: iso(t), durationMs: 0, status: "succeeded", children: [] };
      starts.set(entry, t);
      entries.push(entry);
      return entry;
    },
    end(entry, status) {
      entry.durationMs = Math.max(0, now() - (starts.get(entry) ?? now()));
      entry.status = status;
      if (entry.children && entry.children.length === 0) delete entry.children;
    },
  };
}

// parseSubStep turns one deploy progress message (@nbo/deploy's wording:
// "<done> in N.Ns", "<fail> failed after N.Ns", "<what>, skipped") into a
// timeline entry ending at `at`; other messages are not steps (null).
export function parseSubStep(message: string, at: number): TimelineEntry | null {
  const failed = /^(.+?) failed after (\d+(?:\.\d+)?)s$/.exec(message);
  const done = failed ? null : /^(.+?) in (\d+(?:\.\d+)?)s$/.exec(message);
  const m = failed ?? done;
  if (m) {
    const durationMs = Math.round(Number(m[2]) * 1000);
    return { name: m[1]!, startedAt: iso(at - durationMs), durationMs, status: failed ? "failed" : "succeeded" };
  }
  const skipped = /^(.+?), skipped$/.exec(message);
  if (skipped) return { name: skipped[1]!, startedAt: iso(at), durationMs: 0, status: "skipped" };
  return null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

type Rule = { match?: { path?: string }; action?: { function?: string } };
type RoutesFile = { beforeFiles?: Rule[]; afterFiles?: Rule[]; fallback?: Rule[]; onMatch?: Rule[] };
type FunctionFile = {
  runtime?: { kind?: string; version?: string };
  handler?: { entry?: string };
  artifact?: { path?: string; files?: string };
  resources?: { memoryMb?: number; maxDurationSec?: number };
};
type Manifest = { build?: { framework?: { name?: string; version?: string } }; functions?: string[]; images?: unknown; crons?: unknown[] };

export interface FunctionInfo {
  name: string;
  runtime: string;
  entry: string;
  bundleBytes: number;
  memoryMb?: number;
  maxDurationSec?: number;
  routes: string[];
}

const plainName = /^[A-Za-z0-9._-]+$/;

// validFunctionName: names become path segments, so only plain ones pass.
export function validFunctionName(name: string): boolean {
  return plainName.test(name) && !name.includes("..");
}

// inside resolves rel under base, or null when it would leave base.
function inside(base: string, rel: string): string | null {
  const root = resolve(base);
  const full = resolve(root, rel);
  return full === root || full.startsWith(root + sep) ? full : null;
}

// readBundleIndex reads the bundle index a function.json declares. Every
// step is resolved through realpath and must stay inside the function's
// own directory, so neither "..", a symlinked directory nor a symlinked
// file can point it elsewhere; anything off-limits reads as no index.
async function readBundleIndex(fnDir: string, bundlePath: string, files: string): Promise<{ files?: Record<string, { size?: number }> } | undefined> {
  try {
    const fnReal = await realpath(fnDir);
    const bundleLexical = inside(fnReal, bundlePath);
    if (!bundleLexical) return undefined;
    const bundleReal = await realpath(bundleLexical);
    if (!inside(fnReal, bundleReal)) return undefined;
    const indexLexical = inside(bundleReal, files);
    if (!indexLexical) return undefined;
    const indexReal = await realpath(indexLexical);
    if (indexReal !== indexLexical || !inside(fnReal, indexReal) || !(await stat(indexReal)).isFile()) return undefined;
    return await readJson<{ files?: Record<string, { size?: number }> }>(indexReal);
  } catch {
    return undefined;
  }
}

// listFunctions reads the functions of a .nbo/ directory: runtime, entry,
// resources, routes (from routes.json) and the bundle size, summed from
// the bundle index the function.json declares (artifact.path/files).
export async function listFunctions(nboDir: string): Promise<FunctionInfo[]> {
  const manifest = await readJson<Manifest>(join(nboDir, "manifest.json"));
  if (!manifest) throw new Error(`${nboDir} has no manifest.json`);
  const routes = await readJson<RoutesFile>(join(nboDir, "routes.json"));
  const rules = [...(routes?.beforeFiles ?? []), ...(routes?.afterFiles ?? []), ...(routes?.fallback ?? []), ...(routes?.onMatch ?? [])];
  const out: FunctionInfo[] = [];
  for (const name of manifest.functions ?? []) {
    if (!validFunctionName(name)) continue;
    const fnDir = join(nboDir, "functions", name);
    let fn: FunctionFile;
    try {
      fn = (await readJson<FunctionFile>(join(fnDir, "function.json"))) ?? {};
    } catch {
      continue; // a corrupt function.json hides that function, not the rest
    }
    let bundleBytes = 0;
    if (fn.artifact?.path !== undefined && fn.artifact.files !== undefined) {
      const index = await readBundleIndex(fnDir, fn.artifact.path, fn.artifact.files);
      bundleBytes = Object.values(index?.files ?? {}).reduce((sum, f) => sum + (f.size ?? 0), 0);
    }
    const routesFor = new Set<string>();
    for (const r of rules) if (r.action?.function === name && r.match?.path !== undefined) routesFor.add(r.match.path);
    const entry: FunctionInfo = {
      name,
      runtime: [fn.runtime?.kind ?? "unknown", fn.runtime?.version].filter(Boolean).join(" "),
      entry: fn.handler?.entry ?? "",
      bundleBytes,
      routes: [...routesFor],
    };
    if (fn.resources?.memoryMb !== undefined) entry.memoryMb = fn.resources.memoryMb;
    if (fn.resources?.maxDurationSec !== undefined) entry.maxDurationSec = fn.resources.maxDurationSec;
    out.push(entry);
  }
  return out;
}

// summarizeOutput reads a build's .nbo/ (local files only) into the
// numbers the build page shows.
export async function summarizeOutput(nboDir: string): Promise<OutputSummary> {
  const manifest = await readJson<Manifest>(join(nboDir, "manifest.json"));
  if (!manifest) throw new Error(`${nboDir} has no manifest.json`);
  const staticIndex = await readJson<{ files?: Record<string, { size?: number }> }>(join(nboDir, "static.index.json"));
  const prerender = await readJson<{ prerenders?: unknown[] }>(join(nboDir, "prerender.json"));
  const staticEntries = Object.values(staticIndex?.files ?? {});
  const functions: OutputSummary["functions"] = (await listFunctions(nboDir)).map(({ entry: _entry, ...rest }) => rest);

  const framework: OutputSummary["framework"] = { name: manifest.build?.framework?.name ?? "unknown" };
  if (manifest.build?.framework?.version) framework.version = manifest.build.framework.version;
  return {
    framework,
    contentId: contentId(manifest as Record<string, unknown>),
    staticFiles: staticEntries.length,
    staticBytes: staticEntries.reduce((sum, f) => sum + (f.size ?? 0), 0),
    functions,
    prerenders: prerender?.prerenders?.length ?? 0,
    images: manifest.images !== undefined,
    crons: manifest.crons?.length ?? 0,
  };
}

// readJson returns undefined for a file that does not exist (optional
// .nbo/ files); any other error is thrown.
export async function readJson<T>(path: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(raw) as T;
}
