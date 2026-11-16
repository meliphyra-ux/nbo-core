// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
import { canonicalize } from "@nbo/digest";
import { fileDigest } from "../digests.js";
import { validate, validateReport } from "../index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nbo-validate-pipeline-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// writeNboDir builds a minimal, well-formed .nbo dir — a TS port of
// validate_test.go's own helper of the same name, same shapes and
// field values.
function writeNboDir(dir: string): void {
  mkdirSync(join(dir, "static"), { recursive: true });
  const indexHtml = "<h1>hi</h1>";
  writeFileSync(join(dir, "static", "index.html"), indexHtml);

  const staticIndex = {
    files: {
      "/": {
        file: "index.html",
        digest: fileDigest(Buffer.from(indexHtml)),
        size: indexHtml.length,
        contentType: "text/html; charset=utf-8",
        cache: "revalidate",
      },
    },
  };
  const staticIndexBytes = Buffer.from(canonicalize(staticIndex));
  writeFileSync(join(dir, "static.index.json"), staticIndexBytes);

  const routes = { version: 1 };
  const routesBytes = Buffer.from(canonicalize(routes));
  writeFileSync(join(dir, "routes.json"), routesBytes);

  const manifest = {
    specVersion: "1.0",
    build: { id: "b_test", createdAt: "2026-10-22T00:00:00Z", framework: { name: "static" } },
    requires: { capabilities: [], extensions: [] },
    functions: [],
    digests: {
      "static.index.json": fileDigest(staticIndexBytes),
      "routes.json": fileDigest(routesBytes),
    },
  };
  writeFileSync(join(dir, "manifest.json"), canonicalize(manifest));
}

// writeValidFunctionFixture adds a minimal, schema-valid function named
// name to dir (as produced by writeNboDir), wiring its digests into
// manifest.json so the result passes validate on its own — a TS port
// of validate_test.go's own helper of the same name.
function writeValidFunctionFixture(dir: string, name: string): void {
  const bundleDir = join(dir, "functions", name, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  const entry = Buffer.from("export default { fetch() {} };");
  writeFileSync(join(bundleDir, "index.mjs"), entry);

  const bundleIndex = { files: { "index.mjs": { digest: fileDigest(entry), size: entry.length } } };
  const bundleIndexBytes = Buffer.from(canonicalize(bundleIndex));
  writeFileSync(join(bundleDir, "bundle.index.json"), bundleIndexBytes);

  const functionJSON = {
    name,
    runtime: { kind: "node" },
    handler: { style: "fetch", entry: "index.mjs", export: "default" },
    artifact: { type: "bundle", path: "bundle/", digest: fileDigest(bundleIndexBytes), files: "bundle.index.json" },
    concurrency: "multi",
  };
  const functionJSONBytes = Buffer.from(canonicalize(functionJSON));
  writeFileSync(join(dir, "functions", name, "function.json"), functionJSONBytes);

  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.functions = [name];
  manifest.digests[`functions/${name}/function.json`] = fileDigest(functionJSONBytes);
  writeFileSync(manifestPath, canonicalize(manifest));
}

describe("validate", () => {
  it("returns [] for a well-formed build", () => {
    writeNboDir(dir);
    expect(validate(dir)).toHaveLength(0);
  });

  it("returns an error naming index.html when a static file is tampered with", () => {
    writeNboDir(dir);
    writeFileSync(join(dir, "static", "index.html"), "<h1>tampered</h1>");
    const errs = validate(dir);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.message.includes("index.html"))).toBe(true);
  });

  it("refuses a manifest built for a newer spec minor and still runs the other checks", () => {
    writeNboDir(dir);
    // The manifest isn't in its own digests, so patching it leaves them valid.
    const p = join(dir, "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.specVersion = "1.1";
    writeFileSync(p, canonicalize(m));
    writeFileSync(join(dir, "static", "index.html"), "<h1>tampered</h1>");
    const messages = validate(dir).map((e) => e.message);
    expect(messages[0]).toBe(
      "manifest.json: built for NBO spec 1.1; this nbo reads spec 1.0 and older 1.x; upgrade NBO",
    );
    expect(messages.some((msg) => msg.includes("index.html"))).toBe(true);
  });

  it("returns [] for a well-formed build that also has a valid function fixture", () => {
    writeNboDir(dir);
    writeValidFunctionFixture(dir, "ssr");
    expect(validate(dir)).toHaveLength(0);
  });

  it("returns a real error, not [], when routes.json is missing", () => {
    writeNboDir(dir);
    rmSync(join(dir, "routes.json"));
    const errs = validate(dir);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.message.includes("routes.json"))).toBe(true);
  });

  it("returns a real error, not [], when static.index.json is missing", () => {
    writeNboDir(dir);
    rmSync(join(dir, "static.index.json"));
    const errs = validate(dir);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.message.includes("static.index.json"))).toBe(true);
  });

  it("returns a real error, not [], when routes.json is not valid JSON", () => {
    writeNboDir(dir);
    writeFileSync(join(dir, "routes.json"), "{not json");
    const errs = validate(dir);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.message.includes("routes.json"))).toBe(true);
  });

  it("does not throw when manifest.json parses to null", () => {
    writeNboDir(dir);
    writeFileSync(join(dir, "manifest.json"), "null");
    expect(() => validate(dir)).not.toThrow();
  });

  it("does not report every static file as unreferenced when dir is a relative path", () => {
    // Needs a temp dir on the same drive as process.cwd() — tmpdir()
    // and cwd() can be on different drives on Windows, and
    // path.relative can't produce a real relative path across drives.
    const relBase = mkdtempSync(join(process.cwd(), "tmp-validate-rel-"));
    try {
      writeNboDir(relBase);
      const relDir = relative(process.cwd(), relBase);
      expect(validate(relDir)).toHaveLength(0);
    } finally {
      rmSync(relBase, { recursive: true, force: true });
    }
  });

  describe("real fixtures (built locally — fixtures/*/.nbo is gitignored, not committed)", () => {
    const fixtures = ["static-site", "react-spa", "next-app"];
    for (const name of fixtures) {
      const fixtureDir = join(testDir, "..", "..", "..", "..", "fixtures", name, ".nbo");
      // 120s: next-app's own real traced bundle (200+ files) means a
      // full validate() pass genuinely reads and hashes that many
      // files — this is real I/O volume, not a hang.
      it(`${name}/.nbo passes the whole pipeline clean`, (ctx) => {
        if (!existsSync(fixtureDir)) {
          // .nbo/ is gitignored — a clean checkout (including CI)
          // never has it unless something built it first. Silently
          // skipping would let CI pass without ever actually
          // exercising this test; fail loudly there instead of
          // skipping, so a missing fixture is a visible build-setup
          // problem, not a silent gap in coverage.
          if (process.env.CI) {
            throw new Error(`${fixtureDir} does not exist — build this fixture before running this suite in CI`);
          }
          ctx.skip();
          return;
        }
        expect(validate(fixtureDir)).toHaveLength(0);
      }, 120000);
    }
  });
});

