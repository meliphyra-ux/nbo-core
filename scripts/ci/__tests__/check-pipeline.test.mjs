// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "./helpers.mjs";
import { checkPipeline } from "../check-pipeline.mjs";

const req = createRequire(join(repoRoot, "packages", "controlplane", "package.json"));
const YAML = req("yaml");
const ymlPath = join(repoRoot, ".gitlab-ci.yml");
const load = () => YAML.parse(readFileSync(ymlPath, "utf8"));

// A mutated copy of the real pipeline: mutate(doc) edits it in place.
function check(mutate) {
  const doc = load();
  mutate?.(doc);
  return checkPipeline(doc, repoRoot);
}
function expectFailure(mutate, reason) {
  const errors = check(mutate);
  assert.ok(errors.includes(reason), `expected "${reason}" in ${JSON.stringify(errors)}`);
}

const run = (args) =>
  spawnSync(process.execPath, [join(repoRoot, "scripts", "ci", "check-pipeline.mjs"), ...args], {
    encoding: "utf8",
    cwd: repoRoot,
  });

test("the real .gitlab-ci.yml passes", () => {
  assert.deepEqual(check(), []);
});

test("the real file's structure: stages, jobs, timeouts", () => {
  const doc = load();
  assert.deepEqual(doc.stages, ["check", "determinism", "targets"]);
  const jobs = Object.keys(doc).filter((k) => !k.startsWith(".") && doc[k] && typeof doc[k] === "object" && doc[k].stage);
  for (const name of [
    "node-checks",
    "lint",
    "terraform-provider",
    "rust",
    "edge-rust-blackbox",
    "determinism-static",
    "determinism-next",
    "kubernetes",
    "cloudrun",
    "cloudrun-janitor",
  ]) {
    assert.ok(jobs.includes(name), `job ${name}`);
    assert.ok(doc[name].timeout, `${name} has a timeout`);
  }
});

test("lint is allowed to fail, with a comment explaining why; determinism-next is strict", () => {
  const doc = load();
  assert.equal(doc.lint.allow_failure, true);
  assert.equal(doc["determinism-next"].allow_failure, undefined);
  const text = readFileSync(ymlPath, "utf8");
  assert.match(text, /points-to-improve-or-fix\.md/);
});

test("no secrets in plain variables of the real file", () => {
  const text = readFileSync(ymlPath, "utf8");
  assert.ok(!/-----BEGIN/.test(text));
  const doc = load();
  for (const [name, job] of Object.entries(doc)) {
    if (!job || typeof job !== "object" || Array.isArray(job)) continue;
    for (const [k, v] of Object.entries(job.variables ?? {})) {
      if (/KEY|SECRET|TOKEN|PASSWORD/i.test(k)) assert.match(String(v), /^\$/, `${name}.${k}`);
    }
  }
});

test("cloudrun: manual rule before merge_request never rule", () => {
  expectFailure((doc) => {
    const rules = doc.cloudrun.rules;
    rules.unshift({ if: '$CI_PIPELINE_SOURCE == "web"', when: "manual" });
  }, "cloudrun: manual rule before merge_request never rule");
});

test("cloudrun: missing CI_COMMIT_REF_PROTECTED rule", () => {
  expectFailure((doc) => {
    doc.cloudrun.rules = doc.cloudrun.rules.filter((r) => !/CI_COMMIT_REF_PROTECTED/.test(r.if ?? ""));
  }, "cloudrun: missing CI_COMMIT_REF_PROTECTED rule");
});

test("cloudrun: missing NBO_CI_GCP_KEY rule", () => {
  expectFailure((doc) => {
    doc.cloudrun.rules = doc.cloudrun.rules.filter((r) => !/NBO_CI_GCP_KEY/.test(r.if ?? ""));
  }, "cloudrun: missing NBO_CI_GCP_KEY rule");
});

test("cloudrun-janitor: a job that uses the key needs the refusing rules too", () => {
  expectFailure((doc) => {
    doc["cloudrun-janitor"].rules = [{ if: '$CI_PIPELINE_SOURCE == "schedule"' }];
  }, "cloudrun-janitor: missing merge_request rule");
});

test("cloudrun: missing resource_group", () => {
  expectFailure((doc) => {
    delete doc.cloudrun.resource_group;
  }, "cloudrun: no resource_group");
});

