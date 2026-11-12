// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathWith, repoRoot, runBash, withFakeTools } from "./helpers.mjs";

const harness = "scripts/ci/next-harness.sh";
const fwd = (p) => p.split(String.fromCharCode(92)).join("/");
let work;

before(() => {
  work = mkdtempSync(join(tmpdir(), "nbo-harness-"));
});
after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

const cloudEnv = {
  NBO_GCP_PROJECT: "p",
  NBO_GCP_REGION: "r",
  NBO_AR_REPO: "r-docker.pkg.dev/p/nbo-ci",
};
const noCloudEnv = { NBO_GCP_PROJECT: "", NBO_GCP_REGION: "", NBO_AR_REPO: "" };

test("an unknown target exits 2 with usage", () => {
  const r = runBash(harness, ["bogus"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: next-harness\.sh <serve\|kubernetes\|cloudrun>/);
  assert.equal(runBash(harness, []).code, 2);
});

for (const name of ["NBO_GCP_PROJECT", "NBO_GCP_REGION", "NBO_AR_REPO"]) {
  test(`cloudrun without ${name} exits 1 naming it`, () => {
    const r = runBash(harness, ["cloudrun"], { ...cloudEnv, [name]: "" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(name));
  });
}

test("cloudrun refuses a prefix that does not start with ci-", () => {
  const r = runBash(harness, ["cloudrun"], { ...cloudEnv, NBO_CI_APP_PREFIX: "prod-" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /prefix must start with ci-/);
});

test("a suite directory with no transcripts fails before anything is built", () => {
  const root = join(work, "conf");
  cpSync(join(repoRoot, "fixtures", "conformance"), root, { recursive: true });
  rmSync(join(root, "slice4-middleware"), { recursive: true });
  mkdirSync(join(root, "slice4-middleware"));
  writeFileSync(join(root, "slice4-middleware", "README.txt"), "no transcripts here");
  const fake = withFakeTools(["pnpm", "node"]);
  try {
    const r = runBash(harness, ["serve"], { PATH: pathWith(fake.binDir), NBO_CONFORMANCE_ROOT: fwd(root) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no transcripts in .*slice4-middleware/);
    assert.deepEqual(fake.readLog(), [], "nothing was built or run");
  } finally {
    fake.cleanup();
  }
});

// A fake CLI whose deploy says "already live" only when .nbo was deployed
// before (state kept in a file per app).
function fakeCli(dir, { noop }) {
  const state = fwd(join(dir, "state"));
  const file = join(dir, "fake-nbo");
  writeFileSync(
    file,
    [
      "#!/usr/bin/env bash",
      `echo "$*" >> "${fwd(join(dir, "nbo.log"))}"`,
      `echo "$1 NBO_KIND_CLUSTER=\${NBO_KIND_CLUSTER:-}" >> "${fwd(join(dir, "env.log"))}"`,
      'if [ "$1" = deploy ]; then',
      `  mkdir -p "${state}"; app=""`,
      '  while [ "$#" -gt 0 ]; do [ "$1" = --app ] && app="$2"; shift; done',
      `  if [ -e "${state}/$app" ] && [ "${noop ? 1 : 0}" = 1 ]; then echo "already live"; else echo "deployed"; fi`,
      `  touch "${state}/$app"`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return fwd(file);
}

// Fake kubectl (context, pinned config, the deployment list, rollout status)
// and curl (prints the status code); `rollout` and `curl` are bash snippets.
const DEPLOYMENTS = [
  "deployment.apps/next-app",
  "deployment.apps/next-app-fn-ssr",
  "deployment.apps/next-app-fn-middleware",
  "deployment.apps/ppr-app",
  "deployment.apps/ppr-app-fn-ssr",
  "deployment.apps/unrelated",
];
const kubectlCtx = (ctx, { rollout = "exit 0", curl = "echo 200" } = {}) => ({
  kubectl: `if [ "$1 $2" = "config current-context" ]; then echo ${ctx}; fi
if [ "$1 $2" = "config view" ]; then echo "pinned-for: ${ctx}"; fi
if [ "$3 $4 $5 $6" = "get deployments -o name" ]; then printf '%s\\n' ${DEPLOYMENTS.join(" ")}; fi
if [ "$3 $4" = "rollout status" ]; then ${rollout}; fi
exit 0`,
  curl,
});

function fixturesWithNbo(dir) {
  for (const f of ["next-app", "ppr-app"]) mkdirSync(join(dir, f, ".nbo"), { recursive: true });
  return fwd(dir);
}

test("kubernetes deploys each fixture twice and fails when the second is not a no-op", () => {
  const dir = mkdtempSync(join(work, "k8s-"));
  const fake = withFakeTools(["kubectl", "pnpm", "curl"], kubectlCtx("kind-nbo-ci"));
  try {
    const r = runBash(harness, ["kubernetes"], {
      PATH: pathWith(fake.binDir),
      NBO_BIN: fakeCli(dir, { noop: false }),
      NBO_FIXTURES_DIR: fixturesWithNbo(join(dir, "fx")),
      NBO_HARNESS_SKIP_BUILD: "1",
      NBO_HARNESS_READY_INTERVAL: "0",
      NBO_HARNESS_READY_TRIES: "2",
      NBO_KIND_CLUSTER: "",
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /expected the second deploy of next-app to print "already live"/);
    const deploys = readFileSync(join(dir, "nbo.log"), "utf8").split("\n").filter((l) => l.startsWith("deploy"));
    assert.equal(deploys.length, 2);
  } finally {
    fake.cleanup();
  }
});

test("kubernetes passes the no-op check when the second deploy says already live", () => {
  const dir = mkdtempSync(join(work, "k8s-ok-"));
  const fake = withFakeTools(["kubectl", "pnpm", "curl"], kubectlCtx("kind-nbo-ci"));
  try {
    const r = runBash(harness, ["kubernetes"], {
      PATH: pathWith(fake.binDir),
      NBO_BIN: fakeCli(dir, { noop: true }),
      NBO_FIXTURES_DIR: fixturesWithNbo(join(dir, "fx")),
      NBO_HARNESS_SKIP_BUILD: "1",
      NBO_HARNESS_READY_INTERVAL: "0",
      NBO_HARNESS_READY_TRIES: "2",
      NBO_KIND_CLUSTER: "",
    });
    // It goes on to the HTTP checks, which have no server here; the no-op check itself passed.
    assert.doesNotMatch(r.stderr, /already live/);
    const deploys = readFileSync(join(dir, "nbo.log"), "utf8").split("\n").filter((l) => l.startsWith("deploy"));
    assert.ok(deploys.length >= 2);
  } finally {
    fake.cleanup();
  }
});

test("cloudrun runs the cleanup script with its prefix even when a deploy fails", () => {
  const dir = mkdtempSync(join(work, "cr-"));
  const cleanupLog = join(dir, "cleanup.log");
  const cleanup = join(dir, "cleanup.sh");
  writeFileSync(cleanup, `#!/usr/bin/env bash\necho "$*" >> "${fwd(cleanupLog)}"\n`);
  chmodSync(cleanup, 0o755);
  const cli = join(dir, "failing-nbo");
  writeFileSync(cli, "#!/usr/bin/env bash\necho boom >&2\nexit 1\n");
  chmodSync(cli, 0o755);
  const fake = withFakeTools(["gcloud", "pnpm"]);
  try {
    const r = runBash(harness, ["cloudrun"], {
      ...cloudEnv,
      PATH: pathWith(fake.binDir),
      NBO_BIN: fwd(cli),
      NBO_FIXTURES_DIR: fixturesWithNbo(join(dir, "fx")),
      NBO_HARNESS_SKIP_BUILD: "1",
      NBO_CLEANUP_SCRIPT: fwd(cleanup),
      NBO_CI_APP_PREFIX: "ci-77-",
    });
    assert.notEqual(r.code, 0);
    assert.equal(readFileSync(cleanupLog, "utf8").trim(), "--prefix ci-77-");
  } finally {
    fake.cleanup();
  }
});

function k8sRun(ctx, extraEnv = {}, { tools = {}, noop = false } = {}) {
  const dir = mkdtempSync(join(work, "k8s-ctx-"));
  const fake = withFakeTools(["kubectl", "pnpm", "curl"], kubectlCtx(ctx, tools));
  const r = runBash(harness, ["kubernetes"], {
    PATH: pathWith(fake.binDir),
    NBO_BIN: fakeCli(dir, { noop }),
    NBO_FIXTURES_DIR: fixturesWithNbo(join(dir, "fx")),
    NBO_HARNESS_SKIP_BUILD: "1",
    NBO_HARNESS_READY_INTERVAL: "0",
    NBO_HARNESS_READY_TRIES: "2",
    NBO_KIND_CLUSTER: "",
    NBO_CI_DIND: "",
    CI: "",
    GITLAB_CI: "",
    NBO_HARNESS_CONTEXT: "",
    ...extraEnv,
  });
  const calls = fake.readLog();
  const deployed = (() => {
    try {
      return readFileSync(join(dir, "nbo.log"), "utf8");
    } catch {
      return "";
    }
  })();
  const envLog = existsSync(join(dir, "env.log")) ? readFileSync(join(dir, "env.log"), "utf8") : "";
  fake.cleanup();
  return { r, calls, deployed, envLog };
}

const isCurl = (c) => c[0] === "-s";
const kubectlCalls = (calls) => calls.filter((c) => !isCurl(c));

test("kubernetes waits for every rollout of the app and then for an HTTP 200 through the ingress before any suite", () => {
  const { r, calls, deployed } = k8sRun("kind-nbo-ci", {}, { noop: true });
  const rollouts = kubectlCalls(calls)
    .filter((c) => c[2] === "rollout")
    .map((c) => c.slice(2).join(" "));
  assert.deepEqual(rollouts.slice(0, 3), [
    "rollout status deployment/next-app --timeout=180s",
    "rollout status deployment/next-app-fn-ssr --timeout=180s",
    "rollout status deployment/next-app-fn-middleware --timeout=180s",
  ]);
  assert.ok(!rollouts.some((x) => x.includes("unrelated")), rollouts.join("\n"));
  const probe = calls.find((c) => isCurl(c) && c.includes("https://next-app.127.0.0.1.sslip.io/api/hello"));
  assert.ok(probe, JSON.stringify(calls));
  assert.ok(probe.includes("--insecure"));
  assert.match(deployed, /conformance/);
  assert.match(r.stdout, /rollout finished: next-app/);
});

test("kubernetes stops with a clear error when the app never answers 200, before any suite", () => {
  const { r, deployed } = k8sRun("kind-nbo-ci", {}, { noop: true, tools: { curl: "echo 503" } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /https:\/\/next-app\.127\.0\.0\.1\.sslip\.io\/api\/hello never became ready after 2 probes \(last status 503\)/);
  assert.doesNotMatch(deployed, /conformance/);
});

test("kubernetes stops when a rollout does not finish, naming the deployment", () => {
  const { r, deployed } = k8sRun("kind-nbo-ci", {}, { noop: true, tools: { rollout: 'case "$5" in *fn-ssr) exit 1;; esac' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /deployment\/next-app-fn-ssr did not finish rolling out/);
  assert.doesNotMatch(deployed, /conformance/);
});

test("kubernetes on kind-nbo-ci tells nbo deploy to kind load into nbo-ci", () => {
  const { envLog } = k8sRun("kind-nbo-ci");
  assert.match(envLog, /^deploy NBO_KIND_CLUSTER=nbo-ci$/m);
});

test("kubernetes refuses when NBO_KIND_CLUSTER names another cluster than the context", () => {
  const { r, deployed } = k8sRun("kind-nbo-ci", { NBO_KIND_CLUSTER: "nbo-local" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /kind load would target cluster nbo-local \(NBO_KIND_CLUSTER\), not nbo-ci/);
  assert.equal(deployed, "");
});

test("kubernetes refuses a context that is not a kind cluster, even when named", () => {
  const { r, deployed } = k8sRun("gke_p_r_c", { NBO_HARNESS_CONTEXT: "gke_p_r_c" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a kind cluster/);
  assert.equal(deployed, "");
});

test("in the CI job, kind-nbo-local with NBO_KIND_CLUSTER=nbo-local is used as is", () => {
  const { r, envLog } = k8sRun("kind-nbo-local", { NBO_CI_DIND: "1", GITLAB_CI: "true", NBO_KIND_CLUSTER: "nbo-local" });
  assert.doesNotMatch(r.stderr, /refusing/);
  assert.match(envLog, /^deploy NBO_KIND_CLUSTER=nbo-local$/m);
});

test("kubernetes refuses the developer's kind-nbo-local and deletes nothing", () => {
  const { r, calls, deployed } = k8sRun("kind-nbo-local");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refusing to run against kube context kind-nbo-local/);
  assert.deepEqual(calls.filter((c) => c[0] === "delete"), []);
  assert.deepEqual(calls.filter((c) => c.includes("delete")), []);
  assert.equal(deployed, "", "no deploy ran");
});

test("kubernetes refuses when kubectl has no current context", () => {
  const { r, deployed } = k8sRun("");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no current kube context/);
  assert.equal(deployed, "");
});

test("kubernetes runs on the CI cluster context and passes --context to every kubectl call", () => {
  const { r, calls, deployed } = k8sRun("kind-nbo-ci");
  assert.doesNotMatch(r.stderr, /refusing to run/);
  assert.match(deployed, /deploy/);
  const deletes = calls.filter((c) => c.includes("delete"));
  assert.ok(deletes.length >= 3, "cleanup ran");
  for (const c of kubectlCalls(calls).filter((x) => x[0] !== "config")) assert.deepEqual(c.slice(0, 2), ["--context", "kind-nbo-ci"], JSON.stringify(c));
});

test("kubernetes accepts kind-nbo-local only inside the CI job (NBO_CI_DIND=1)", () => {
  const { r, deployed } = k8sRun("kind-nbo-local", { NBO_CI_DIND: "1", GITLAB_CI: "true" });
  assert.doesNotMatch(r.stderr, /refusing to run/);
  assert.match(deployed, /deploy/);
});

test("kubernetes accepts a context named by NBO_HARNESS_CONTEXT and refuses a different one", () => {
  const ok = k8sRun("kind-scratch", { NBO_HARNESS_CONTEXT: "kind-scratch" });
  assert.doesNotMatch(ok.r.stderr, /refusing to run/);
  const bad = k8sRun("kind-nbo-local", { NBO_HARNESS_CONTEXT: "kind-scratch" });
  assert.equal(bad.r.code, 1);
  assert.match(bad.r.stderr, /refusing to run/);
});

test("kubernetes refuses kind-nbo-local with NBO_CI_DIND=1 but no CI marker", () => {
  const { r, deployed } = k8sRun("kind-nbo-local", { NBO_CI_DIND: "1" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refusing to run/);
  assert.equal(deployed, "");
});

test("nbo deploy sees a pinned one-context KUBECONFIG, removed on exit", () => {
  const dir = mkdtempSync(join(work, "k8s-pin-"));
  const cli = join(dir, "pin-nbo");
  const kclog = fwd(join(dir, "kc.log"));
  writeFileSync(
    cli,
    [
      "#!/usr/bin/env bash",
      `echo "KUBECONFIG=$KUBECONFIG" >> "${kclog}"`,
      `[ -n "$KUBECONFIG" ] && cat "$KUBECONFIG" >> "${kclog}"`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(cli, 0o755);
  const fake = withFakeTools(["kubectl", "pnpm", "curl"], kubectlCtx("kind-nbo-ci"));
  try {
    const r = runBash(harness, ["kubernetes"], {
      PATH: pathWith(fake.binDir),
      NBO_BIN: fwd(cli),
      NBO_FIXTURES_DIR: fixturesWithNbo(join(dir, "fx")),
      NBO_HARNESS_SKIP_BUILD: "1",
      NBO_HARNESS_READY_INTERVAL: "0",
      NBO_HARNESS_READY_TRIES: "2",
      NBO_KIND_CLUSTER: "",
      KUBECONFIG: "/somewhere/else",
    });
    assert.notEqual(r.code, 0);
    const log = readFileSync(join(dir, "kc.log"), "utf8");
    assert.doesNotMatch(log, /somewhere\/else/);
    assert.match(log, /pinned-for: kind-nbo-ci/);
    const path = /KUBECONFIG=(.+)/.exec(log)[1].trim();
    assert.ok(!existsSync(path), "temp kubeconfig removed");
    assert.ok(fake.readLog().some((c) => c.join(" ") === "config view --minify --flatten --context kind-nbo-ci"));
  } finally {
    fake.cleanup();
  }
});