function patchManifest(dir: string, edit: (m: Record<string, any>) => void): void {
  const p = join(dir, "manifest.json");
  const m = JSON.parse(readFileSync(p, "utf8"));
  edit(m);
  writeFileSync(p, canonicalize(m));
}

function writePrerenderFile(dir: string, doc: unknown): void {
  const raw = Buffer.from(canonicalize(doc));
  writeFileSync(join(dir, "prerender.json"), raw);
  patchManifest(dir, (m) => {
    m.digests["prerender.json"] = fileDigest(raw);
  });
}

function writeRoutesFile(dir: string, routes: unknown): void {
  const raw = Buffer.from(canonicalize(routes));
  writeFileSync(join(dir, "routes.json"), raw);
  patchManifest(dir, (m) => {
    m.digests["routes.json"] = fileDigest(raw);
  });
}

const pprPrerender = (key: string) => ({
  version: 1,
  prerenders: [
    {
      id: "/",
      match: "^/$",
      function: "ssr",
      revalidateSec: 0,
      expireSec: 0,
      seeds: { "/": { file: "/" } },
      onMiss: "blocking",
      bypassToken: { env: "NBO_PRERENDER_BYPASS" },
      [key]: { postponedState: "state" },
    },
  ],
});

describe("validate: spec 1.0 checks", () => {
  it("refuses a non-canonical routes.json even when its digest matches", () => {
    writeNboDir(dir);
    const raw = Buffer.from('{ "version": 1 }');
    writeFileSync(join(dir, "routes.json"), raw);
    patchManifest(dir, (m) => {
      m.digests["routes.json"] = fileDigest(raw);
    });
    expect(validate(dir).map((e) => e.message)).toEqual(["routes.json: not canonical JSON (RFC 8785)"]);
  });

  it("refuses a non-canonical manifest.json", () => {
    writeNboDir(dir);
    const p = join(dir, "manifest.json");
    writeFileSync(p, JSON.stringify(JSON.parse(readFileSync(p, "utf8")), null, 2));
    expect(validate(dir).map((e) => e.message)).toEqual(["manifest.json: not canonical JSON (RFC 8785)"]);
  });

  it("checks prerender.json: a digest-less file fails", () => {
    writeNboDir(dir);
    writeValidFunctionFixture(dir, "ssr");
    writeFileSync(join(dir, "prerender.json"), canonicalize(pprPrerender("x-nbo-ppr")));
    expect(validate(dir).map((e) => e.message)).toContain(
      "prerender.json: present, but manifest.json digests has no entry for it",
    );
  });

  it("refuses an undeclared x-nbo-pp on a prerender config (Review Focus 3)", () => {
    writeNboDir(dir);
    writeValidFunctionFixture(dir, "ssr");
    writePrerenderFile(dir, pprPrerender("x-nbo-pp"));
    patchManifest(dir, (m) => {
      m.requires.extensions = [{ id: "x-nbo-ppr", version: "1", critical: true }];
    });
    expect(validate(dir).map((e) => e.message)).toEqual([
      'prerender.json: prerenders[0]: extension key "x-nbo-pp" is not declared in requires.extensions',
    ]);
  });

  it("accepts a declared x-nbo-ppr prerender and a declared non-critical x-acme-tag on a route rule", () => {
    writeNboDir(dir);
    writeValidFunctionFixture(dir, "ssr");
    writePrerenderFile(dir, pprPrerender("x-nbo-ppr"));
    writeRoutesFile(dir, {
      version: 1,
      afterFiles: [
        { id: "r", match: { path: "^/api" }, action: { type: "rewrite", function: "ssr" }, "x-acme-tag": "blue" },
      ],
    });
    patchManifest(dir, (m) => {
      m.requires.extensions = [
        { id: "x-nbo-ppr", version: "1", critical: true },
        { id: "x-acme-tag", version: "1", critical: false },
      ];
    });
    expect(validate(dir).map((e) => e.message)).toEqual([]);
  });

  it("reports a rewrite to an undeclared function", () => {
    writeNboDir(dir);
    writeRoutesFile(dir, {
      version: 1,
      afterFiles: [{ id: "r", match: { path: "^/api" }, action: { type: "rewrite", function: "ssr" } }],
    });
    expect(validate(dir).map((e) => e.message)).toEqual([
      'routes.json: rule "r": function "ssr" is not declared in manifest functions',
    ]);
  });

  it("accepts an unlisted dispatch.json at a bundle root and refuses an unlisted extra.js (Review Focus 1)", () => {
    writeNboDir(dir);
    writeValidFunctionFixture(dir, "ssr");
    writeFileSync(join(dir, "functions", "ssr", "bundle", "dispatch.json"), '{"routes":{}}');
    expect(validate(dir).map((e) => e.message)).toEqual([]);
    writeFileSync(join(dir, "functions", "ssr", "bundle", "extra.js"), "1");
    expect(validate(dir).map((e) => e.message)).toEqual([
      "functions/ssr/bundle/extra.js: not listed in bundle.index.json",
    ]);
  });

  it("checks function names before joining them into paths, so nothing outside .nbo/ is read", () => {
    const nbo = join(dir, "app", ".nbo");
    writeNboDir(nbo);
    // Each name, joined unchecked onto functions/, lands on a file
    // holding a secret: "../x" inside .nbo/ but outside functions/,
    // "../../x" outside .nbo/ altogether.
    const secretFn = Buffer.from(JSON.stringify({ name: "x", note: "AKIAABCDEFGHIJKLMNOP" }));
    for (const target of [join(nbo, "x"), join(dir, "app", "x")]) {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "function.json"), secretFn);
    }
    patchManifest(nbo, (m) => {
      m.functions = ["../x", "../../x"];
    });
    const messages = validate(nbo)
      .map((e) => e.message)
      .filter((msg) => !msg.startsWith("manifest.json: schema validation failed"));
    expect(messages).toEqual([
      'manifest.json: function name "../x" is not valid (lowercase letters, digits and hyphens, starting with a letter, at most 63 characters)',
      'manifest.json: function name "../../x" is not valid (lowercase letters, digits and hyphens, starting with a letter, at most 63 characters)',
    ]);
  });

  it("refuses a bad cron schedule", () => {
    writeNboDir(dir);
    writeValidFunctionFixture(dir, "ssr");
    patchManifest(dir, (m) => {
      m.crons = [
        {
          id: "c",
          schedule: "0-5 * * * *",
          timezone: "UTC",
          target: { function: "ssr", path: "/api/cron", method: "GET" },
        },
      ];
    });
    const messages = validate(dir).map((e) => e.message);
    expect(messages.some((msg) => msg.startsWith('manifest.json: crons: cron "c": schedule "0-5 * * * *"'))).toBe(true);
  });
});

