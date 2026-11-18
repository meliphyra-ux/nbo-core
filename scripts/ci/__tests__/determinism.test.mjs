// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pathWith, repoRoot, runBash, withFakeTools } from "./helpers.mjs";

// The checks run the real built CLI (`nbo content-id`) against canned .nbo/
// outputs written by @nbo/writer; only `pnpm` (the build) is faked.
const cliMain = join(repoRoot, "packages", "cli", "dist", "main.js");
const writerDist = join(repoRoot, "packages", "writer", "dist", "index.js");
const fwd = (p) => p.split(String.fromCharCode(92)).join("/");

let work;
const templates = {};

async function writeNbo(outDir, body) {
  const { NboWriter } = await import(pathToFileURL(writerDist).href);
  const src = join(work, "src-" + Math.random().toString(36).slice(2));
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "a.txt"), body);
  writeFileSync(join(src, "b.txt"), "same in both builds");
  const w = new NboWriter({ outDir, framework: { name: "nextjs" } });
  w.addStatic("/a.txt", join(src, "a.txt"));
  w.addStatic("/b.txt", join(src, "b.txt"));
  await w.write();
}

// writeNext writes a Next-shaped tree: a non-seed static file /a.txt, a seed
// /p (the prerender entry's seeds), a function "ssr" and one prerender entry
// with x-nbo-ppr. Each option changes one thing from the base build.
async function writeNext(outDir, o = {}) {
  const { NboWriter } = await import(pathToFileURL(writerDist).href);
  const src = join(work, "src-" + Math.random().toString(36).slice(2));
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "a.txt"), o.nonSeed ?? "not rendered");
  writeFileSync(join(src, "p.html"), o.seed ?? "<p>rendered at build time</p>");
  writeFileSync(join(src, "index.mjs"), o.entry ?? "export default () => new Response('ok');\n");
  const w = new NboWriter({ outDir, framework: { name: "nextjs" } });
  w.addStatic("/a.txt", join(src, "a.txt"));
  w.addStatic("/p", join(src, "p.html"));
  w.addFunction("ssr", { runtime: { kind: "node", version: ">=20" }, entryFilePath: join(src, "index.mjs") });
  if (o.routes) {
    w.setRoutes({
      version: 1,
      fallback: [{ id: "r", match: { path: "^/x$" }, action: { type: "rewrite", path: "/a.txt" } }],
    });
  }
  w.addPrerender({
    id: "/p",
    match: "^/p$",
    function: "ssr",
    revalidateSec: o.revalidateSec ?? 0,
    expireSec: 0,
    tags: [],
    seeds: { "/p": { file: "/p" } },
    onMiss: "blocking",
    allowQuery: [],
    varyHeaders: [],
    bypassToken: { env: "NBO_PRERENDER_BYPASS" },
    "x-nbo-ppr": { postponedState: o.postponed ?? "state-1" },
  });
  await w.write();
  if (o.seedContentType) {
    const p = join(outDir, "static.index.json");
    const idx = JSON.parse(readFileSync(p, "utf8"));
    idx.files["/p"].contentType = o.seedContentType;
    writeFileSync(p, JSON.stringify(idx));
  }
}

before(async () => {
  assert.ok(existsSync(cliMain), `build the CLI first: ${cliMain}`);
  assert.ok(existsSync(writerDist), `build the writer first: ${writerDist}`);
  work = mkdtempSync(join(tmpdir(), "nbo-determinism-"));
  templates.one = join(work, "one");
  templates.oneAgain = join(work, "one-again");
  templates.two = join(work, "two");
  await writeNbo(templates.one, "build one");
  await writeNbo(templates.oneAgain, "build one");
  await writeNbo(templates.two, "build two");
  const next = {
    base: {},
    baseAgain: {},
    seed: { seed: "<p>rendered at another time</p>" },
    postponed: { postponed: "state-2" },
    seedAndPostponed: { seed: "<p>rendered again, longer</p>", postponed: "state-3" },
    nonSeed: { nonSeed: "changed" },
    fn: { entry: "export default () => new Response('changed');\n" },
    routes: { routes: true },
    revalidate: { revalidateSec: 60 },
    seedContentType: { seedContentType: "text/plain; charset=utf-8" },
  };
  for (const [name, o] of Object.entries(next)) {
    templates[`next-${name}`] = join(work, `next-${name}`);
    await writeNext(templates[`next-${name}`], o);
  }
});

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

