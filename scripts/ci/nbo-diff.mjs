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
// renders:` and the render paths (and, under `Next draft-mode keys (allowed):`,
// the draft-mode key files and what they move), exit 0; or the other differing
// paths, exit 1; exit 0 when nothing differs.
//
// Importing it runs nothing: diffNbo(a, b) and classify(a, b) return results,
// and readJson, keys and same are exported for other checks over the same trees.
// Plain node only: determinism-next.sh runs it without any @nbo package.
import { createHash } from "node:crypto";
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

// bundleDetail lists, per function, the bundle entries that differ between two builds: only in build 1, only in
// build 2, or contents differ. At most `limit` lines per function, then "... and N more". A determinism failure
// on CI prints these, so the log says which files made two builds differ.
export function bundleDetail(a, b, limit = 30) {
  const lines = [];
  const fnNames = (dir) => (existsSync(join(dir, "functions")) ? readdirSync(join(dir, "functions")) : []);
  for (const name of [...new Set([...fnNames(a), ...fnNames(b)])].sort()) {
    const fa = readJson(a, `functions/${name}/bundle/bundle.index.json`)?.files ?? {};
    const fb = readJson(b, `functions/${name}/bundle/bundle.index.json`)?.files ?? {};
    const diffs = [];
    for (const k of keys(fa, fb)) {
      if (!(k in fb)) diffs.push(`${k} (only in build 1)`);
      else if (!(k in fa)) diffs.push(`${k} (only in build 2)`);
      else if (fa[k]?.digest !== fb[k]?.digest) diffs.push(`${k} (contents differ)`);
    }
    const where = `functions/${name}/bundle`;
    for (const d of diffs.slice(0, limit)) lines.push(`${where}: ${d}`);
    if (diffs.length > limit) lines.push(`${where}: ... and ${diffs.length - limit} more`);
  }
  return lines;
}

const readBytes = (dir, rel) => {
  const p = join(dir, rel);
  return existsSync(p) ? readFileSync(p) : undefined;
};
const sameBytes = (x, y) => (x === undefined || y === undefined ? x === y : x.equals(y));
const sha256 = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

// Next.js's draft-mode keys. Inside a container Next keeps no key cache and makes new ones on every build, with no
// way to supply them, so a function bundle entry may differ in these keys alone: preview-props.json, and the
// preview object of prerender-manifest.json.
const DRAFT_KEYS = ["previewModeId", "previewModeSigningKey", "previewModeEncryptionKey"];
const blankDraftKeys = (o) =>
  o && typeof o === "object" && !Array.isArray(o)
    ? { ...o, ...Object.fromEntries(DRAFT_KEYS.filter((k) => k in o).map((k) => [k, ""])) }
    : o;
const DRAFT_KEY_FILES = {
  ".next/server/preview-props.json": (doc) => blankDraftKeys(doc),
  ".next/prerender-manifest.json": (doc) =>
    doc && typeof doc === "object" && !Array.isArray(doc) && "preview" in doc
      ? { ...doc, preview: blankDraftKeys(doc.preview) }
      : doc,
};

// draftKeyEntries returns the bundle entries of function `name` that differ between two builds when each of them
// differs only in Next's draft-mode keys, and function.json differs only in its bundle's digest (each build's
// digest matching its own bundle.index.json bytes); otherwise null.
function draftKeyEntries(a, b, name) {
  const fjRel = `functions/${name}/function.json`;
  const biRel = `functions/${name}/bundle/bundle.index.json`;
  const fja = readJson(a, fjRel);
  const fjb = readJson(b, fjRel);
  const bia = readBytes(a, biRel);
  const bib = readBytes(b, biRel);
  if (!fja || !fjb || !bia || !bib) return null;
  if (fja.artifact?.digest !== sha256(bia) || fjb.artifact?.digest !== sha256(bib)) return null;
  const blankFn = (fj) => ({ ...fj, artifact: { ...fj.artifact, digest: "" } });
  if (!same(blankFn(fja), blankFn(fjb))) return null;
  const ia = JSON.parse(bia.toString("utf8"));
  const ib = JSON.parse(bib.toString("utf8"));
  if (keys(ia, ib).some((k) => k !== "files" && !same(ia[k], ib[k]))) return null;
  const entries = [];
  for (const k of keys(ia.files, ib.files)) {
    if (same(ia.files?.[k], ib.files?.[k])) continue;
    const blank = Object.hasOwn(DRAFT_KEY_FILES, k) ? DRAFT_KEY_FILES[k] : undefined;
    if (!blank || ia.files?.[k] === undefined || ib.files?.[k] === undefined) return null;
    const rel = `functions/${name}/bundle/${k}`;
    const ra = readBytes(a, rel);
    const rb = readBytes(b, rel);
    if (!ra || !rb || sha256(ra) !== ia.files[k].digest || sha256(rb) !== ib.files[k].digest) return null;
    let da, db;
    try {
      da = JSON.parse(ra.toString("utf8"));
      db = JSON.parse(rb.toString("utf8"));
    } catch {
      return null;
    }
    if (!same(blank(da), blank(db))) return null;
    entries.push(rel);
  }
  return entries.length > 0 ? entries : null;
}

