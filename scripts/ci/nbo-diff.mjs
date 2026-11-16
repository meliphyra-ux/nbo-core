// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// nbo-diff.mjs <a> <b>: prints every path whose digest differs between two
// .nbo/ directories, across manifest.json `digests` (and its other non-build
// fields), static.index.json `files`, prerender.json entries (by id, naming
// the fields that differ), and each function's function.json and
// bundle.index.json. Used by determinism-next.sh on a content id mismatch.
//
// nbo-diff.mjs --classify <a> <b>: applies the spec 1.0 determinism rule for
// Next.js builds (classify below). Prints `deterministic apart from build-time
// renders:` and the render paths, exit 0; or the other differing paths, exit 1;
// exit 0 when nothing differs.
//
// Importing it runs nothing: diffNbo(a, b) and classify(a, b) return results,
// and readJson, keys and same are exported for other checks over the same trees.
// Plain node only: determinism-next.sh runs it without any @nbo package.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const readJson = (dir, rel) => {
  const p = join(dir, rel);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
};
export const keys = (x, y) => [...new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])].sort();
export const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// diffNbo returns one line per differing path; [] when nothing differs.
export function diffNbo(a, b) {
  const lines = [];

  const ma = readJson(a, "manifest.json") ?? {};
  const mb = readJson(b, "manifest.json") ?? {};
  for (const k of keys(ma.digests, mb.digests)) {
    if (ma.digests?.[k] !== mb.digests?.[k]) lines.push(`manifest.json digests: ${k}`);
  }
  for (const k of keys(ma, mb)) {
    if (k === "build" || k === "digests") continue;
    if (!same(ma[k], mb[k])) lines.push(`manifest.json: ${k}`);
  }

  const sa = readJson(a, "static.index.json")?.files;
  const sb = readJson(b, "static.index.json")?.files;
  for (const k of keys(sa, sb)) {
    if (sa?.[k]?.digest !== sb?.[k]?.digest) lines.push(`static.index.json: ${k}`);
  }

  const byId = (list) => Object.fromEntries((list ?? []).map((p) => [p.id, p]));
  const pa = byId(readJson(a, "prerender.json")?.prerenders);
  const pb = byId(readJson(b, "prerender.json")?.prerenders);
  for (const id of keys(pa, pb)) {
    const fields = keys(pa[id], pb[id]).filter((k) => !same(pa[id]?.[k], pb[id]?.[k]));
    if (fields.length > 0) lines.push(`prerender.json: ${id} (${fields.join(", ")})`);
  }

  const fnNames = (dir) => (existsSync(join(dir, "functions")) ? readdirSync(join(dir, "functions")) : []);
  for (const name of [...new Set([...fnNames(a), ...fnNames(b)])].sort()) {
    const rel = `functions/${name}/function.json`;
    if (same(readJson(a, rel), readJson(b, rel))) continue;
    lines.push(rel);
    const ba = readJson(a, `functions/${name}/bundle/bundle.index.json`)?.files;
    const bb = readJson(b, `functions/${name}/bundle/bundle.index.json`)?.files;
    for (const k of keys(ba, bb)) {
      if (ba?.[k]?.digest !== bb?.[k]?.digest) lines.push(`functions/${name}/bundle/${k}`);
    }
  }
  return lines;
}

const readBytes = (dir, rel) => {
  const p = join(dir, rel);
  return existsSync(p) ? readFileSync(p) : undefined;
};
const sameBytes = (x, y) => (x === undefined || y === undefined ? x === y : x.equals(y));

