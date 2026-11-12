#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich
// Repository docs check: links, repo paths, server settings and the API table.
// Usage: node scripts/docs/check-docs.mjs [--root <dir>] [--only links,paths,env,api]
// Each finding is one line: docs: <check>: <file>:<line>: <problem>. Exit 0 or 1.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Checks still being finished. Each change removes its entry in the commit that finishes it; an empty
// pair means the gate is fully strict.
// A pending check still runs, but its findings only print to stderr unless the
// check is named with --only. A default run also fails on a pending entry that
// has no findings left ("remove it"), so the lists can only shrink.
export const PENDING_CHECKS = {
};
// Findings in these files print to stderr as pending and do not fail the run
// (under --only too, so the Task 2 gate holds).
export const PENDING_FILES = {
};

// The core manual. Chapters link to each other as ./<slug>.md#<heading-id>.
const CHAPTERS = "docs/manual";
const SETTINGS_CHAPTER = `${CHAPTERS}/server-settings.md`;
const ALLOWLIST = "scripts/docs/env-allowlist.json";
const ACCESS = "packages/controlplane/src/access.ts";
// The architecture tour and API reference (an HTML page with the API rows).
const ARCHITECTURE = "docs/architecture/index.html";
const TOP_DIRS = ["packages", "docs", "scripts", "spec", "fixtures", "cmd", "internal", "router", "adapters"]; // last four: the removed Go tree, so stale citations are caught

const splitLines = (text) => text.split(/\r?\n/);
const rel = (root, p) => relative(root, p).split(sep).join("/");
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

function listFiles(dir, filter) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "target") continue;
      out.push(...listFiles(p, filter));
    } else if (filter(p)) out.push(p);
  }
  return out;
}

// The prose set: README, four docs files, the chapters and the architecture page.
// Roadmap, points, ADRs, plans and the spec are history or contract, not scanned.
function docFiles(root) {
  const md = ["README.md", "docs/local-dev.md", "docs/ci.md", "docs/production.md", "docs/context.md"]
    .map((f) => join(root, f))
    .filter(existsSync);
  const chapters = listFiles(join(root, CHAPTERS), (p) => p.endsWith(".md") && !p.includes("__tests__"));
  const html = listFiles(join(root, dirname(ARCHITECTURE)), (p) => p.endsWith(".html"));
  return { md: [...md, ...chapters], html };
}

// Markdown lines outside fences with inline code blanked (same length, so
// columns stay), as [lineNumber, text] pairs. Backtick text is kept separately.
function proseLines(text) {
  const out = [];
  let fence = null;
  splitLines(text).forEach((line, i) => {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    out.push([i + 1, line]);
  });
  return out;
}