// fakePnpm copies FAKE_BUILD_<n> (n = 1, 2, ... per call) to
// $NBO_FIXTURES_DIR/<fixture>/.nbo, as `pnpm --filter <fixture> build` would,
// and records NBO_BUILD_ID, NEXT_SERVER_ACTIONS_ENCRYPTION_KEY and whether .next/cache survived the cleanup.
const fakePnpm = [
  'count="$FAKE_STATE/count"',
  'n=$(cat "$count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$count"',
  'fx="$2"',
  'echo "call=$n fixture=$fx id=$NBO_BUILD_ID" >> "$FAKE_STATE/env.log"',
  'echo "key$n=${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:-}" >> "$FAKE_STATE/env.log"',
  'if [ -e "$NBO_FIXTURES_DIR/$fx/.next/stale" ]; then echo "stale-left" >> "$FAKE_STATE/env.log"; fi',
  'if [ -e "$NBO_FIXTURES_DIR/$fx/.next/cache/keep" ]; then echo "cache-kept" >> "$FAKE_STATE/env.log"; fi',
  'v="FAKE_BUILD_$n"; src="${!v}"',
  'rm -rf "$NBO_FIXTURES_DIR/$fx/.nbo"',
  'cp -r "$src" "$NBO_FIXTURES_DIR/$fx/.nbo"',
  'mkdir -p "$NBO_FIXTURES_DIR/$fx/.next/cache"; touch "$NBO_FIXTURES_DIR/$fx/.next/stale"',
  "exit 0",
].join("\n");

function run(build1, build2, extraTools = {}, env = {}, { noCache = false, build3 } = {}) {
  const t = withFakeTools(["pnpm", ...Object.keys(extraTools)], { pnpm: fakePnpm, ...extraTools });
  const fixtures = join(work, "fixtures-" + Math.random().toString(36).slice(2));
  const state = join(work, "state-" + Math.random().toString(36).slice(2));
  if (noCache) {
    mkdirSync(join(fixtures, "next-app"), { recursive: true });
  } else {
    mkdirSync(join(fixtures, "next-app", ".next", "cache"), { recursive: true });
    writeFileSync(join(fixtures, "next-app", ".next", "cache", "keep"), "");
    writeFileSync(join(fixtures, "next-app", ".next", "stale"), "");
  }
  mkdirSync(state, { recursive: true });
  try {
    const r = runBash("scripts/ci/determinism-next.sh", ["next-app"], {
      PATH: pathWith(t.binDir),
      NBO_FIXTURES_DIR: fwd(fixtures),
      NBO_BUILD_ID: "",
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "",
      TMPDIR: fwd(work),
      FAKE_STATE: fwd(state),
      FAKE_BUILD_1: fwd(build1),
      FAKE_BUILD_2: fwd(build2),
      ...(build3 ? { FAKE_BUILD_3: fwd(build3) } : {}),
      ...env,
    });
    const envLog = existsSync(join(state, "env.log")) ? readFileSync(join(state, "env.log"), "utf8") : "";
    return { r, envLog, log: t.readLog() };
  } finally {
    t.cleanup();
  }
}

test("two identical builds pass and print the content id", () => {
  const { r, envLog, log } = run(templates.one, templates.oneAgain);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /deterministic: next-app -> sha256:[0-9a-f]{64}/);
  const builds = log.filter((a) => a.join(" ") === "--filter next-app build");
  assert.equal(builds.length, 2, "two real builds");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  assert.match(envLog, new RegExp(`call=1 fixture=next-app id=${head}`));
  assert.match(envLog, new RegExp(`call=2 fixture=next-app id=${head}`));
  assert.doesNotMatch(envLog, /stale-left/, ".next is cleaned before each build");
  assert.equal(envLog.match(/cache-kept/g)?.length, 2, ".next/cache survives both cleanups");
});

test("NBO_BUILD_ID set by the caller wins over git HEAD", () => {
  const { r, envLog } = run(templates.one, templates.oneAgain, {}, { NBO_BUILD_ID: "ci-abc" });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(envLog, /call=1 fixture=next-app id=ci-abc/);
});