describe("validate: warnings for stored builds", () => {
  function addNboStaticKey(dir: string): void {
    const p = join(dir, "static.index.json");
    const si = JSON.parse(readFileSync(p, "utf8"));
    si.files["/_nbo/x"] = { ...si.files["/"] };
    const raw = Buffer.from(canonicalize(si));
    writeFileSync(p, raw);
    patchManifest(dir, (m) => {
      m.digests["static.index.json"] = fileDigest(raw);
    });
  }
  const msg = 'static.index.json: "/_nbo/x": paths under /_nbo/ are reserved for the platform';

  it("reports a static key under /_nbo/ as a warning, so a stored build keeps validating", () => {
    writeNboDir(dir);
    addNboStaticKey(dir);
    expect(validate(dir)).toEqual([]);
    const report = validateReport(dir);
    expect(report.errors).toEqual([]);
    expect(report.warnings.map((e) => e.message)).toEqual([msg]);
  });

  it("reports an unlisted dispatch.json at a bundle root as a warning, and refuses it under strict", () => {
    writeNboDir(dir);
    writeValidFunctionFixture(dir, "ssr");
    writeFileSync(join(dir, "functions", "ssr", "bundle", "dispatch.json"), '{"routes":{}}');
    const dispatchMsg =
      "functions/ssr/bundle/dispatch.json: not listed in bundle.index.json (accepted only for builds made before spec 1.0 final)";
    const report = validateReport(dir);
    expect(report.errors).toEqual([]);
    expect(report.warnings.map((e) => e.message)).toEqual([dispatchMsg]);
    expect(validate(dir, { strict: true }).map((e) => e.message)).toEqual([dispatchMsg]);
  });

  it("refuses it under strict, which producers' own tests use", () => {
    writeNboDir(dir);
    addNboStaticKey(dir);
    expect(validate(dir, { strict: true }).map((e) => e.message)).toEqual([msg]);
    const report = validateReport(dir, { strict: true });
    expect(report.errors.map((e) => e.message)).toEqual([msg]);
    expect(report.warnings).toEqual([]);
  });
});