const blankCode = (line) => line.replace(/`[^`]*`/g, (s) => " ".repeat(s.length));
const SKIP_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/|#|\{)/i;

// Heading anchors as GitHub makes them: inline code, emphasis and link
// targets dropped, lower case, punctuation removed, spaces to hyphens, a
// repeated heading gets -1, -2. HTML id="..." attributes count too.
export function githubSlug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

const anchorCache = new Map();
function anchorsOf(file) {
  let set = anchorCache.get(file);
  if (set) return set;
  set = new Set();
  const counts = new Map();
  for (const [, line] of proseLines(readFileSync(file, "utf8"))) {
    const h = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (h) {
      const base = githubSlug(h[1]);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      set.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const m of line.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) set.add(m[1]);
  }
  anchorCache.set(file, set);
  return set;
}

export async function checkLinks(root) {
  anchorCache.clear();
  const findings = [];
  const add = (file, line, problem) => findings.push({ check: "links", file: rel(root, file), line, problem });
  const { md, html } = docFiles(root);
  for (const file of md) {
    for (const [line, raw] of proseLines(readFileSync(file, "utf8"))) {
      const text = blankCode(raw);
      for (const m of text.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        const target = m[1];
        // The old in-app form: core has no /docs pages, so the link goes nowhere.
        if (/^\/docs(?:[/#?]|$)/.test(target)) {
          add(file, line, `in-app link ${target}: use a relative link such as ./manual/<slug>.md or ./<slug>.md`);
          continue;
        }
        if (target.startsWith("#")) {
          if (target.length > 1 && !anchorsOf(file).has(target.slice(1))) add(file, line, `anchor not found: ${target}`);
          continue;
        }
        if (SKIP_TARGET.test(target)) continue;
        const path = target.split("#")[0].split("?")[0];
        if (!path) continue;
        let decoded;
        try {
          decoded = decodeURIComponent(path);
        } catch {
          add(file, line, `link target is not valid URL encoding: ${target}`);
          continue;
        }
        const dest = resolve(dirname(file), decoded);
        if (!existsSync(dest)) {
          add(file, line, `link target not found: ${target}`);
          continue;
        }
        const hash = target.includes("#") ? target.slice(target.indexOf("#") + 1) : "";
        if (hash && dest.endsWith(".md") && !anchorsOf(dest).has(hash)) add(file, line, `anchor not found: ${target}`);
      }
    }
  }
  for (const file of html) {
    const text = readFileSync(file, "utf8");
    const ids = new Set([...text.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
    splitLines(text).forEach((raw, i) => {
      for (const m of raw.matchAll(/\bhref\s*=\s*["']([^"']*)["']/g)) {
        const target = m[1];
        if (target === "" || /^(?:[a-z][a-z0-9+.-]*:|\/|\{)/i.test(target)) continue;
        if (target.startsWith("#")) {
          if (target.length > 1 && !ids.has(target.slice(1))) add(file, i + 1, `anchor not found in this page: ${target}`);
          continue;
        }
        const path = target.split("#")[0].split("?")[0];
        if (path && !existsSync(resolve(dirname(file), path))) add(file, i + 1, `link target not found: ${target}`);
      }
    });
  }
  return findings;
}

export async function checkPaths(root) {
  const findings = [];
  const { md, html } = docFiles(root);
  const seen = new Set();
  const re = new RegExp(`^(?:${TOP_DIRS.join("|")})/[\\w.@/-]+$`);
  const test = (file, line, token) => {
    const tok = token.trim().replace(/:\d+(?:-\d+)?$/, "");
    if (!re.test(tok) || tok.includes("..")) return;
    if (existsSync(join(root, tok))) return;
    const key = `${file}:${line}:${tok}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ check: "paths", file: rel(root, file), line, problem: `path not found: ${tok}` });
  };
  for (const file of md) {
    for (const [line, raw] of proseLines(readFileSync(file, "utf8"))) {
      for (const m of raw.matchAll(/`([^`\n]+)`/g)) test(file, line, m[1]);
    }
  }
  for (const file of html) {
    splitLines(readFileSync(file, "utf8")).forEach((raw, i) => {
      for (const m of raw.matchAll(/<code[^>]*>([^<]+)<\/code>/g)) test(file, i + 1, m[1]);
    });
  }
  return findings;
}

export async function checkEnv(root) {
  const findings = [];
  const sources = [];
  for (const pkg of ["controlplane", "edge", "serve", "cli"]) {
    sources.push(...listFiles(join(root, "packages", pkg, "src"), (p) => p.endsWith(".ts") && !/__tests__|\.test\.ts$/.test(p)));
  }
  sources.push(...listFiles(join(root, "packages", "edge-rs", "src"), (p) => p.endsWith(".rs")));
  for (const f of ["compose.yaml", "compose.public.yaml", "Dockerfile"]) if (existsSync(join(root, f))) sources.push(join(root, f));

  const chapter = readIf(join(root, SETTINGS_CHAPTER));
  const allow = readIf(join(root, ALLOWLIST));
  let allowed;
  try {
    allowed = new Set(allow ? Object.keys(JSON.parse(allow)) : []);
  } catch (e) {
    return [{ check: "env", file: ALLOWLIST, line: 1, problem: `not valid JSON: ${e.message}` }];
  }
  const documented = new Set(chapter ? [...chapter.matchAll(/\bNBO_[A-Z0-9_]+/g)].map((m) => m[0]) : []);

  const first = new Map();
  for (const file of sources) {
    splitLines(readFileSync(file, "utf8")).forEach((text, i) => {
      if (/NBO_\$\{/.test(text)) {
        findings.push({ check: "env", file: rel(root, file), line: i + 1, problem: "dynamic name (NBO_${...}): list the names it can build in the allowlist or the chapter" });
      }
      for (const m of text.matchAll(/\bNBO_[A-Z0-9_]+/g)) {
        if (m[0].endsWith("_")) continue;
        if (!first.has(m[0])) first.set(m[0], { file: rel(root, file), line: i + 1 });
      }
    });
  }
  if (!chapter) {
    findings.push({ check: "env", file: SETTINGS_CHAPTER, line: 1, problem: `${SETTINGS_CHAPTER} does not exist yet, so no server setting is documented` });
    return findings;
  }
  for (const [name, at] of [...first].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (documented.has(name) || allowed.has(name)) continue;
    findings.push({ check: "env", file: at.file, line: at.line, problem: `${name} is in neither ${SETTINGS_CHAPTER} nor ${ALLOWLIST}` });
  }
  return findings;
}

const normalise = (p) => p.replace(/\{[^}]+\}/g, "{}");

// A page row: [method, path, what it does, service, access, group]. Short
// rows ([method, path]) only count as present. Only control-plane rows are checked
// against access.ts; the edge admin and edge public rows are not checked
// (both edges match those few paths by hand, with no table to read).
const API_ROW = /\["(GET|POST|PUT|PATCH|DELETE)",\s*"([^"]+)"(?:,\s*"(?:[^"\\]|\\.)*",\s*"([^"]*)",\s*"([^"]*)")?/g;

export async function checkApi(root) {
  const access = readIf(join(root, ACCESS));
  const page = readIf(join(root, ARCHITECTURE));
  if (access === null) return [{ check: "api", file: ACCESS, line: 1, problem: "file not found" }];
  if (page === null) return [{ check: "api", file: ARCHITECTURE, line: 1, problem: "file not found" }];
  const routes = new Map();
  splitLines(access).forEach((text, i) => {
    const m = /^\s+"(GET|POST|PUT|PATCH|DELETE) ([^"]+)":\s*"([^"]*)"/.exec(text);
    if (m) routes.set(`${m[1]} ${normalise(m[2])}`, { route: `${m[1]} ${m[2]}`, access: m[3], line: i + 1 });
  });
  const findings = [];
  const rows = new Set();
  for (const m of page.matchAll(API_ROW)) {
    const key = `${m[1]} ${normalise(m[2].split("?")[0])}`;
    rows.add(key);
    if (m[3] !== "control-plane") continue;
    const line = page.slice(0, m.index).split("\n").length;
    const route = routes.get(key);
    if (!route) {
      findings.push({ check: "api", file: ARCHITECTURE, line, problem: `${m[1]} ${m[2]} has no route in ${ACCESS}: remove the row` });
    } else if (m[4] !== route.access) {
      findings.push({ check: "api", file: ARCHITECTURE, line, problem: `${m[1]} ${m[2]} says access "${m[4]}", ${ACCESS} says "${route.access}"` });
    }
  }
  for (const [key, r] of routes) {
    if (!rows.has(key)) findings.push({ check: "api", file: ACCESS, line: r.line, problem: `${r.route} has no row in ${ARCHITECTURE}` });
  }
  return findings;
}

const CHECKS = { links: checkLinks, paths: checkPaths, env: checkEnv, api: checkApi };
const line = (f) => `docs: ${f.check}: ${f.file}:${f.line}: ${f.problem}`;

// opts.pendingFiles and opts.pendingChecks let a test supply its own pending lists; the CLI uses PENDING_FILES and PENDING_CHECKS.
export async function main(argv, { pendingFiles = PENDING_FILES, pendingChecks = PENDING_CHECKS } = {}) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  let only = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = resolve(argv[++i] ?? "");
    else if (argv[i] === "--only") {
      only = (argv[++i] ?? "").split(",").filter(Boolean);
      if (!only.length) {
        console.error("docs: --only needs at least one check (links, paths, env, api)");
        return 1;
      }
    }
    else {
      console.error(`docs: unknown argument ${argv[i]}`);
      return 1;
    }
  }
  const names = only ?? Object.keys(CHECKS);
  for (const n of names) {
    if (!CHECKS[n]) {
      console.error(`docs: unknown check ${n} (links, paths, env, api)`);
      return 1;
    }
  }
  let failed = 0;
  const fileHits = new Set();
  const checkHits = new Set();
  for (const n of names) {
    const findings = await CHECKS[n](root);
    const checkPending = !only && pendingChecks[n];
    if (findings.length) checkHits.add(n);
    for (const f of findings) {
      fileHits.add(f.file);
      if (checkPending) console.error(`${line(f)} [pending: ${pendingChecks[n]}]`);
      else if (pendingFiles[f.file]) console.error(`${line(f)} [pending: ${pendingFiles[f.file]}]`);
      else {
        console.log(line(f));
        failed++;
      }
    }
  }
  if (!only) {
    for (const k of Object.keys(pendingChecks)) {
      if (!checkHits.has(k)) {
        console.log(`docs: pending: check ${k} has no findings, remove it`);
        failed++;
      }
    }
    for (const k of Object.keys(pendingFiles)) {
      if (!fileHits.has(k)) {
        console.log(`docs: pending: ${k} has no findings, remove it`);
        failed++;
      }
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