test("builds differing in one static file fail and name that path", () => {
  const { r } = run(templates.one, templates.two);
  assert.notEqual(r.code, 0);
  const out = r.stdout + r.stderr;
  assert.match(out, /NON-DETERMINISTIC BUILD for next-app/);
  assert.match(out, /static\.index\.json: \/a\.txt/);
  assert.doesNotMatch(out, /\/b\.txt/, "unchanged files are not listed");
  assert.match(out, /manifest\.json digests: static\.index\.json/);
});

test("a CLI printing an empty id fails", () => {
  const { r } = run(templates.one, templates.oneAgain, {}, { NBO_BIN: "true" });
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /could not read a content id/);
});

test("a fixture with no .nbo after the build fails", () => {
  const { r } = run(join(work, "missing"), templates.one);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /no \.nbo/);
});

test("nbo-diff names the prerender entries that differ", () => {
  const mk = (name, state) => {
    const d = join(work, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ digests: { "prerender.json": `sha256:${name}` } }));
    writeFileSync(
      join(d, "prerender.json"),
      JSON.stringify({
        version: 1,
        prerenders: [
          { id: "/", x: state },
          { id: "/same", x: 1 },
        ],
      }),
    );
    return d;
  };
  const r = spawnSync("node", ["scripts/ci/nbo-diff.mjs", mk("pa", 1), mk("pb", 2)], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /manifest\.json digests: prerender\.json/);
  assert.match(r.stdout, /prerender\.json: \/ \(x\)/);
  assert.doesNotMatch(r.stdout, /prerender\.json: \/same/);
});