describe("validate: core files must be in manifest.digests (final review I1)", () => {
  it("refuses a manifest with no routes.json or static.index.json digest, even when the files are valid", () => {
    writeNboDir(dir);
    patchManifest(dir, (m) => {
      delete m.digests["routes.json"];
      delete m.digests["static.index.json"];
    });
    const messages = validate(dir).map((e) => e.message);
    expect(messages).toContain("routes.json: manifest.json digests has no entry for it");
    expect(messages).toContain("static.index.json: manifest.json digests has no entry for it");
  });

  it("refuses a manifest with no digest for a listed function's function.json", () => {
    writeNboDir(dir);
    writeValidFunctionFixture(dir, "ssr");
    patchManifest(dir, (m) => {
      delete m.digests["functions/ssr/function.json"];
    });
    expect(validate(dir).map((e) => e.message)).toContain(
      "functions/ssr/function.json: manifest.json digests has no entry for it",
    );
  });

  it("refuses a manifest with no digests block at all", () => {
    writeNboDir(dir);
    patchManifest(dir, (m) => {
      delete m.digests;
    });
    const messages = validate(dir).map((e) => e.message);
    expect(messages).toContain("routes.json: manifest.json digests has no entry for it");
    expect(messages).toContain("static.index.json: manifest.json digests has no entry for it");
  });
});

describe("validate: duplicate prerender ids (final review I2)", () => {
  const entry = (revalidateSec: number) => ({
    id: "/p",
    match: "^/p$",
    function: "ssr",
    revalidateSec,
    expireSec: 0,
    seeds: {},
    onMiss: "blocking",
    bypassToken: { env: "NBO_PRERENDER_BYPASS" },
  });
  const dupMsg = 'prerender.json: duplicate prerender id "/p"';

  it("reports a duplicate id as a warning (a Next adapter before 53e7b6e wrote them) and refuses it under strict", () => {
    writeNboDir(dir);
    writeValidFunctionFixture(dir, "ssr");
    writePrerenderFile(dir, { version: 1, prerenders: [entry(0), entry(60)] });
    const report = validateReport(dir);
    expect(report.errors).toEqual([]);
    expect(report.warnings.map((e) => e.message)).toEqual([dupMsg]);
    expect(validate(dir, { strict: true }).map((e) => e.message)).toEqual([dupMsg]);
  });
});
