// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathWith, repoRoot, runBash, withFakeTools } from "./helpers.mjs";

const NGINX = "https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml";
const CERT = "https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml";
const clean = { NBO_KIND_CONFIG: "", NBO_INGRESS_NGINX_MANIFEST: "", NBO_CERT_MANAGER_MANIFEST: "", NBO_KIND_CLUSTER: "" };

function run(env) {
  const t = withFakeTools(["kind", "kubectl"], {
    kubectl: 'if [ "$1" = get ]; then echo pod-1; fi; exit 0',
    kind: "exit 0",
  });
  try {
    const r = runBash("scripts/bootstrap-local-k8s.sh", [], { ...clean, ...env, PATH: pathWith(t.binDir) });
    return { r, log: t.readLog() };
  } finally {
    t.cleanup();
  }
}

test("defaults: today's manifests and kind config", () => {
  const { r, log } = run({});
  assert.equal(r.code, 0, r.stderr);
  const applies = log.filter((a) => a[0] === "apply" && a[1] === "-f").map((a) => a[2]);
  assert.deepEqual(applies.slice(0, 2), [NGINX, CERT]);
  const create = log.find((a) => a[0] === "create" && a[1] === "cluster");
  assert.ok(create, "kind create cluster called");
  assert.equal(create[create.indexOf("--config") + 1], "scripts/local-k8s/kind-config.yaml");
});

test("overrides are used when set", () => {
  const { r, log } = run({
    NBO_KIND_CONFIG: "scripts/ci/kind-config.yaml",
    NBO_INGRESS_NGINX_MANIFEST: "https://example.test/nginx.yaml",
    NBO_CERT_MANAGER_MANIFEST: "https://example.test/cert.yaml",
  });
  assert.equal(r.code, 0, r.stderr);
  const applies = log.filter((a) => a[0] === "apply" && a[1] === "-f").map((a) => a[2]);
  assert.deepEqual(applies.slice(0, 2), ["https://example.test/nginx.yaml", "https://example.test/cert.yaml"]);
  const create = log.find((a) => a[0] === "create" && a[1] === "cluster");
  assert.equal(create[create.indexOf("--config") + 1], "scripts/ci/kind-config.yaml");
});

test("ci kind-config.yaml has the pinned image, API port and SANs", () => {
  const y = readFileSync(join(repoRoot, "scripts/ci/kind-config.yaml"), "utf8");
  assert.match(y, /image:\s*kindest\/node:v1\.31\.4/);
  assert.match(y, /apiServerAddress:\s*"0\.0\.0\.0"/);
  assert.match(y, /apiServerPort:\s*6443/);
  assert.match(y, /containerPort:\s*80\b[\s\S]*hostPort:\s*80\b/);
  assert.match(y, /containerPort:\s*443\b[\s\S]*hostPort:\s*443\b/);
  for (const san of ["127.0.0.1", "0.0.0.0", "localhost", "docker"]) {
    assert.match(y, new RegExp(String.raw`certSANs:[\s\S]*-\s*"?${san}"?\s*$`, "m"));
  }
});

test("the cluster is nbo-local by default and NBO_KIND_CLUSTER when set", () => {
  const name = (log) => {
    const create = log.find((a) => a[0] === "create" && a[1] === "cluster");
    return create[create.indexOf("--name") + 1];
  };
  const def = run({});
  assert.equal(def.r.code, 0, def.r.stderr);
  assert.equal(name(def.log), "nbo-local");
  const ci = run({ NBO_KIND_CLUSTER: "nbo-ci" });
  assert.equal(ci.r.code, 0, ci.r.stderr);
  assert.equal(name(ci.log), "nbo-ci");
  assert.ok(ci.log.some((a) => a.join(" ") === "cluster-info --context kind-nbo-ci"));
});

// A fresh dind (every CI job, every rehearsal) pulls every image cold: the
// ingress-nginx controller became ready only after 3 to 4 minutes, past the
// old fixed 180s. The pod waits default to 600s and NBO_BOOTSTRAP_WAIT_TIMEOUT
// overrides them.
const podWaits = (log) => log.filter((a) => a[0] === "wait" && a.includes("pod")).map((a) => a.find((x) => x.startsWith("--timeout=")));

test("pod waits allow 600s by default", () => {
  const { r, log } = run({ NBO_BOOTSTRAP_WAIT_TIMEOUT: "" });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(podWaits(log), ["--timeout=600s", "--timeout=600s"]);
});

test("NBO_BOOTSTRAP_WAIT_TIMEOUT sets the pod waits", () => {
  const { r, log } = run({ NBO_BOOTSTRAP_WAIT_TIMEOUT: "42s" });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(podWaits(log), ["--timeout=42s", "--timeout=42s"]);
});