// classify applies the spec 1.0 determinism rule to two builds of one commit.
// "same": the content ids are equal. "render-only": they differ only in pages
// the app rendered at build time, which are seed files in static.index.json
// (an entry whose key is a seeds file of a prerender entry in either build,
// differing only in digest and size) and x-nbo-ppr.postponedState in
// prerender.json (entries compared by id, every other field equal; a
// duplicate id is a difference), or in Next.js's draft-mode keys (a
// function bundle's preview-props.json and prerender-manifest.json preview
// keys, plus the function.json, bundle.index.json and manifest digest they
// move; draftKeyPaths names them). "different": anything else; otherPaths
// names it.
export function classify(a, b) {
  const renderPaths = [];
  const otherPaths = [];
  const draftKeyPaths = [];

  // routes.json, every function.json and bundle.index.json: byte-equal, or a
  // function whose bundle differs only in Next's draft-mode keys.
  const draftMoved = new Set();
  if (!sameBytes(readBytes(a, "routes.json"), readBytes(b, "routes.json"))) otherPaths.push("routes.json");
  const fnNames = (dir) => (existsSync(join(dir, "functions")) ? readdirSync(join(dir, "functions")) : []);
  for (const name of [...new Set([...fnNames(a), ...fnNames(b)])].sort()) {
    const rels = [`functions/${name}/function.json`, `functions/${name}/bundle/bundle.index.json`];
    const differing = rels.filter((rel) => !sameBytes(readBytes(a, rel), readBytes(b, rel)));
    if (differing.length === 0) continue;
    const draft = draftKeyEntries(a, b, name);
    if (draft) {
      draftKeyPaths.push(...draft, ...differing.map((rel) => `${rel} (derived)`));
      draftMoved.add(rels[0]);
    } else {
      otherPaths.push(...differing);
    }
  }

  // manifest.json: equal apart from build, the two digests a render moves and
  // the function.json digests draft-mode keys move.
  const ma = readJson(a, "manifest.json") ?? {};
  const mb = readJson(b, "manifest.json") ?? {};
  const renderDigests = new Set(["static.index.json", "prerender.json"]);
  const movedDigests = [];
  for (const k of keys(ma.digests, mb.digests)) {
    if (ma.digests?.[k] === mb.digests?.[k]) continue;
    const both = ma.digests?.[k] !== undefined && mb.digests?.[k] !== undefined;
    if (renderDigests.has(k) && both) movedDigests.push(k);
    else if (draftMoved.has(k) && both) draftKeyPaths.push(`manifest.json digests: ${k} (derived)`);
    else otherPaths.push(`manifest.json digests: ${k}`);
  }
  for (const k of keys(ma, mb)) {
    if (k === "build" || k === "digests") continue;
    if (!same(ma[k], mb[k])) otherPaths.push(`manifest.json: ${k}`);
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

  const verdict =
    otherPaths.length > 0 ? "different" : renderPaths.length + draftKeyPaths.length > 0 ? "render-only" : "same";
  return { verdict, renderPaths, otherPaths, draftKeyPaths };
}

function main(argv) {
  if (argv[0] === "--classify") {
    const [a, b] = argv.slice(1);
    if (!a || !b) {
      console.error("usage: nbo-diff.mjs --classify <a> <b>");
      return 2;
    }
    const { verdict, renderPaths, otherPaths, draftKeyPaths } = classify(a, b);
    const printDraftKeys = () => {
      if (draftKeyPaths.length === 0) return;
      console.log("Next draft-mode keys (allowed):");
      for (const l of draftKeyPaths) console.log(`  ${l}`);
    };
    if (verdict === "same") {
      console.log("no differences");
      return 0;
    }
    if (verdict === "render-only") {
      console.log("deterministic apart from build-time renders:");
      for (const l of renderPaths) console.log(`  ${l}`);
      printDraftKeys();
      return 0;
    }
    console.log("differences outside build-time renders:");
    for (const l of otherPaths) console.log(`  ${l}`);
    const detail = bundleDetail(a, b);
    if (detail.length > 0) {
      console.log("bundle entries that differ:");
      for (const l of detail) console.log(`  ${l}`);
    }
    if (renderPaths.length > 0) {
      console.log("build-time renders (allowed on their own):");
      for (const l of renderPaths) console.log(`  ${l}`);
    }
    printDraftKeys();
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
