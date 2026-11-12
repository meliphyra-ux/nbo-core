// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathWith, repoRoot, runBash, withFakeTools } from "./helpers.mjs";

// install-tools.sh with every tool already installed and verified (fake
// sha256sum answers the pinned hashes), so only the env file is written.
const fwd = (p) => p.split(String.fromCharCode(92)).join("/");
const script = readFileSync(join(repoRoot, "scripts", "ci", "install-tools.sh"), "utf8");
const pin = (name) => new RegExp(`${name}_SHA256="([0-9a-f]{64})"`).exec(script)[1];

function setup({ credentialHelper = true } = {}) {
  const tools = mkdtempSync(join(tmpdir(), "nbo-ci-tools-"));
  mkdirSync(join(tools, "bin"), { recursive: true });
  mkdirSync(join(tools, "stamps"), { recursive: true });
  mkdirSync(join(tools, "google-cloud-sdk", "bin"), { recursive: true });
  for (const f of ["bin/kind", "bin/kubectl", "bin/docker", "bin/gcloud", "google-cloud-sdk/bin/gcloud"]) {
    writeFileSync(join(tools, f), "#!/usr/bin/env bash\necho fake\n");
    chmodSync(join(tools, f), 0o755);
  }
  if (credentialHelper) {
    const helper = join(tools, "google-cloud-sdk", "bin", "docker-credential-gcloud");
    writeFileSync(helper, "#!/usr/bin/env bash\necho helper\n");
    chmodSync(helper, 0o755);
  }
  writeFileSync(join(tools, "stamps", "docker"), pin("DOCKER") + "\n");
  writeFileSync(join(tools, "stamps", "gcloud"), pin("GCLOUD") + "\n");
  const fake = withFakeTools(["sha256sum", "curl"], {
    sha256sum: `case "$1" in */kind) echo "${pin("KIND")}  $1";; */kubectl) echo "${pin("KUBECTL")}  $1";; *) echo "0  $1";; esac`,
    curl: "exit 1",
  });
  return { tools, fake };
}

function run(args, opts) {
  const { tools, fake } = setup(opts);
  try {
    const r = runBash("scripts/ci/install-tools.sh", args, {
      PATH: pathWith(fake.binDir),
      NBO_CI_TOOLS: fwd(tools),
      NBO_CI_TRUST_STAMPS: "1",
      NBO_CI_DIND: "",
    });
    const envFile = join(tools, "env.sh");
    const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    const which = (name) => spawnSync("bash", ["-c", `. "${fwd(envFile)}" && command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    return { r, env, which, calls: fake.readLog(), tools };
  } finally {
    fake.cleanup();
  }
}

test("--gcloud writes an env file putting the tools and the gcloud SDK bin on PATH", () => {
  const { r, env, which, calls, tools } = run(["--gcloud"]);
  try {
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(!calls.some((c) => c.some((a) => a.startsWith("http"))), "nothing downloaded");
    assert.match(env, /^export PATH=".*\/bin:.*\/google-cloud-sdk\/bin:\$PATH"$/m);
    assert.match(which("docker-credential-gcloud"), /google-cloud-sdk\/bin\/docker-credential-gcloud$/);
    assert.match(which("kind"), /\/bin\/kind$/);
  } finally {
    rmSync(tools, { recursive: true, force: true });
  }
});

test("without --gcloud the env file has only the tools bin", () => {
  const { r, env, tools } = run([]);
  try {
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(env, /^export PATH=".*\/bin:\$PATH"$/m);
    assert.doesNotMatch(env, /google-cloud-sdk/);
  } finally {
    rmSync(tools, { recursive: true, force: true });
  }
});

test("--gcloud fails when the SDK has no docker-credential-gcloud", () => {
  const { r, tools } = run(["--gcloud"], { credentialHelper: false });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /docker-credential-gcloud/);
  } finally {
    rmSync(tools, { recursive: true, force: true });
  }
});
