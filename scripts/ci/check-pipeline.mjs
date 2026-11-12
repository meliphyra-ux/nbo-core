#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich
// check-pipeline.mjs [--file <path>] [--print-job <name>] [--remote]
//
// Checks .gitlab-ci.yml against the pipeline's safety rules (docs/ci.md).
// Exit 0 and `pipeline ok (<n> jobs)`, or exit 1 with one
// `<job>: <reason>` line per failure on stderr.
//
//   --file <path>       check this file instead of the repo's .gitlab-ci.yml
//   --print-job <name>  print the job's before_script then script lines, one
//                       per line, and exit (the local rehearsal runs them)
//   --remote            also run `glab ci lint` when glab is installed
//
// `yaml` is resolved through packages/controlplane so the root workspace needs
// no new dependency.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRootDefault = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const STAGES = ["check", "determinism", "targets"];
// Required jobs and their stage.
const JOBS = {
  "node-checks": "check",
  lint: "check",
  "terraform-provider": "check",
  rust: "check",
  "edge-rust-blackbox": "check",
  "determinism-static": "determinism",
  "determinism-next": "determinism",
  kubernetes: "targets",
  cloudrun: "targets",
  "cloudrun-janitor": "targets",
};
// Jobs that may fail without failing the pipeline, each with a reason on file
// in docs/points-to-improve-or-fix.md.
const ALLOW_FAILURE = ["lint"];
const FORBIDDEN_GIT = ["add", "commit", "push", "stash", "reset", "checkout", "clean"];
const RESERVED = new Set(["stages", "workflow", "default", "variables", "include", "image", "services", "cache"]);
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;
const HARNESS_LAST = 'grep -q "all checks passed" harness.log';

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v.flat(Infinity) : [v]);

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

// Applies `extends` (hidden jobs and others), parents first.
function resolveJob(doc, name, seen = new Set()) {
  const raw = doc[name];
  if (!isObj(raw)) return undefined;
  if (seen.has(name)) return raw;
  seen.add(name);
  let out = {};
  for (const parent of asList(raw.extends)) {
    const p = resolveJob(doc, parent, seen);
    if (p) out = merge(out, p);
  }
  const { extends: _unused, ...rest } = raw;
  return merge(out, rest);
}

function jobNames(doc) {
  return Object.keys(doc).filter((k) => !k.startsWith(".") && !RESERVED.has(k) && isObj(doc[k]) && doc[k].script !== undefined);
}

function scriptLines(job) {
  return [...asList(job.before_script), ...asList(job.script), ...asList(job.after_script)].map(String);
}

function imageName(entry) {
  return typeof entry === "string" ? entry : isObj(entry) ? String(entry.name ?? "") : "";
}

function hasExactVersion(image) {
  const last = image.slice(image.lastIndexOf("/") + 1);
  const i = last.indexOf(":");
  if (i < 0) return false;
  const tag = last.slice(i + 1);
  return /^\d+\.\d+\.\d+([-.+].*)?$/.test(tag);
}