// classify applies the spec 1.0 determinism rule to two builds of one commit.
// "same": the content ids are equal. "render-only": they differ only in pages
// the app rendered at build time, which are seed files in static.index.json
// (an entry whose key is a seeds file of a prerender entry in either build,
// differing only in digest and size) and x-nbo-ppr.postponedState in
// prerender.json (entries compared by id, every other field equal; a
// duplicate id is a difference). "different": anything else; otherPaths
// names it.
export function classify(a, b) {
  const renderPaths = [];
  const otherPaths = [];

  // manifest.json: equal apart from build and the two digests a render moves.
  const ma = readJson(a, "manifest.json") ?? {};
  const mb = readJson(b, "manifest.json") ?? {};
  const renderDigests = new Set(["static.index.json", "prerender.json"]);
  const movedDigests = [];
  for (const k of keys(ma.digests, mb.digests)) {
    if (ma.digests?.[k] === mb.digests?.[k]) continue;
    if (renderDigests.has(k) && ma.digests?.[k] !== undefined && mb.digests?.[k] !== undefined) movedDigests.push(k);
    else otherPaths.push(`manifest.json digests: ${k}`);
  }
  for (const k of keys(ma, mb)) {
    if (k === "build" || k === "digests") continue;
    if (!same(ma[k], mb[k])) otherPaths.push(`manifest.json: ${k}`);
  }

  // routes.json, every function.json and bundle.index.json: byte-equal.
  if (!sameBytes(readBytes(a, "routes.json"), readBytes(b, "routes.json"))) otherPaths.push("routes.json");
  const fnNames = (dir) => (existsSync(join(dir, "functions")) ? readdirSync(join(dir, "functions")) : []);
  for (const name of [...new Set([...fnNames(a), ...fnNames(b)])].sort()) {
    for (const rel of [`functions/${name}/function.json`, `functions/${name}/bundle/bundle.index.json`]) {
      if (!sameBytes(readBytes(a, rel), readBytes(b, rel))) otherPaths.push(rel);
    }
  }

  // prerender.json, compared by id (order-independent): every top-level field
  // other than prerenders is equal, no id appears twice in either build, and
  // each entry is equal once a present x-nbo-ppr.postponedState string is
  // blanked. Only then is an entry that differs a render difference.
  const pra = readJson(a, "prerender.json");
  const prb = readJson(b, "prerender.json");
  const blankEntry = (p) =>
    p &&
    typeof p === "object" &&
    p["x-nbo-ppr"] &&
    typeof p["x-nbo-ppr"] === "object" &&
    typeof p["x-nbo-ppr"].postponedState === "string"
      ? { ...p, "x-nbo-ppr": { ...p["x-nbo-ppr"], postponedState: "" } }
      : p;
  const listOf = (doc) => (Array.isArray(doc?.prerenders) ? doc.prerenders : []);
  let prerenderNamed = false;
  for (const k of keys(pra, prb)) {
    if (k === "prerenders") continue;
    if (!same(pra?.[k], prb?.[k])) {
      prerenderNamed = true;
      otherPaths.push(`prerender.json: ${k}`);
    }
  }
  if (pra !== undefined && prb !== undefined && Array.isArray(pra.prerenders) !== Array.isArray(prb.prerenders)) {
    prerenderNamed = true;
    otherPaths.push("prerender.json: prerenders");
  }
  for (const [n, doc] of [
    [1, pra],
    [2, prb],
  ]) {
    const seen = new Set();
    for (const p of listOf(doc)) {
      if (seen.has(p?.id)) {
        prerenderNamed = true;
        otherPaths.push(`prerender.json: duplicate prerender id ${JSON.stringify(p?.id)} in build ${n}`);
      }
      seen.add(p?.id);
    }
  }
  const byId = (doc) => Object.fromEntries(listOf(doc).map((p) => [p?.id, p]));
  const pa = byId(pra);
  const pb = byId(prb);
  for (const id of keys(pa, pb)) {
    if (same(pa[id], pb[id])) continue;
    prerenderNamed = true;
    const fields = keys(pa[id], pb[id]).filter((k) => !same(pa[id]?.[k], pb[id]?.[k]));
    if (pa[id] !== undefined && pb[id] !== undefined && same(blankEntry(pa[id]), blankEntry(pb[id]))) {
      renderPaths.push(`prerender.json: ${id} (x-nbo-ppr.postponedState)`);
    } else {
      otherPaths.push(`prerender.json: ${id} (${fields.join(", ")})`);
    }
  }

  // static.index.json: same keys; an entry may differ only in digest and size,
  // and only when its key is a seed file of some prerender entry.
  const seeds = new Set();
  for (const doc of [pra, prb]) {
    for (const p of Array.isArray(doc?.prerenders) ? doc.prerenders : []) {
      for (const s of Object.values(p?.seeds ?? {})) if (typeof s?.file === "string") seeds.add(s.file);
    }
  }
  const sia = readJson(a, "static.index.json");
  const sib = readJson(b, "static.index.json");
  const sa = sia?.files ?? {};
  const sb = sib?.files ?? {};
  let staticNamed = false;
  for (const k of keys(sa, sb)) {
    if (same(sa[k], sb[k])) continue;
    staticNamed = true;
    if (sa[k] === undefined || sb[k] === undefined) {
      otherPaths.push(`static.index.json: ${k} (only in build ${sa[k] === undefined ? 2 : 1})`);
      continue;
    }
    const fields = keys(sa[k], sb[k]).filter((f) => !same(sa[k][f], sb[k][f]));
    if (seeds.has(k) && fields.every((f) => f === "digest" || f === "size"))
      renderPaths.push(`static.index.json: ${k}`);
    else otherPaths.push(`static.index.json: ${k} (${fields.join(", ")})`);
  }
  for (const k of keys(sia, sib)) {
    if (k !== "files" && !same(sia?.[k], sib?.[k])) {
      staticNamed = true;
      otherPaths.push(`static.index.json: ${k}`);
    }
  }

  // A moved digest is a render difference only when everything named behind it
  // is one; with nothing named (say, the same entries written differently) or
  // with another difference in that file, it is named as a difference too.
  for (const k of movedDigests) {
    const named = k === "static.index.json" ? staticNamed : prerenderNamed;
    const prefix = k === "static.index.json" ? "static.index.json" : "prerender.json";
    if (!named || otherPaths.some((p) => p.startsWith(prefix))) otherPaths.push(`manifest.json digests: ${k}`);
  }

  const verdict = otherPaths.length > 0 ? "different" : renderPaths.length > 0 ? "render-only" : "same";
  return { verdict, renderPaths, otherPaths };
}

function main(argv) {
  if (argv[0] === "--classify") {
    const [a, b] = argv.slice(1);
    if (!a || !b) {
      console.error("usage: nbo-diff.mjs --classify <a> <b>");
      return 2;
    }
    const { verdict, renderPaths, otherPaths } = classify(a, b);
    if (verdict === "same") {
      console.log("no differences");
      return 0;
    }
    if (verdict === "render-only") {
      console.log("deterministic apart from build-time renders:");
      for (const l of renderPaths) console.log(`  ${l}`);
      return 0;
    }
    console.log("differences outside build-time renders:");
    for (const l of otherPaths) console.log(`  ${l}`);
    if (renderPaths.length > 0) {
      console.log("build-time renders (allowed on their own):");
      for (const l of renderPaths) console.log(`  ${l}`);
    }
    return 1;
  }
  const [a, b] = argv;
  if (!a || !b) {
    console.error("usage: nbo-diff.mjs [--classify] <a> <b>");
    return 2;
  }
  const lines = diffNbo(a, b);
  if (lines.length === 0) lines.push("(no differing digests found; compare the manifests by hand)");
  for (const l of lines) console.log(`  ${l}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