test("cloudrun: after_script lacks cloudrun-cleanup.sh", () => {
  expectFailure((doc) => {
    doc.cloudrun.after_script = ["echo done"];
  }, "cloudrun: after_script lacks cloudrun-cleanup.sh");
});

test("kubernetes: image node:24 has no exact version", () => {
  expectFailure((doc) => {
    doc.kubernetes.image = "${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}/node:24";
  }, "kubernetes: image node:24 has no exact version");
  expectFailure((doc) => {
    doc.kubernetes.image = "node";
  }, "kubernetes: image node has no exact version");
  expectFailure((doc) => {
    doc.kubernetes.image = "node:latest";
  }, "kubernetes: image node:latest has no exact version");
});

test("a service without an exact version fails too", () => {
  expectFailure((doc) => {
    doc.kubernetes.services[0].name = "docker:dind";
  }, "kubernetes: image docker:dind has no exact version");
});

test("the dependency proxy prefix and a bare exact image are both accepted", () => {
  assert.deepEqual(
    check((doc) => {
      doc.kubernetes.image = "node:24.11.1-bookworm";
    }),
    [],
  );
  assert.match(load()[".node"].image, /^\$\{CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX\}\/node:24\.11\.1-bookworm$/);
});

test("kubernetes: missing docker dind service", () => {
  expectFailure((doc) => {
    delete doc.kubernetes.services;
  }, "kubernetes: missing docker dind service");
});

test("kubernetes: missing DOCKER_HOST, NBO_CI_DIND, NBO_KIND_CONFIG", () => {
  expectFailure((doc) => {
    delete doc.kubernetes.variables.DOCKER_HOST;
  }, "kubernetes: missing DOCKER_HOST");
  expectFailure((doc) => {
    doc.kubernetes.variables.NBO_CI_DIND = "0";
  }, 'kubernetes: NBO_CI_DIND must be "1"');
  expectFailure((doc) => {
    delete doc.kubernetes.variables.NBO_KIND_CONFIG;
  }, "kubernetes: NBO_KIND_CONFIG must be scripts/ci/kind-config.yaml");
});

test("kubernetes: allowed to fail only when manual (the last rule)", () => {
  expectFailure((doc) => {
    const last = doc.kubernetes.rules.at(-1);
    delete last.allow_failure;
  }, "kubernetes: the manual rule must set allow_failure: true");
});

test("node-checks: runs git commit (and the other forbidden git commands)", () => {
  expectFailure((doc) => {
    doc["node-checks"].script.push("git commit -am x");
  }, "node-checks: runs git commit");
  expectFailure((doc) => {
    doc["node-checks"].before_script = ["git stash"];
  }, "node-checks: runs git stash");
  expectFailure((doc) => {
    doc.kubernetes.after_script = ["cd x && git clean -fdx"];
  }, "kubernetes: runs git clean");
});

test("GIT_STRATEGY none and GIT_CLEAN_FLAGS none are refused", () => {
  expectFailure((doc) => {
    doc.kubernetes.variables.GIT_STRATEGY = "none";
  }, "kubernetes: sets GIT_STRATEGY: none");
  expectFailure((doc) => {
    doc.kubernetes.variables.GIT_CLEAN_FLAGS = "none";
  }, "kubernetes: sets GIT_CLEAN_FLAGS: none");
});

test("kubernetes: scripts/ci/missing.sh does not exist", () => {
  expectFailure((doc) => {
    doc.kubernetes.script.push("bash scripts/ci/missing.sh");
  }, "kubernetes: scripts/ci/missing.sh does not exist");
});

test("a script that exists but is not committed as executable is refused", () => {
  expectFailure((doc) => {
    // tracked as 100644
    doc.kubernetes.script.push("bash scripts/lib-isr-checks.sh");
  }, "kubernetes: scripts/lib-isr-checks.sh is not committed as executable");
});

test("node-checks: no timeout", () => {
  expectFailure((doc) => {
    delete doc["node-checks"].timeout;
  }, "node-checks: no timeout");
});

test("a missing job and a missing stage are named", () => {
  expectFailure((doc) => {
    delete doc.cloudrun;
  }, "cloudrun: job is missing");
  expectFailure((doc) => {
    doc.stages = ["check", "targets"];
  }, "stages: missing determinism");
});

test("a job in the wrong stage is named", () => {
  expectFailure((doc) => {
    doc.kubernetes.stage = "check";
  }, "kubernetes: stage must be targets");
});