function trackedMode(repoRoot, rel) {
  const r = spawnSync("git", ["ls-files", "-s", "--", rel], { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0) return "";
  return r.stdout.trim().split(/\s+/)[0] ?? "";
}

// The exact refusing rules every job that holds the Google key must have.
const REFUSING = {
  merge_request: '$CI_PIPELINE_SOURCE == "merge_request_event"',
  CI_COMMIT_REF_PROTECTED: '$CI_COMMIT_REF_PROTECTED != "true"',
  NBO_CI_GCP_KEY: '$NBO_CI_GCP_KEY == null || $NBO_CI_GCP_KEY == ""',
};
// The only rules allowed to run such a job, in order.
const RUNNING = {
  cloudrun: [{ if: '$CI_PIPELINE_SOURCE == "schedule"' }, { when: "manual", allow_failure: true }],
  "cloudrun-janitor": [{ if: '$CI_PIPELINE_SOURCE == "schedule"' }],
};

// workspaceDeps maps each package under packages/ to its workspace dependencies.
function workspaceDeps(repoRoot) {
  const out = {};
  const dir = join(repoRoot, "packages");
  if (!existsSync(dir)) return out;
  for (const d of readdirSync(dir)) {
    const pj = join(dir, d, "package.json");
    if (!existsSync(pj)) continue;
    const doc = JSON.parse(readFileSync(pj, "utf8"));
    const deps = { ...(doc.dependencies ?? {}), ...(doc.devDependencies ?? {}) };
    out[doc.name] = Object.keys(deps).filter((k) => String(deps[k]).startsWith("workspace:"));
  }
  return out;
}

// builtBy returns the set of packages a "pnpm ... build" line builds ("*" for
// every package), or null when the line is not a build. "X..." is X plus all
// its workspace dependencies, as pnpm reads it.
export function builtBy(line, deps) {
  const words = String(line)
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^["']|["']$/g, ""));
  if (words[0] !== "pnpm" || words.at(-1) !== "build") return null;
  const filters = [];
  for (let i = 1; i < words.length - 1; i++) {
    if (words[i] === "--filter" || words[i] === "-F") filters.push(words[++i]);
    else if (words[i].startsWith("--filter=")) filters.push(words[i].slice(9));
    else return null;
  }
  if (filters.length === 0) return new Set(["*"]);
  const out = new Set();
  const add = (name, deep) => {
    if (out.has(name) && !deep) return;
    out.add(name);
    if (deep) for (const d of deps[name] ?? []) if (!out.has(d)) add(d, true);
  };
  for (const f of filters) add(f.replace(/\.\.\.$/, ""), f.endsWith("..."));
  return out;
}

function ruleKind(rule) {
  if (!isObj(rule) || rule.when !== "never" || Object.keys(rule).length !== 2) return null;
  for (const [label, cond] of Object.entries(REFUSING)) if (rule.if === cond) return label;
  return null;
}

export function checkPipeline(doc, repoRoot = repoRootDefault) {
  const errors = [];
  const fail = (job, reason) => errors.push(job ? `${job}: ${reason}` : reason);

  for (const stage of STAGES) if (!asList(doc.stages).includes(stage)) fail("stages", `missing ${stage}`);
  if (!asList(doc.workflow?.rules).length) fail("workflow", "no rules (a push with an open merge request would start two pipelines)");

  const names = jobNames(doc);
  const resolved = Object.fromEntries(names.map((n) => [n, resolveJob(doc, n)]));
  for (const [name, stage] of Object.entries(JOBS)) {
    const job = resolved[name];
    if (!job) {
      fail(name, "job is missing");
      continue;
    }
    if (job.stage !== stage) fail(name, `stage must be ${stage}`);
  }

  const deps = workspaceDeps(repoRoot);
  const imageSources = [["default", doc.default]];
  const caches = [["default", doc.default?.cache]];
  const plainVars = [["variables", doc.variables]];

  for (const name of names) {
    const job = resolved[name];
    if (!job.timeout) fail(name, "no timeout");
    imageSources.push([name, job]);
    caches.push([name, job.cache]);
    plainVars.push([name, job.variables]);

    const lines = scriptLines(job);

    for (const line of lines) {
      for (const cmd of FORBIDDEN_GIT) {
        if (new RegExp(`(^|[\\s;&|(])git\\s+${cmd}(\\s|$)`).test(line)) fail(name, `runs git ${cmd}`);
      }
      const re = /(?:^|[\s"'=(])((?:\.\/)?scripts\/[A-Za-z0-9_./-]+\.(?:sh|mjs))/g;
      for (const m of line.matchAll(re)) {
        const rel = m[1].replace(/^\.\//, "");
        if (!existsSync(join(repoRoot, rel))) fail(name, `${rel} does not exist`);
        else if (rel.endsWith(".sh") && trackedMode(repoRoot, rel) !== "100755") fail(name, `${rel} is not committed as executable`);
      }
    }
    const vars = job.variables ?? {};
    if (String(vars.GIT_STRATEGY) === "none") fail(name, "sets GIT_STRATEGY: none");
    if (String(vars.GIT_CLEAN_FLAGS) === "none") fail(name, "sets GIT_CLEAN_FLAGS: none");

    if (ALLOW_FAILURE.includes(name) && job.allow_failure !== true) {
      fail(name, "allow_failure must be true (points-to-improve-or-fix.md)");
    }

    if (!ALLOW_FAILURE.includes(name) && job.allow_failure !== undefined && job.allow_failure !== false) {
      fail(name, "allow_failure is only allowed on lint");
    }
    for (const r of asList(job.rules)) {
      if (isObj(r) && r.allow_failure !== undefined && !(["kubernetes", "cloudrun"].includes(name) && r.when === "manual")) {
        fail(name, "a rule sets allow_failure; only the manual rule of kubernetes and cloudrun may");
      }
    }
    if ((name === "kubernetes" || name === "cloudrun") && isObj(job.artifacts)) {
      if (job.artifacts.access !== "developer") fail(name, "artifacts must set access: developer");
      if (!job.artifacts.expire_in) fail(name, "artifacts need expire_in");
    }
    if (name === "kubernetes" || name === "cloudrun") {
      const dind = asList(job.services).find((e) => /docker:[^/\s]*-dind/.test(imageName(e)));
      if (dind && !asList(dind.command).includes("--tls=false")) fail(name, "dind service lacks --tls=false");
      if (dind && dind.alias !== "docker") fail(name, "dind service alias must be docker");
      if (vars.DOCKER_TLS_CERTDIR !== "") fail(name, 'DOCKER_TLS_CERTDIR must be ""');
      if (vars.DOCKER_HOST !== "tcp://docker:2375") fail(name, "DOCKER_HOST must be tcp://docker:2375");
    }

    if (JSON.stringify(job).includes("NBO_CI_GCP_KEY")) {
      const rules = asList(job.rules);
      const firstRunning = rules.findIndex((r) => r?.when !== "never");
      for (const label of ["merge_request", "CI_COMMIT_REF_PROTECTED", "NBO_CI_GCP_KEY"]) {
        const idx = rules.findIndex((r) => ruleKind(r) === label);
        if (idx < 0) fail(name, `missing ${label} rule`);
        else if (firstRunning >= 0 && idx > firstRunning) {
          const kind = rules[firstRunning].when === "manual" ? "manual" : "running";
          fail(name, `${kind} rule before ${label} never rule`);
        }
      }
      if (!job.resource_group) fail(name, "no resource_group");
      const running = rules.filter((r) => r?.when !== "never");
      const wantRunning = JSON.stringify(RUNNING[name] ?? []);
      if (JSON.stringify(running) !== wantRunning) fail(name, `running rules must be exactly ${wantRunning}`);
      if (asList(job.cache).length) fail(name, "holds the Google key but uses a cache (another job could have written it)");
      for (const [v, want] of [
        ["NBO_GCP_PROJECT", "$NBO_CI_GCP_PROJECT"],
        ["NBO_GCP_REGION", "$NBO_CI_GCP_REGION"],
        ["NBO_AR_REPO", "$NBO_CI_AR_REPO"],
      ]) {
        if (vars[v] !== want) fail(name, `${v} must be ${want}`);
      }
    }

    if (name === "cloudrun" && !asList(job.after_script).some((l) => String(l).includes("cloudrun-cleanup.sh"))) {
      fail(name, "after_script lacks cloudrun-cleanup.sh");
    }

    if (name === "kubernetes" || name === "cloudrun") {
      const script = asList(job.script).map(String);
      if (script.at(-1)?.trim() !== HARNESS_LAST) fail(name, `last script line must be ${HARNESS_LAST}`);
      if (!lines.some((l) => l.includes("pipefail"))) fail(name, "script lacks set -o pipefail");
      if (!lines.some((l) => /tee\s+harness\.log/.test(l))) fail(name, "script does not tee the harness output to harness.log");
    }

    if (name.startsWith("determinism-") && vars.NBO_BUILD_ID !== "$CI_COMMIT_SHA") {
      fail(name, "NBO_BUILD_ID must be $CI_COMMIT_SHA");
    }

    // A fresh clone has no dist/: the packages the scripts import (the
    // producers' @nbo/writer, the CLI) must be built before the first script.
    if (name.startsWith("determinism-")) {
      const script = asList(job.script).map(String);
      const first = script.findIndex((l) => /scripts\//.test(l));
      const before = first < 0 ? script : script.slice(0, first);
      const covered = before.some((l) => {
        const built = builtBy(l, deps);
        return built && (built.has("*") || built.has("@nbo/writer"));
      });
      if (!covered) fail(name, "no build step covering @nbo/writer before its scripts");
    }

    // install-tools.sh writes .ci-tools/env.sh; a later step that does not
    // source it has no gcloud SDK bin (docker-credential-gcloud) on PATH.
    const before = asList(job.before_script).map(String);
    const installAt = before.findIndex((l) => l.includes("scripts/ci/install-tools.sh"));
    if (installAt >= 0) {
      if (!before.slice(installAt + 1).some((l) => /^\.\s+\.ci-tools\/env\.sh$/.test(l.trim()))) {
        fail(name, "does not source .ci-tools/env.sh after install-tools.sh");
      }
      const after = asList(job.after_script).map(String);
      if (after.length && !after.some((l) => /^\.\s+\.ci-tools\/env\.sh$/.test(l.trim()))) {
        fail(name, "after_script does not source .ci-tools/env.sh");
      }
    }

    if (name === "kubernetes") {
      const services = asList(job.services).map(imageName);
      if (!services.some((s) => /docker:[^/\s]*-dind/.test(s))) fail(name, "missing docker dind service");
      if (!vars.DOCKER_HOST) fail(name, "missing DOCKER_HOST");
      if (String(vars.NBO_CI_DIND) !== "1") fail(name, 'NBO_CI_DIND must be "1"');
      if (vars.NBO_KIND_CONFIG !== "scripts/ci/kind-config.yaml") fail(name, "NBO_KIND_CONFIG must be scripts/ci/kind-config.yaml");
      if (vars.NBO_KIND_CLUSTER !== "nbo-local") {
        fail(name, "NBO_KIND_CLUSTER must be nbo-local (the cluster bootstrap-local-k8s.sh makes in dind)");
      }
      const kind = join(repoRoot, "scripts", "ci", "kind-config.yaml");
      if (!existsSync(kind) || !readFileSync(kind, "utf8").includes("kindest/node:v1.31.4")) {
        fail(name, "scripts/ci/kind-config.yaml does not pin kindest/node:v1.31.4");
      }
      const last = asList(job.rules).at(-1);
      if (last?.when === "manual" && last.allow_failure !== true) fail(name, "the manual rule must set allow_failure: true");
    }
  }

  // determinism-next builds twice against its own .next/cache; sharing the key
  // with another job would let that job's builds feed it.
  const nextKey = (job) => asList(job?.cache).find((c) => isObj(c) && asList(c.paths).some((p) => String(p).includes(".next/cache")))?.key;
  const ownKey = nextKey(resolved["determinism-next"]);
  if (ownKey !== undefined) {
    for (const other of names) {
      if (other === "determinism-next") continue;
      const k = nextKey(resolved[other]);
      if (k !== undefined && JSON.stringify(k) === JSON.stringify(ownKey)) fail("determinism-next", `shares its .next/cache key with ${other}`);
    }
  }

  // Images and services: an exact version tag.
  for (const [name, src] of imageSources) {
    if (!src) continue;
    const entries = [src.image, ...asList(src.services)].filter((e) => e !== undefined);
    for (const e of entries) {
      const img = imageName(e);
      if (img && !hasExactVersion(img)) fail(name, `image ${img.slice(img.lastIndexOf("/") + 1)} has no exact version`);
    }
  }

  // Caches: a key; the pnpm store keyed on pnpm-lock.yaml.
  for (const [name, cache] of caches) {
    for (const c of asList(cache)) {
      if (!isObj(c)) continue;
      const paths = asList(c.paths).map(String);
      if (c.key === undefined || c.key === null || c.key === "") fail(name, `cache ${paths[0] ?? "?"} has no key`);
      if (paths.includes(".pnpm-store")) {
        const files = isObj(c.key) ? asList(c.key.files) : [];
        if (!files.includes("pnpm-lock.yaml")) fail("cache pnpm", "not keyed on pnpm-lock.yaml");
      }
    }
  }

  // No secrets in plain variables: a secret-looking name may only reference another variable.
  for (const [name, vars] of plainVars) {
    if (!isObj(vars)) continue;
    for (const [k, v] of Object.entries(vars)) {
      if (!SECRET_NAME.test(k)) continue;
      const value = String(isObj(v) ? (v.value ?? "") : v);
      if (value !== "" && !value.startsWith("$")) fail(name === "variables" ? "" : name, `variable ${k} holds a literal secret`);
    }
  }

  return [...new Set(errors)];
}

function loadYaml(root) {
  try {
    return createRequire(join(root, "packages", "controlplane", "package.json"))("yaml");
  } catch (err) {
    console.error(`cannot resolve yaml from packages/controlplane: ${err.message}`);
    process.exit(1);
  }
}

function main(argv) {
  let file = join(repoRootDefault, ".gitlab-ci.yml");
  let printJob = null;
  let remote = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") file = resolve(argv[++i] ?? "");
    else if (argv[i] === "--print-job") printJob = argv[++i];
    else if (argv[i] === "--remote") remote = true;
    else {
      console.error("usage: check-pipeline.mjs [--file <path>] [--print-job <name>] [--remote]");
      return 2;
    }
  }
  if (!existsSync(file)) {
    console.error(`${file} does not exist`);
    return 1;
  }
  const YAML = loadYaml(repoRootDefault);
  const doc = YAML.parse(readFileSync(file, "utf8"));

  if (printJob !== null) {
    const job = resolveJob(doc, printJob);
    if (!job || job.script === undefined) {
      console.error(`${printJob}: job is missing`);
      return 1;
    }
    for (const line of [...asList(job.before_script), ...asList(job.script)]) console.log(String(line));
    return 0;
  }

  const errors = checkPipeline(doc, repoRootDefault);
  if (errors.length) {
    for (const e of errors) console.error(e);
    return 1;
  }
  if (remote) {
    const r = spawnSync("glab", ["ci", "lint", file], { stdio: "inherit" });
    if (r.error) console.error("glab not available, skipping the remote lint");
    else if (r.status !== 0) return r.status ?? 1;
  }
  console.log(`pipeline ok (${jobNames(doc).length} jobs)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