test("importing nbo-diff.mjs does not run its CLI, and exports diffNbo", () => {
  const url = pathToFileURL(join(repoRoot, "scripts", "ci", "nbo-diff.mjs")).href;
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(url)}); console.log(typeof m.diffNbo, typeof m.readJson);`,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "function function");
});

test("diffNbo returns the differing paths without printing", async () => {
  const { diffNbo } = await import(pathToFileURL(join(repoRoot, "scripts", "ci", "nbo-diff.mjs")).href);
  const lines = diffNbo(templates.one, templates.two);
  assert.ok(lines.includes("static.index.json: /a.txt"), JSON.stringify(lines));
  assert.ok(!lines.some((l) => l.includes("/b.txt")));
  assert.deepEqual(diffNbo(templates.one, templates.oneAgain), []);
});

// -- classify: the 1.0 determinism rule for Next.js builds --------------------

const nboDiffUrl = () => pathToFileURL(join(repoRoot, "scripts", "ci", "nbo-diff.mjs")).href;

test("classify: identical trees are same", async () => {
  const { classify } = await import(nboDiffUrl());
  const c = classify(templates["next-base"], templates["next-baseAgain"]);
  assert.deepEqual(c, { verdict: "same", renderPaths: [], otherPaths: [], draftKeyPaths: [] });
});

test("classify: seed bytes only are render-only and name the seed key", async () => {
  const { classify } = await import(nboDiffUrl());
  const c = classify(templates["next-base"], templates["next-seed"]);
  assert.equal(c.verdict, "render-only", JSON.stringify(c));
  assert.ok(c.renderPaths.includes("static.index.json: /p"), JSON.stringify(c));
  assert.deepEqual(c.otherPaths, []);
});

test("classify: postponedState only is render-only", async () => {
  const { classify } = await import(nboDiffUrl());
  const c = classify(templates["next-base"], templates["next-postponed"]);
  assert.equal(c.verdict, "render-only", JSON.stringify(c));
  assert.ok(
    c.renderPaths.some((p) => p.startsWith("prerender.json: /p")),
    JSON.stringify(c),
  );
  assert.deepEqual(c.otherPaths, []);
});

test("classify: seed bytes and postponedState together are render-only", async () => {
  const { classify } = await import(nboDiffUrl());
  const c = classify(templates["next-base"], templates["next-seedAndPostponed"]);
  assert.equal(c.verdict, "render-only", JSON.stringify(c));
  assert.deepEqual(c.otherPaths, []);
});

for (const [name, path] of [
  ["a non-seed static file", "static.index.json: /a.txt"],
  ["a function", "functions/ssr/function.json"],
  ["routes.json", "routes.json"],
  ["a prerender revalidateSec", "prerender.json: /p"],
  ["a seed's contentType", "static.index.json: /p"],
]) {
  const key = {
    "a non-seed static file": "nonSeed",
    "a function": "fn",
    "routes.json": "routes",
    "a prerender revalidateSec": "revalidate",
    "a seed's contentType": "seedContentType",
  }[name];
  test(`classify: ${name} differing is different and named`, async () => {
    const { classify } = await import(nboDiffUrl());
    const c = classify(templates["next-base"], templates[`next-${key}`]);
    assert.equal(c.verdict, "different", JSON.stringify(c));
    assert.ok(
      c.otherPaths.some((p) => p.startsWith(path)),
      JSON.stringify(c),
    );
  });
}

test("nbo-diff --classify exits 0 for render-only and 1 for different", () => {
  const cli = (a, b) =>
    spawnSync("node", ["scripts/ci/nbo-diff.mjs", "--classify", a, b], { cwd: repoRoot, encoding: "utf8" });
  const ok = cli(templates["next-base"], templates["next-seed"]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /deterministic apart from build-time renders:/);
  assert.match(ok.stdout, /static\.index\.json: \/p/);
  const same = cli(templates["next-base"], templates["next-baseAgain"]);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  const bad = cli(templates["next-base"], templates["next-fn"]);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /functions\/ssr\/function\.json/);
});

test("determinism-next.sh passes a seed-only difference and prints the line", () => {
  const { r } = run(templates["next-base"], templates["next-seed"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /deterministic apart from build-time renders: next-app/);
  assert.match(r.stdout, /static\.index\.json: \/p/);
  assert.doesNotMatch(r.stdout, /NON-DETERMINISTIC/);
});

test("determinism-next.sh fails a function difference", () => {
  const { r } = run(templates["next-base"], templates["next-fn"]);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /NON-DETERMINISTIC BUILD for next-app/);
  assert.match(r.stdout + r.stderr, /functions\/ssr\/function\.json/);
});

test("determinism-next.sh runs nbo validate --strict on each build and fails on an invalid one", () => {
  const broken = join(work, "next-broken");
  rmSync(broken, { recursive: true, force: true });
  cpSync(templates["next-base"], broken, { recursive: true });
  writeFileSync(join(broken, "static", "a.txt"), "tampered");
  const { r } = run(templates["next-base"], broken);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /nbo validate --strict failed for next-app \(build 2\)/);
});

// -- classify: crafted prerender.json trees (final review I2) ------------------

// craft copies the base Next tree and replaces prerender.json with doc, moving
// manifest.json's prerender.json digest the way a real build would.
async function craft(name, edit) {
  const { createHash } = await import("node:crypto");
  const out = join(work, `crafted-${name}`);
  rmSync(out, { recursive: true, force: true });
  cpSync(templates["next-base"], out, { recursive: true });
  const doc = JSON.parse(readFileSync(join(out, "prerender.json"), "utf8"));
  edit(doc);
  const raw = JSON.stringify(doc);
  writeFileSync(join(out, "prerender.json"), raw);
  const mp = join(out, "manifest.json");
  const m = JSON.parse(readFileSync(mp, "utf8"));
  m.digests["prerender.json"] = "sha256:" + createHash("sha256").update(raw).digest("hex");
  writeFileSync(mp, JSON.stringify(m));
  return out;
}
const second = (p, id) => ({ ...p, id, match: `^${id}$`, seeds: {} });

test("classify: a duplicate prerender id is different, even when the last duplicate differs only in postponedState", async () => {
  const { classify } = await import(nboDiffUrl());
  const a = await craft("dup-a", (d) => {
    const p = d.prerenders[0];
    d.prerenders = [{ ...p, revalidateSec: 0 }, { ...p }];
  });
  const b = await craft("dup-b", (d) => {
    const p = d.prerenders[0];
    d.prerenders = [
      { ...p, revalidateSec: 60 },
      { ...p, "x-nbo-ppr": { postponedState: "state-2" } },
    ];
  });
  const c = classify(a, b);
  assert.equal(c.verdict, "different", JSON.stringify(c));
  assert.ok(
    c.otherPaths.some((p) => p.includes('duplicate prerender id "/p"')),
    JSON.stringify(c),
  );
});

test("classify: a reorder plus a postponedState change is compared by id; a metadata change in the moved entry is different", async () => {
  const { classify } = await import(nboDiffUrl());
  const a = await craft("reorder-a", (d) => {
    d.prerenders = [d.prerenders[0], second(d.prerenders[0], "/q")];
  });
  const renderOnly = await craft("reorder-b", (d) => {
    const p = d.prerenders[0];
    d.prerenders = [second(p, "/q"), { ...p, "x-nbo-ppr": { postponedState: "state-2" } }];
  });
  const c1 = classify(a, renderOnly);
  assert.equal(c1.verdict, "render-only", JSON.stringify(c1));
  assert.deepEqual(c1.renderPaths, ["prerender.json: /p (x-nbo-ppr.postponedState)"]);
  const moved = await craft("reorder-c", (d) => {
    const p = d.prerenders[0];
    d.prerenders = [
      { ...second(p, "/q"), function: "other" },
      { ...p, "x-nbo-ppr": { postponedState: "state-2" } },
    ];
  });
  const c2 = classify(a, moved);
  assert.equal(c2.verdict, "different", JSON.stringify(c2));
  assert.ok(
    c2.otherPaths.some((p) => p.startsWith("prerender.json: /q (function")),
    JSON.stringify(c2),
  );
});

test("classify: a dropped postponedState is different on its own, without validate", async () => {
  const { classify } = await import(nboDiffUrl());
  const b = await craft("dropped", (d) => {
    d.prerenders[0]["x-nbo-ppr"] = {};
  });
  const c = classify(templates["next-base"], b);
  assert.equal(c.verdict, "different", JSON.stringify(c));
});

test("classify: a top-level prerender.json field next to a postponedState change is different", async () => {
  const { classify } = await import(nboDiffUrl());
  const b = await craft("toplevel", (d) => {
    d.version = 2;
    d.prerenders[0]["x-nbo-ppr"] = { postponedState: "state-2" };
  });
  const c = classify(templates["next-base"], b);
  assert.equal(c.verdict, "different", JSON.stringify(c));
  assert.ok(c.otherPaths.includes("prerender.json: version"), JSON.stringify(c));
});

// -- bundleDetail: which bundle entries differ, so a CI log says why ----------

function writeBundle(dir, files) {
  mkdirSync(join(dir, "functions", "ssr", "bundle"), { recursive: true });
  writeFileSync(join(dir, "functions", "ssr", "function.json"), JSON.stringify({ files: Object.keys(files).length }));
  writeFileSync(join(dir, "functions", "ssr", "bundle", "bundle.index.json"), JSON.stringify({ files }));
}

test("bundleDetail names entries only in one build and entries whose contents differ", async () => {
  const { bundleDetail } = await import(nboDiffUrl());
  const a = mkdtempSync(join(work, "bd-a-"));
  const b = mkdtempSync(join(work, "bd-b-"));
  writeBundle(a, { "x.js": { digest: "sha256:1" }, "y.js": { digest: "sha256:2" }, "gone.js": { digest: "sha256:5" } });
  writeBundle(b, { "x.js": { digest: "sha256:1" }, "y.js": { digest: "sha256:3" }, "z.js": { digest: "sha256:4" } });
  assert.deepEqual(bundleDetail(a, b), [
    "functions/ssr/bundle: gone.js (only in build 1)",
    "functions/ssr/bundle: y.js (contents differ)",
    "functions/ssr/bundle: z.js (only in build 2)",
  ]);
});

test("bundleDetail stops after the limit and says how many more", async () => {
  const { bundleDetail } = await import(nboDiffUrl());
  const a = mkdtempSync(join(work, "bd-a-"));
  const b = mkdtempSync(join(work, "bd-b-"));
  writeBundle(a, {});
  writeBundle(b, Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.js`, { digest: `sha256:${i}` }])));
  const lines = bundleDetail(a, b, 2);
  assert.equal(lines.length, 3);
  assert.equal(lines[2], "functions/ssr/bundle: ... and 3 more");
});

