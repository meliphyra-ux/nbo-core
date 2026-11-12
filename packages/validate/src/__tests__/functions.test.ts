// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "@nbo/digest";
import { fileDigest } from "../digests.js";
import { resolveBundlePath, validateFunction } from "../functions.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nbo-validate-fn-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// writeValidFunctionFixture adds a minimal, schema-valid function named
// name to dir, wiring its digests so validateFunction passes on it by
// itself — port of validate_test.go's own helper of the same name.
function writeValidFunctionFixture(dir: string, name: string): Record<string, unknown> {
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

  return { [`functions/${name}/function.json`]: fileDigest(functionJSONBytes) };
}

describe("validateFunction", () => {
  it("returns no errors for a correctly-built function fixture", () => {
    const manifestDigests = writeValidFunctionFixture(dir, "ssr");
    expect(validateFunction(dir, "ssr", manifestDigests)).toHaveLength(0);
  });

  it("returns an error when a bundle file's on-disk content doesn't match its declared digest", () => {
    const manifestDigests = writeValidFunctionFixture(dir, "ssr");
    writeFileSync(join(dir, "functions", "ssr", "bundle", "index.mjs"), "tampered");
    expect(validateFunction(dir, "ssr", manifestDigests).length).toBeGreaterThan(0);
  });

  it("returns an error when function.json doesn't match manifestDigests's declared digest for it", () => {
    const manifestDigests = writeValidFunctionFixture(dir, "ssr");
    const fnPath = join(dir, "functions", "ssr", "function.json");
    writeFileSync(fnPath, Buffer.concat([readFileSync(fnPath), Buffer.from(" ")]));
    expect(validateFunction(dir, "ssr", manifestDigests).length).toBeGreaterThan(0);
  });
});

describe("validateFunction malformed input", () => {
  it("does not throw when function.json is not valid JSON", () => {
    writeValidFunctionFixture(dir, "ssr");
    writeFileSync(join(dir, "functions", "ssr", "function.json"), "{not json");
    expect(() => validateFunction(dir, "ssr", {})).not.toThrow();
  });

  it("does not throw when bundle.index.json is not valid JSON", () => {
    writeValidFunctionFixture(dir, "ssr");
    writeFileSync(join(dir, "functions", "ssr", "bundle", "bundle.index.json"), "{not json");
    expect(() => validateFunction(dir, "ssr", {})).not.toThrow();
  });

  it("returns early without reading bundle.index.json when artifact is missing", () => {
    writeValidFunctionFixture(dir, "ssr");
    const fnPath = join(dir, "functions", "ssr", "function.json");
    const fn = JSON.parse(readFileSync(fnPath, "utf8"));
    delete fn.artifact;
    writeFileSync(fnPath, canonicalize(fn));
    const errs = validateFunction(dir, "ssr", {});
    expect(errs.some((e) => e.message.includes("artifact"))).toBe(true);
  });
});

describe("resolveBundlePath", () => {
  it("rejects a bundle-relative path that climbs out via ..", () => {
    expect(resolveBundlePath(dir, "ssr", "../../../etc/passwd")).toEqual({ ok: false });
  });

  it("resolves an ordinary bundle-relative path", () => {
    const result = resolveBundlePath(dir, "ssr", "index.mjs");
    expect(result).toEqual({ ok: true, path: expect.stringContaining("bundle") });
  });
});

describe("validateFunction layout", () => {
  it("accepts an unlisted dispatch.json at the bundle root (builds from before 1.0 final)", () => {
    const manifestDigests = writeValidFunctionFixture(dir, "ssr");
    writeFileSync(join(dir, "functions", "ssr", "bundle", "dispatch.json"), '{"routes":{}}');
    expect(validateFunction(dir, "ssr", manifestDigests)).toEqual([]);
  });

  it("refuses an unlisted extra.js", () => {
    const manifestDigests = writeValidFunctionFixture(dir, "ssr");
    writeFileSync(join(dir, "functions", "ssr", "bundle", "extra.js"), "1");
    expect(validateFunction(dir, "ssr", manifestDigests).map((e) => e.message)).toEqual([
      "functions/ssr/bundle/extra.js: not listed in bundle.index.json",
    ]);
  });

  it("refuses an unlisted dispatch.json below the bundle root", () => {
    const manifestDigests = writeValidFunctionFixture(dir, "ssr");
    mkdirSync(join(dir, "functions", "ssr", "bundle", "sub"));
    writeFileSync(join(dir, "functions", "ssr", "bundle", "sub", "dispatch.json"), "{}");
    expect(validateFunction(dir, "ssr", manifestDigests).map((e) => e.message)).toEqual([
      "functions/ssr/bundle/sub/dispatch.json: not listed in bundle.index.json",
    ]);
  });

  it("refuses a symlink under bundle/", (ctx) => {
    const manifestDigests = writeValidFunctionFixture(dir, "ssr");
    try {
      symlinkSync(join(dir, "functions", "ssr", "bundle", "index.mjs"), join(dir, "functions", "ssr", "bundle", "link.mjs"), "file");
    } catch {
      ctx.skip(); // Windows without the symlink privilege
      return;
    }
    expect(validateFunction(dir, "ssr", manifestDigests).map((e) => e.message)).toEqual([
      "functions/ssr/bundle/link.mjs: not a regular file",
    ]);
  });

  it("refuses a function.json whose name doesn't match its folder", () => {
    writeValidFunctionFixture(dir, "ssr");
    const fnPath = join(dir, "functions", "ssr", "function.json");
    const fn = JSON.parse(readFileSync(fnPath, "utf8"));
    fn.name = "other";
    writeFileSync(fnPath, canonicalize(fn));
    expect(validateFunction(dir, "ssr", { "functions/ssr/function.json": fileDigest(readFileSync(fnPath)) }).map((e) => e.message)).toEqual(['functions/ssr/function.json: name "other" does not match its folder']);
  });

  it("refuses a function.json that manifest.digests doesn't name", () => {
    writeValidFunctionFixture(dir, "ssr");
    expect(validateFunction(dir, "ssr", {}).map((e) => e.message)).toEqual(["functions/ssr/function.json: manifest.json digests has no entry for it"]);
  });

  it("refuses a non-canonical function.json and bundle.index.json", () => {
    writeValidFunctionFixture(dir, "ssr");
    const fnPath = join(dir, "functions", "ssr", "function.json");
    const biPath = join(dir, "functions", "ssr", "bundle", "bundle.index.json");
    const bi = JSON.parse(readFileSync(biPath, "utf8"));
    const biRaw = Buffer.from(JSON.stringify(bi, null, 1));
    writeFileSync(biPath, biRaw);
    const fn = JSON.parse(readFileSync(fnPath, "utf8"));
    fn.artifact.digest = fileDigest(biRaw);
    writeFileSync(fnPath, JSON.stringify(fn, null, 1));
    expect(validateFunction(dir, "ssr", { "functions/ssr/function.json": fileDigest(readFileSync(fnPath)) }).map((e) => e.message)).toEqual([
      "functions/ssr/function.json: not canonical JSON (RFC 8785)",
      "functions/ssr/bundle/bundle.index.json: not canonical JSON (RFC 8785)",
    ]);
  });
});
