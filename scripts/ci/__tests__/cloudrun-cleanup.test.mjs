// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathWith, runBash, withFakeTools } from "./helpers.mjs";

const script = "scripts/ci/cloudrun-cleanup.sh";
const env = { NBO_GCP_PROJECT: "p", NBO_CI_GCP_PROJECT: "p", NBO_GCP_REGION: "r", NBO_AR_REPO: "nbo" };

const ago = (hours) => new Date(Date.now() - hours * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");

// A fake gcloud answering the list commands with canned tab-separated
// rows, and every delete with `deleteBody` (bash, may inspect "$*").
function fakeGcloud({ services = [], packages = [], accounts = [], deleteBody = "exit 0" }) {
  const rows = (list) => list.map((r) => `printf '%s\\t%s\\n' '${r[0]}' '${r[1]}'`).join("\n");
  return withFakeTools(["gcloud"], {
    gcloud: [
      'case "$*" in',
      `  "run services list"*) ${rows(services) || ":"}; exit 0;;`,
      `  "artifacts packages list"*) ${rows(packages) || ":"}; exit 0;;`,
      `  "iam service-accounts list"*) ${rows(accounts) || ":"}; exit 0;;`,
      "esac",
      deleteBody,
    ].join("\n"),
  });
}

const deletes = (fake) => fake.readLog().filter((c) => c.includes("delete"));
const flat = (fake) => deletes(fake).map((c) => { const i = c.findIndex((a) => a.startsWith("--")); return (i < 0 ? c : c.slice(0, i)).join(" "); });

function run(fake, args) {
  return runBash(script, args, { ...env, PATH: pathWith(fake.binDir) });
}

test("a prefix of ci-1- deletes ci-1-next but not ci-12-next or prod-next", () => {
  const fake = fakeGcloud({
    services: [
      ["ci-1-next", ago(1)],
      ["ci-1-next-fn-ssr", ago(1)],
      ["ci-12-next", ago(1)],
      ["prod-next", ago(1)],
    ],
    accounts: [
      ["a1@p.iam.gserviceaccount.com", "NBO ci-1-next"],
      ["a12@p.iam.gserviceaccount.com", "NBO ci-12-next"],
      ["b@p.iam.gserviceaccount.com", "NBO prod-next"],
    ],
  });
  try {
    const r = run(fake, ["--prefix", "ci-1-"]);
    assert.equal(r.code, 0, r.stderr);
    const got = flat(fake);
    assert.ok(got.includes("run services delete ci-1-next"));
    assert.ok(got.includes("run services delete ci-1-next-fn-ssr"));
    assert.equal(got.length, 2, got.join("\n"));
    assert.ok(!fake.readLog().some((c) => c[0] === "iam"), "service accounts are never listed or deleted");
    for (const c of deletes(fake)) assert.ok(c.includes("--quiet"));
  } finally {
    fake.cleanup();
  }
});

test("packages nbo-app-ci-1-next and nbo-fn-ci-1-next-ssr go, nbo-app-ci-12-next stays", () => {
  const fake = fakeGcloud({
    packages: [
      ["projects/p/locations/r/repositories/nbo/packages/nbo-app-ci-1-next", ago(1)],
      ["nbo-fn-ci-1-next-ssr", ago(1)],
      ["nbo-app-ci-12-next", ago(1)],
    ],
  });
  try {
    const r = run(fake, ["--prefix", "ci-1-"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(flat(fake), [
      "artifacts packages delete nbo-app-ci-1-next",
      "artifacts packages delete nbo-fn-ci-1-next-ssr",
    ]);
  } finally {
    fake.cleanup();
  }
});

test("a prefix not starting with ci- is refused before gcloud is called", () => {
  const fake = fakeGcloud({ services: [["prod-next", ago(9)]] });
  try {
    const r = run(fake, ["--prefix", "prod-"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /refusing prefix prod-: must start with ci-/);
    assert.deepEqual(fake.readLog(), []);
  } finally {
    fake.cleanup();
  }
});

test("it needs --prefix or --janitor and the three variables", () => {
  const fake = fakeGcloud({});
  try {
    assert.equal(run(fake, []).code, 2);
    const r = runBash(script, ["--prefix", "ci-1-"], { PATH: pathWith(fake.binDir), NBO_GCP_PROJECT: "", NBO_CI_GCP_PROJECT: "", NBO_GCP_REGION: "", NBO_AR_REPO: "" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /NBO_GCP_PROJECT/);
    assert.deepEqual(fake.readLog(), []);
  } finally {
    fake.cleanup();
  }
});

test("janitor deletes a 4 hour old ci- service and keeps a 1 hour old one and non-ci ones", () => {
  const fake = fakeGcloud({
    services: [
      ["ci-9-next", ago(4)],
      ["ci-10-next", ago(1)],
      ["prod-old", ago(100)],
    ],
    packages: [
      ["nbo-app-ci-9-next", ago(4)],
      ["nbo-app-ci-10-next", ago(1)],
      ["nbo-app-prod-old", ago(100)],
    ],
  });
  try {
    const r = run(fake, ["--janitor"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(flat(fake), ["run services delete ci-9-next", "artifacts packages delete nbo-app-ci-9-next"]);
  } finally {
    fake.cleanup();
  }
});

test("janitor honours --older-than-hours", () => {
  const fake = fakeGcloud({ services: [["ci-9-next", ago(4)], ["ci-10-next", ago(1)]] });
  try {
    const r = run(fake, ["--janitor", "--older-than-hours", "0"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(flat(fake), ["run services delete ci-9-next", "run services delete ci-10-next"]);
  } finally {
    fake.cleanup();
  }
});

test("a failing delete is printed, the rest still run, and the exit code is 1", () => {
  const fake = fakeGcloud({
    services: [["ci-1-a", ago(1)], ["ci-1-b", ago(1)], ["ci-1-c", ago(1)]],
    deleteBody: 'case "$*" in *ci-1-b*) echo "ERROR: PERMISSION_DENIED on ci-1-b" >&2; exit 1;; esac',
  });
  try {
    const r = run(fake, ["--prefix", "ci-1-"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /PERMISSION_DENIED/);
    assert.equal(deletes(fake).length, 3);
  } finally {
    fake.cleanup();
  }
});

test("a delete answering NOT_FOUND counts as success", () => {
  const fake = fakeGcloud({
    services: [["ci-1-a", ago(1)]],
    deleteBody: 'echo "ERROR: NOT_FOUND: service ci-1-a not found" >&2; exit 1',
  });
  try {
    const r = run(fake, ["--prefix", "ci-1-"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(deletes(fake).length, 1);
  } finally {
    fake.cleanup();
  }
});

test("it refuses a project that NBO_CI_GCP_PROJECT does not name, without calling gcloud", () => {
  for (const ci of ["", "other"]) {
    const fake = fakeGcloud({ services: [["ci-1-a", ago(9)]] });
    try {
      const r = runBash(script, ["--janitor"], { ...env, NBO_CI_GCP_PROJECT: ci, PATH: pathWith(fake.binDir) });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /NBO_CI_GCP_PROJECT/);
      assert.deepEqual(fake.readLog(), []);
    } finally {
      fake.cleanup();
    }
  }
});

test("--prefix ci- alone is refused", () => {
  const fake = fakeGcloud({ services: [["ci-1-a", ago(9)]] });
  try {
    const r = run(fake, ["--prefix", "ci-"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /refusing prefix ci-/);
    assert.deepEqual(fake.readLog(), []);
  } finally {
    fake.cleanup();
  }
});

test("a delete failing with some other not found (a missing project) is a failure", () => {
  const fake = fakeGcloud({
    services: [["ci-1-a", ago(1)]],
    deleteBody: 'echo "ERROR: Project p not found" >&2; exit 1',
  });
  try {
    assert.equal(run(fake, ["--prefix", "ci-1-"]).code, 1);
  } finally {
    fake.cleanup();
  }
});

test("neither mode lists or deletes service accounts (the CLI never creates per-service ones)", () => {
  for (const args of [["--janitor"], ["--prefix", "ci-9-"]]) {
    const fake = fakeGcloud({
      services: [["ci-9-next", ago(4)]],
      accounts: [["old@p.iam.gserviceaccount.com", "NBO ci-9-next"]],
    });
    try {
      const r = run(fake, args);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(flat(fake), ["run services delete ci-9-next"]);
      assert.ok(!fake.readLog().some((c) => c[0] === "iam"), JSON.stringify(fake.readLog()));
    } finally {
      fake.cleanup();
    }
  }
});

test("NBO_AR_REPO in the CLI's full form (host/project/repo) is passed to gcloud as the repository name", () => {
  const fake = fakeGcloud({ packages: [["nbo-app-ci-1-next", ago(1)]] });
  try {
    const r = runBash(script, ["--prefix", "ci-1-"], { ...env, NBO_AR_REPO: "r-docker.pkg.dev/p/nbo-ci", PATH: pathWith(fake.binDir) });
    assert.equal(r.code, 0, r.stderr);
    const calls = fake.readLog().filter((c) => c[0] === "artifacts");
    assert.equal(calls.length, 2);
    for (const c of calls) assert.equal(c[c.indexOf("--repository") + 1], "nbo-ci", JSON.stringify(c));
  } finally {
    fake.cleanup();
  }
});