test("--classify prints the differing bundle entries under the differences", async () => {
  const a = mkdtempSync(join(work, "bd-a-"));
  const b = mkdtempSync(join(work, "bd-b-"));
  writeBundle(a, { "x.js": { digest: "sha256:1" } });
  writeBundle(b, { "x.js": { digest: "sha256:1" }, ".next/cache/z": { digest: "sha256:9" } });
  const r = spawnSync(process.execPath, [join(repoRoot, "scripts", "ci", "nbo-diff.mjs"), "--classify", a, b], {
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(
    r.stdout,
    /bundle entries that differ:\n {2}functions\/ssr\/bundle: \.next\/cache\/z \(only in build 2\)/,
  );
});

// On a fresh machine Next makes its draft-mode and server-action keys on the first build; with no .next/cache the
// two compared builds would start from different caches (GitLab, 2026-11-16). A warm-up build comes first then.
test("with no .next/cache yet, a warm-up build runs first and builds 1 and 2 are compared", () => {
  const { r, log } = run(templates["next-fn"], templates.one, {}, {}, { noCache: true, build3: templates.oneAgain });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes("next-app: warm-up build (no .next/cache yet)"), r.stdout);
  assert.equal(log.filter((a) => a.join(" ") === "--filter next-app build").length, 3);
  assert.match(r.stdout, /deterministic: next-app -> sha256:[0-9a-f]{64}/);
});

// -- server-actions key and Next draft-mode keys (GitLab, 2026-11-16) ---------

// Inside a container Next keeps no key cache, so each build would get a new server-actions key (it salts every action
// id). The script pins one random key per run, the AES-256-GCM key Next imports: base64 of 32 bytes.
test("every build of a run gets the same NEXT_SERVER_ACTIONS_ENCRYPTION_KEY, base64 of 32 bytes", () => {
  const { r, envLog } = run(templates.one, templates.oneAgain);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const k1 = envLog.match(/^key1=(.*)$/m)?.[1];
  const k2 = envLog.match(/^key2=(.*)$/m)?.[1];
  assert.ok(k1, envLog);
  assert.equal(k2, k1, "the same key on every build of the run");
  assert.equal(Buffer.from(k1, "base64").length, 32);
  const again = run(templates.one, templates.oneAgain).envLog.match(/^key1=(.*)$/m)?.[1];
  assert.notEqual(again, k1, "a new random key per run");
});

test("a NEXT_SERVER_ACTIONS_ENCRYPTION_KEY set by the caller wins", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const { r, envLog } = run(templates.one, templates.oneAgain, {}, { NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: key });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const lines = envLog.split("\n");
  assert.ok(lines.includes(`key1=${key}`), envLog);
  assert.ok(lines.includes(`key2=${key}`), envLog);
});

