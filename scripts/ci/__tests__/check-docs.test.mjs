// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkApi, checkEnv, checkLinks, checkPaths, main } from "../../docs/check-docs.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "check-docs.mjs");
const BASE = tmpdir();

function tree(files) {
  const root = mkdtempSync(join(BASE, "nbo-docs-"));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

const CH = "docs/manual/server-settings.md";

test("links: an in-app /docs target and a bad relative link are reported", async () => {
  const root = tree({
    "docs/ci.md": "# CI\n",
    "docs/production.md": "See [env](/docs/environments) and [ci](./ci.md) and [gone](./gone.md) and [web](https://x.dev/a).\n",
  });
  try {
    const f = await checkLinks(root);
    assert.equal(f.length, 2, JSON.stringify(f));
    assert.ok(f.every((x) => x.check === "links" && x.file === "docs/production.md" && x.line === 1));
    assert.ok(f.some((x) => /\/docs\/environments/.test(x.problem) && /relative/.test(x.problem)), JSON.stringify(f));
    assert.ok(f.some((x) => /gone\.md/.test(x.problem)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("links: the core manual in docs/manual is scanned, chapter to chapter and to production.md", async () => {
  const root = tree({
    "docs/production.md": "[s](./manual/server-settings.md#ports)\n",
    "docs/manual/server-settings.md": "## Ports\n[c](./cache.md#cache) [p](../production.md) [gone](./gone.md) [old](/docs/cache)\n",
    "docs/manual/cache.md": "# Cache\n",
  });
  try {
    const f = await checkLinks(root);
    assert.deepEqual(f.map((x) => x.file), ["docs/manual/server-settings.md", "docs/manual/server-settings.md"], JSON.stringify(f));
    assert.ok(f.some((x) => /gone\.md/.test(x.problem)));
    assert.ok(f.some((x) => /\/docs\/cache/.test(x.problem)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("links: links in code fences and inline code are ignored; CRLF lines count right", async () => {
  const root = tree({
    "README.md": "# R\r\n```\r\n[x](./nope.md)\r\n```\r\nUse `[y](./nope2.md)` here.\r\n[z](./nope3.md)\r\n",
  });
  try {
    const f = await checkLinks(root);
    assert.deepEqual(f.map((x) => [x.line, /nope3/.test(x.problem)]), [[6, true]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("links: html href=#nope and a missing relative file are reported, real ones pass", async () => {
  const root = tree({
    "docs/architecture/index.html": '<h2 id="ok">a</h2><a href="#ok">1</a>\n<a href="#nope">2</a> <a href="../ci.md">3</a> <a href="../gone.md">4</a> <a href="https://x.dev">5</a>',
    "docs/ci.md": "x",
  });
  try {
    const f = await checkLinks(root);
    assert.equal(f.length, 2, JSON.stringify(f));
    assert.ok(f.some((x) => /#nope/.test(x.problem) && x.line === 2));
    assert.ok(f.some((x) => /gone\.md/.test(x.problem)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paths: a missing repo path is reported; placeholders, globs and existing paths are not", async () => {
  const root = tree({
    "packages/real/x.ts": "",
    "docs/context.md": "Real `packages/real/x.ts`, bad `packages/nope/x.ts`, template `packages/<name>/x`, glob `docs/*.md`, line `packages/real/x.ts:12`, dir `packages/real/`.\n",
  });
  try {
    const f = await checkPaths(root);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.match(f[0].problem, /packages\/nope\/x\.ts/);
    assert.equal(f[0].check, "paths");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("env: TS, Rust, compose and dynamic names; tests ignored; allowlist and chapter count as documented", async () => {
  const root = tree({
    "packages/controlplane/src/a.ts": 'const a = process.env.NBO_DOCUMENTED;\nconst b = process.env.NBO_HIDDEN_TS;\n// see NBO_GOOGLE_* in docs\nconst c = `NBO_${x}`;\n',
    "packages/controlplane/src/__tests__/a.test.ts": "process.env.NBO_ONLY_IN_TEST;\n",
    "packages/edge/src/b.ts": "process.env.NBO_ALLOWED;\n",
    "packages/edge-rs/src/c.rs": 'let v = std::env::var("NBO_EDGE_HTTP2");\n',
    "compose.yaml": "services:\n  nbo:\n    ports:\n      - ${NBO_PORT:-8081}:8081\n",
    // Only the four server packages, edge-rs and the root files are read.
    "packages/other/vite.config.ts": "target: process.env.NBO_ONLY_IN_VITE;\n",
    [CH]: "| `NBO_DOCUMENTED` | x |\r\n",
    "scripts/docs/env-allowlist.json": JSON.stringify({ NBO_ALLOWED: "test only" }),
  });
  try {
    const f = await checkEnv(root);
    const msgs = f.map((x) => x.problem).join("\n");
    assert.ok(/NBO_HIDDEN_TS/.test(msgs), msgs);
    assert.ok(/NBO_EDGE_HTTP2/.test(msgs), msgs);
    assert.ok(/NBO_PORT/.test(msgs), msgs);
    assert.ok(/dynamic name/.test(msgs), msgs);
    assert.ok(!/NBO_DOCUMENTED|NBO_ALLOWED|NBO_ONLY_IN_TEST|NBO_GOOGLE|NBO_ONLY_IN_VITE/.test(msgs), msgs);
    assert.equal(f.length, 4, msgs);
    const rs = f.find((x) => /NBO_EDGE_HTTP2/.test(x.problem));
    assert.equal(rs.file, "packages/edge-rs/src/c.rs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("env: a missing chapter is one finding, not a crash", async () => {
  const root = tree({ "packages/serve/src/a.ts": "process.env.NBO_X1;\nprocess.env.NBO_X2;\n" });
  try {
    const f = await checkEnv(root);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.match(f[0].problem, /docs\/manual\/server-settings\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const ACCESS = `export const routeAccess = {
  "GET /projects/{projectID}": "viewer",
  "POST /projects/{projectID}/builds": "developer",
  "GET /things": "viewer",
};
`;

test("api: a route missing from the page is reported; {projectID} matches {id}; ?query is stripped", async () => {
  const root = tree({
    "packages/controlplane/src/access.ts": ACCESS,
    "docs/architecture/index.html": '["GET", "/projects/{id}"], ["POST", "/projects/{id}/builds?stage=x"]',
  });
  try {
    const f = await checkApi(root);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.match(f[0].problem, /GET \/things/);
    assert.equal(f[0].file, "packages/controlplane/src/access.ts");
    assert.equal(f[0].line, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const CORE_ACCESS = `export const routeAccess = {
  "GET /healthz": "public",
  "GET /projects/{projectID}": "token",
  "GET /system/connections": "local",
};
`;

test("api: a row's access cell must match access.ts; local passes, a role such as admin is reported", async () => {
  const row = (m, p, access, service = "control-plane") => `["${m}","${p}","Does \\"a\\" thing.","${service}","${access}","Group"],`;
  const root = tree({
    "packages/controlplane/src/access.ts": CORE_ACCESS,
    "docs/architecture/index.html": [
      row("GET", "/healthz", "public"),
      row("GET", "/projects/{id}", "token"),
      row("GET", "/system/connections", "admin"),
      row("PUT", "/targets/{host}", "none", "edge admin"),
    ].join("\n"),
  });
  try {
    const f = await checkApi(root);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.equal(f[0].file, "docs/architecture/index.html");
    assert.equal(f[0].line, 3);
    assert.match(f[0].problem, /GET \/system\/connections/);
    assert.match(f[0].problem, /admin/);
    assert.match(f[0].problem, /local/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const ok = tree({
    "packages/controlplane/src/access.ts": CORE_ACCESS,
    "docs/architecture/index.html": [row("GET", "/healthz", "public"), row("GET", "/projects/{id}", "token"), row("GET", "/system/connections", "local")].join("\n"),
  });
  try {
    assert.deepEqual(await checkApi(ok), []);
  } finally {
    rmSync(ok, { recursive: true, force: true });
  }
});

test("api: a control-plane row for a route access.ts no longer has is reported", async () => {
  const root = tree({
    "packages/controlplane/src/access.ts": CORE_ACCESS,
    "docs/architecture/index.html": [
      '["GET","/healthz","x","control-plane","public","G"],',
      '["GET","/projects/{id}","x","control-plane","token","G"],',
      '["GET","/system/connections","x","control-plane","local","G"],',
      '["GET","/auth/session","x","control-plane","public","G"],',
    ].join("\n"),
  });
  try {
    const f = await checkApi(root);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.equal(f[0].line, 4);
    assert.match(f[0].problem, /GET \/auth\/session/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("links: a markdown anchor must match a heading by GitHub's rule", async () => {
  const root = tree({
    "docs/manual/a.md": "# A\n\n## Don't store variable values\n\n## Step 1: `nbo-server` setup\n\n[same](#dont-store-variable-values) [bad](#don-t-store-variable-values)\n",
    "docs/manual/b.md": "[ok](./a.md#step-1-nbo-server-setup) [old](./a.md#don-t-store-variable-values) [top](./a.md)\n",
  });
  try {
    const f = await checkLinks(root);
    assert.equal(f.length, 2, JSON.stringify(f));
    assert.ok(f.every((x) => /anchor not found/.test(x.problem) && /don-t-store/.test(x.problem)), JSON.stringify(f));
    assert.deepEqual(f.map((x) => x.file).sort(), ["docs/manual/a.md", "docs/manual/b.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Runs main() in this process with pending lists of the test's choosing.
async function runWith(root, args, pendingFiles, pendingChecks) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  try {
    const status = await main(["--root", root, ...args], pendingChecks ? { pendingFiles, pendingChecks } : { pendingFiles });
    return { status, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function run(root, args) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
}

test("cli: --only runs one check and exit code follows the findings", () => {
  const root = tree({
    "docs/ci.md": "bad `packages/nope/x.ts` and [gone](./gone.md)\n",
  });
  try {
    const paths = run(root, ["--only", "paths"]);
    assert.equal(paths.status, 1);
    assert.match(paths.stdout, /^docs: paths: docs\/ci\.md:1: /m);
    assert.doesNotMatch(paths.stdout, /docs: links:/);
    const none = run(root, ["--only", "api"]);
    assert.equal(none.status, 1, "missing access.ts is a finding when asked for explicitly");
    const clean = tree({ "README.md": "ok\n" });
    try {
      assert.equal(run(clean, ["--only", "links,paths"]).status, 0);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const PENDING = { "docs/local-dev.md": "test", "docs/ci.md": "test" };

test("cli: pending checks and files do not fail a default run but do print as pending", async () => {
  const root = tree({
    "docs/local-dev.md": "old `packages/gone/x.ts`\n",
    "docs/ci.md": "old `cmd/nbo/x.go`\n",
    "README.md": "ok\n",
  });
  try {
    const r = await runWith(root, [], PENDING, { env: "test", api: "test" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /pending/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: a pending file with no findings fails the default run", async () => {
  const root = tree({
    "docs/local-dev.md": "old `packages/gone/x.ts`\n",
    "docs/ci.md": "clean\n",
  });
  try {
    const r = await runWith(root, [], PENDING);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /docs: pending: docs\/ci\.md has no findings, remove it/);
    assert.doesNotMatch(r.stdout, /local-dev/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: a pending check that is clean fails the default run", async () => {
  // No pending files and no other findings: only the clean pending checks can fail the run.
  const root = tree({
    "packages/controlplane/src/access.ts": '  "GET /a": "viewer",\n',
    "docs/architecture/index.html": '["GET", "/a"]',
    [CH]: "x",
  });
  try {
    const clean = await runWith(root, [], {}, {});
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    const r = await runWith(root, [], {}, { env: "test", api: "test" });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /pending: docs\//);
    assert.match(r.stdout, /pending: check env has no findings/);
    assert.match(r.stdout, /pending: check api has no findings/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: --only with no value or an unknown check exits non-zero", () => {
  const root = tree({ "README.md": "ok\n" });
  try {
    assert.equal(run(root, ["--only", ""]).status, 1);
    assert.equal(run(root, ["--only"]).status, 1);
    assert.equal(run(root, ["--only", "nope"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("links: a malformed percent escape is a finding, not a crash", async () => {
  const root = tree({ "README.md": "[x](./a%zz.md)\n" });
  try {
    const f = await checkLinks(root);
    assert.equal(f.length, 1);
    assert.match(f[0].problem, /URL encoding/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paths: <code> in the platform page is checked", async () => {
  const root = tree({ "docs/architecture/index.html": "<p><code>packages/nope/y.ts</code> <code>docs/architecture/index.html</code></p>" });
  try {
    const f = await checkPaths(root);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.match(f[0].problem, /packages\/nope\/y\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("env: a malformed allowlist is a finding naming the file", async () => {
  const root = tree({ "scripts/docs/env-allowlist.json": "{ nope", [CH]: "x" });
  try {
    const f = await checkEnv(root);
    assert.equal(f.length, 1);
    assert.equal(f[0].file, "scripts/docs/env-allowlist.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