test("lint loses allow_failure: named", () => {
  expectFailure((doc) => {
    delete doc.lint.allow_failure;
  }, "lint: allow_failure must be true (points-to-improve-or-fix.md)");
});

test("cache pnpm: not keyed on pnpm-lock.yaml", () => {
  expectFailure((doc) => {
    const c = doc["node-checks"].cache.find((x) => x.paths.includes(".pnpm-store"));
    c.key = "static";
  }, "cache pnpm: not keyed on pnpm-lock.yaml");
});

test("a cache without a key is named", () => {
  expectFailure((doc) => {
    const c = doc["node-checks"].cache.find((x) => x.paths.includes(".turbo/cache"));
    delete c.key;
  }, "node-checks: cache .turbo/cache has no key");
});

test("a secret in plain variables is refused", () => {
  expectFailure((doc) => {
    doc.cloudrun.variables = { ...(doc.cloudrun.variables ?? {}), NBO_CI_GCP_KEY: '{"private_key":"x"}' };
  }, "cloudrun: variable NBO_CI_GCP_KEY holds a literal secret");
  expectFailure((doc) => {
    doc.kubernetes.variables.SOME_TOKEN = "abc123";
  }, "kubernetes: variable SOME_TOKEN holds a literal secret");
});

test("kubernetes and cloudrun scripts end by checking the harness line", () => {
  expectFailure((doc) => {
    doc.kubernetes.script.pop();
  }, 'kubernetes: last script line must be grep -q "all checks passed" harness.log');
  expectFailure((doc) => {
    doc.cloudrun.script.pop();
  }, 'cloudrun: last script line must be grep -q "all checks passed" harness.log');
});

test("determinism jobs set NBO_BUILD_ID to the commit", () => {
  expectFailure((doc) => {
    delete doc["determinism-next"].variables.NBO_BUILD_ID;
  }, "determinism-next: NBO_BUILD_ID must be $CI_COMMIT_SHA");
});

test("scripts/ci/kind-config.yaml must pin the node image", () => {
  // The checker reads the real file; assert the real one satisfies it.
  assert.match(readFileSync(join(repoRoot, "scripts", "ci", "kind-config.yaml"), "utf8"), /kindest\/node:v1\.31\.4/);
});

test("CLI: prints 'pipeline ok (<n> jobs)' on the real file, exit 0", () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^pipeline ok \(10 jobs\)\s*$/);
});