const previewKeys = (n) => ({
  previewModeId: `id-${n}`,
  previewModeSigningKey: `sign-${n}`,
  previewModeEncryptionKey: `enc-${n}`,
});
const draftFiles = (n, o = {}) => ({
  ".next/server/preview-props.json": JSON.stringify({ ...previewKeys(n), ...o.props }),
  ".next/prerender-manifest.json": JSON.stringify({
    version: 4,
    routes: o.routes ?? {},
    dynamicRoutes: {},
    notFoundRoutes: [],
    preview: previewKeys(n),
  }),
  ".next/server/server-reference-manifest.json": o.serverRefs ?? '{"node":{},"edge":{}}',
});

// craftBundle copies the base Next tree and adds files to the ssr function's bundle, rewriting bundle.index.json,
// function.json's artifact digest and manifest.json's function.json digest the way the writer would.
async function craftBundle(name, files) {
  const { createHash } = await import("node:crypto");
  const sha = (x) => "sha256:" + createHash("sha256").update(x).digest("hex");
  const out = join(work, `bundle-${name}`);
  rmSync(out, { recursive: true, force: true });
  cpSync(templates["next-base"], out, { recursive: true });
  const fn = join(out, "functions", "ssr");
  const idxPath = join(fn, "bundle", "bundle.index.json");
  const idx = JSON.parse(readFileSync(idxPath, "utf8"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(fn, "bundle", rel, ".."), { recursive: true });
    writeFileSync(join(fn, "bundle", rel), body);
    idx.files[rel] = { digest: sha(body), size: Buffer.byteLength(body) };
  }
  idx.files = Object.fromEntries(Object.entries(idx.files).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  const rawIdx = JSON.stringify(idx);
  writeFileSync(idxPath, rawIdx);
  const fj = JSON.parse(readFileSync(join(fn, "function.json"), "utf8"));
  fj.artifact.digest = sha(rawIdx);
  const rawFj = JSON.stringify(fj);
  writeFileSync(join(fn, "function.json"), rawFj);
  const mp = join(out, "manifest.json");
  const m = JSON.parse(readFileSync(mp, "utf8"));
  m.digests["functions/ssr/function.json"] = sha(rawFj);
  writeFileSync(mp, JSON.stringify(m));
  return out;
}

test("classify: only Next draft-mode keys differing is allowed and names the files", async () => {
  const { classify } = await import(nboDiffUrl());
  const a = await craftBundle("draft-a", draftFiles(1));
  const b = await craftBundle("draft-b", draftFiles(2));
  const c = classify(a, b);
  assert.equal(c.verdict, "render-only", JSON.stringify(c));
  assert.deepEqual(c.otherPaths, []);
  assert.ok(c.draftKeyPaths.includes("functions/ssr/bundle/.next/server/preview-props.json"), JSON.stringify(c));
  assert.ok(c.draftKeyPaths.includes("functions/ssr/bundle/.next/prerender-manifest.json"), JSON.stringify(c));
  assert.ok(c.draftKeyPaths.some((p) => p.startsWith("manifest.json digests: functions/ssr/function.json")));
  const same = classify(a, await craftBundle("draft-a2", draftFiles(1)));
  assert.equal(same.verdict, "same", JSON.stringify(same));
});

test("classify: draft-mode keys plus another preview-props field is different", async () => {
  const { classify } = await import(nboDiffUrl());
  const a = await craftBundle("props-a", draftFiles(1));
  const b = await craftBundle("props-b", draftFiles(2, { props: { other: "x" } }));
  const c = classify(a, b);
  assert.equal(c.verdict, "different", JSON.stringify(c));
  assert.ok(c.otherPaths.includes("functions/ssr/function.json"), JSON.stringify(c));
  assert.ok(c.otherPaths.includes("functions/ssr/bundle/bundle.index.json"), JSON.stringify(c));
  assert.ok(c.otherPaths.includes("manifest.json digests: functions/ssr/function.json"), JSON.stringify(c));
});

test("classify: a prerender-manifest.json change outside preview is different", async () => {
  const { classify } = await import(nboDiffUrl());
  const a = await craftBundle("pm-a", draftFiles(1));
  const b = await craftBundle("pm-b", draftFiles(2, { routes: { "/x": {} } }));
  assert.equal(classify(a, b).verdict, "different");
});

test("classify: a differing server-reference-manifest.json is different, even next to draft-mode keys", async () => {
  const { classify } = await import(nboDiffUrl());
  const a = await craftBundle("srm-a", draftFiles(1));
  const b = await craftBundle("srm-b", draftFiles(2, { serverRefs: '{"node":{"abc":{}},"edge":{}}' }));
  const c = classify(a, b);
  assert.equal(c.verdict, "different", JSON.stringify(c));
  assert.ok(c.otherPaths.includes("functions/ssr/function.json"), JSON.stringify(c));
});

test("--classify prints Next draft-mode keys under their own heading and exits 0", async () => {
  const a = await craftBundle("cli-a", draftFiles(1));
  const b = await craftBundle("cli-b", draftFiles(2));
  const r = spawnSync(process.execPath, [join(repoRoot, "scripts", "ci", "nbo-diff.mjs"), "--classify", a, b], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Next draft-mode keys \(allowed\):\n {2}functions\/ssr\/bundle\//);
  assert.match(r.stdout, /preview-props\.json/);
});

test("determinism-next.sh passes builds differing only in Next draft-mode keys", async () => {
  const a = await craftBundle("sh-a", draftFiles(1));
  const b = await craftBundle("sh-b", draftFiles(2));
  const { r } = run(a, b);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Next draft-mode keys \(allowed\):/);
  assert.doesNotMatch(r.stdout, /NON-DETERMINISTIC/);
});