test("CLI: --file on a broken copy lists '<job>: <reason>' and exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "nbo-broken-"));
  try {
    const doc = load();
    delete doc["node-checks"].timeout;
    const file = join(dir, "broken.yml");
    writeFileSync(file, YAML.stringify(doc));
    const r = run(["--file", file]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^node-checks: no timeout$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --print-job kubernetes prints before_script then script, one line each, in order", () => {
  const r = run(["--print-job", "kubernetes"]);
  assert.equal(r.status, 0, r.stderr);
  const doc = load();
  const expected = [...(doc.kubernetes.before_script ?? []), ...doc.kubernetes.script];
  assert.deepEqual(r.stdout.split("\n").filter((l) => l !== ""), expected);
  // dind-forward runs before and after bootstrap-local-k8s.sh
  const forward = expected.map((l, i) => (/dind-forward\.sh/.test(l) ? i : -1)).filter((i) => i >= 0);
  const bootstrap = expected.findIndex((l) => /bootstrap-local-k8s\.sh/.test(l));
  assert.ok(forward.length >= 2);
  assert.ok(forward[0] < bootstrap && forward.at(-1) > bootstrap);
  for (const line of expected) assert.ok(!line.includes("\n"), `single-line command: ${line}`);
});

test("CLI: --print-job with an unknown job exits 1", () => {
  const r = run(["--print-job", "nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nope/);
});

// -- fix round 1: stricter checks ------------------------------------------

test("an inverted or altered never-rule is refused (exact if strings)", () => {
  expectFailure((doc) => {
    const r = doc.cloudrun.rules.find((x) => /CI_COMMIT_REF_PROTECTED/.test(x.if ?? ""));
    r.if = '$CI_COMMIT_REF_PROTECTED == "true"';
  }, "cloudrun: missing CI_COMMIT_REF_PROTECTED rule");
  expectFailure((doc) => {
    const r = doc.cloudrun.rules.find((x) => /merge_request_event/.test(x.if ?? ""));
    r.if = '$CI_PIPELINE_SOURCE != "merge_request_event"';
  }, "cloudrun: missing merge_request rule");
  expectFailure((doc) => {
    const r = doc["cloudrun-janitor"].rules.find((x) => /NBO_CI_GCP_KEY/.test(x.if ?? ""));
    r.if = '$NBO_CI_GCP_KEY == "" && $CI_COMMIT_BRANCH == "never-matches"';
  }, "cloudrun-janitor: missing NBO_CI_GCP_KEY rule");
  expectFailure((doc) => {
    const r = doc.cloudrun.rules.find((x) => /merge_request_event/.test(x.if ?? ""));
    r.when = "on_success";
  }, "cloudrun: missing merge_request rule");
});

test("an extra running rule on a key-holding job is refused", () => {
  const errs = check((doc) => {
    doc.cloudrun.rules.push({ if: '$CI_COMMIT_BRANCH == "main"' });
  });
  assert.ok(errs.some((e) => e.startsWith("cloudrun: running rules must be exactly")), JSON.stringify(errs));
});

test("key-holding jobs must not use a cache", () => {
  const reason = "holds the Google key but uses a cache (another job could have written it)";
  expectFailure((doc) => {
    doc.cloudrun.cache = [{ key: "x", paths: [".ci-tools"] }];
  }, `cloudrun: ${reason}`);
  expectFailure((doc) => {
    doc["cloudrun-janitor"].cache = [{ key: "x", paths: [".ci-tools"] }];
  }, `cloudrun-janitor: ${reason}`);
});

test("allow_failure is refused on every job but lint", () => {
  for (const job of ["node-checks", "determinism-static", "determinism-next", "terraform-provider", "rust", "kubernetes", "cloudrun"]) {
    expectFailure((doc) => {
      doc[job].allow_failure = true;
    }, `${job}: allow_failure is only allowed on lint`);
  }
  assert.ok(
    check((doc) => {
      doc["node-checks"].rules = [{ when: "always", allow_failure: true }];
    }).includes("node-checks: a rule sets allow_failure; only the manual rule of kubernetes and cloudrun may"),
  );
});

test("floating patch versions are refused: node:24.11 and rust:1.96-bookworm", () => {
  expectFailure((doc) => {
    doc.kubernetes.image = "node:24.11";
  }, "kubernetes: image node:24.11 has no exact version");
  expectFailure((doc) => {
    doc.rust.image = "rust:1.96-bookworm";
  }, "rust: image rust:1.96-bookworm has no exact version");
});

test("dind service flags and variables are enforced", () => {
  expectFailure((doc) => {
    doc.kubernetes.services[0].command = [];
  }, "kubernetes: dind service lacks --tls=false");
  expectFailure((doc) => {
    doc.cloudrun.services[0].command = ["--tls=true"];
  }, "cloudrun: dind service lacks --tls=false");
  expectFailure((doc) => {
    doc.kubernetes.variables.DOCKER_TLS_CERTDIR = "/certs";
  }, 'kubernetes: DOCKER_TLS_CERTDIR must be ""');
  expectFailure((doc) => {
    doc.kubernetes.services[0].alias = "dind";
  }, "kubernetes: dind service alias must be docker");
});

test("NBO_GCP_PROJECT must map to $NBO_CI_GCP_PROJECT on key-holding jobs", () => {
  expectFailure((doc) => {
    doc.cloudrun.variables.NBO_GCP_PROJECT = "my-real-project";
  }, "cloudrun: NBO_GCP_PROJECT must be $NBO_CI_GCP_PROJECT");
  expectFailure((doc) => {
    delete doc["cloudrun-janitor"].variables.NBO_AR_REPO;
  }, "cloudrun-janitor: NBO_AR_REPO must be $NBO_CI_AR_REPO");
});

test("log artifacts: developer access and an expiry", () => {
  expectFailure((doc) => {
    delete doc.kubernetes.artifacts.access;
  }, "kubernetes: artifacts must set access: developer");
  expectFailure((doc) => {
    delete doc.cloudrun.artifacts.expire_in;
  }, "cloudrun: artifacts need expire_in");
});

test("the checker fails when kind-config.yaml does not pin the node image", () => {
  const dir = mkdtempSync(join(tmpdir(), "nbo-kind-"));
  try {
    mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
    writeFileSync(join(dir, "scripts", "ci", "kind-config.yaml"), "kind: Cluster\n");
    const errors = checkPipeline(load(), dir);
    assert.ok(errors.includes("kubernetes: scripts/ci/kind-config.yaml does not pin kindest/node:v1.31.4"), JSON.stringify(errors));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- final fix pass ----------------------------------------------------------

test("determinism jobs build what they need in a fresh clone, @nbo/writer included", () => {
  for (const job of ["determinism-static", "determinism-next"]) {
    expectFailure((doc) => {
      doc[job].script = doc[job].script.filter((l) => !/\bbuild\b/.test(l) || /scripts\//.test(l));
    }, `${job}: no build step covering @nbo/writer before its scripts`);
    expectFailure((doc) => {
      doc[job].script = ['pnpm --filter "@nbo/digest..." build', ...doc[job].script.filter((l) => /scripts\//.test(l))];
    }, `${job}: no build step covering @nbo/writer before its scripts`);
    assert.deepEqual(
      check((doc) => {
        doc[job].script = ["pnpm build", ...doc[job].script.filter((l) => /scripts\//.test(l))];
      }),
      [],
    );
  }
});

test("a build step after the script does not count", () => {
  expectFailure((doc) => {
    const s = doc["determinism-next"].script;
    doc["determinism-next"].script = [...s.filter((l) => /scripts\//.test(l)), ...s.filter((l) => !/scripts\//.test(l))];
  }, "determinism-next: no build step covering @nbo/writer before its scripts");
});

test("determinism-next keeps its .next cache to itself", () => {
  const doc = load();
  const key = (job) => doc[job].cache.find((c) => c.paths.some((p) => p.includes(".next/cache"))).key;
  assert.notEqual(key("determinism-next"), key("kubernetes"));
  expectFailure((d) => {
    d["determinism-next"].cache.find((c) => c.paths.some((p) => p.includes(".next/cache"))).key = key("kubernetes");
  }, "determinism-next: shares its .next/cache key with kubernetes");
});

test("jobs that install the CI tools source .ci-tools/env.sh after it", () => {
  for (const job of ["kubernetes", "cloudrun", "cloudrun-janitor"]) {
    expectFailure((doc) => {
      doc[job].before_script = doc[job].before_script.filter((l) => !l.includes(".ci-tools/env.sh"));
    }, `${job}: does not source .ci-tools/env.sh after install-tools.sh`);
  }
  expectFailure((doc) => {
    doc.cloudrun.after_script = doc.cloudrun.after_script.filter((l) => !l.includes(".ci-tools/env.sh"));
  }, "cloudrun: after_script does not source .ci-tools/env.sh");
});

test("the kubernetes job names the kind cluster for kind load", () => {
  expectFailure((doc) => {
    delete doc.kubernetes.variables.NBO_KIND_CLUSTER;
  }, "kubernetes: NBO_KIND_CLUSTER must be nbo-local (the cluster bootstrap-local-k8s.sh makes in dind)");
});

test("verify-step0.sh builds @nbo/writer itself, so it works in a fresh clone outside CI too", async () => {
  const { builtBy } = await import("../check-pipeline.mjs");
  const deps = {};
  for (const d of readdirSync(join(repoRoot, "packages"))) {
    try {
      const pj = JSON.parse(readFileSync(join(repoRoot, "packages", d, "package.json"), "utf8"));
      const all = { ...(pj.dependencies ?? {}), ...(pj.devDependencies ?? {}) };
      deps[pj.name] = Object.keys(all).filter((k) => String(all[k]).startsWith("workspace:"));
    } catch {
      // not a package
    }
  }
  const lines = readFileSync(join(repoRoot, "scripts", "verify-step0.sh"), "utf8").split("\n");
  const builds = lines.map((l) => builtBy(l, deps)).filter(Boolean);
  assert.ok(builds.length > 0, "verify-step0.sh has a pnpm build line");
  // the producer it runs and the producer's own @nbo/writer, not only what @nbo/cli happens to pull in
  assert.ok(
    builds.some((b) => b.has("*") || (b.has("@nbo/producer-static") && b.has("@nbo/writer"))),
    JSON.stringify(builds.map((b) => [...b])),
  );
  // builtBy itself: X... pulls in dependencies, X alone does not
  assert.ok(builtBy('pnpm --filter "@nbo/producer-static..." build', deps).has("@nbo/writer"));
  assert.ok(!builtBy('pnpm --filter "@nbo/producer-static" build', deps).has("@nbo/writer"));
  assert.equal(builtBy("pnpm test", deps), null);
});
