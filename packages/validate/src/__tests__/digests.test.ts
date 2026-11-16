// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileDigest,
  checkManifestDigests,
  checkStaticFiles,
  reservedStaticKeys,
  unreferencedStaticFiles,
} from "../digests.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nbo-validate-"));
  mkdirSync(join(dir, "static"));
  writeFileSync(join(dir, "static", "index.html"), "<h1>hi</h1>");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkManifestDigests", () => {
  const routesRaw = Buffer.from('{"version":1}');

  it("returns no errors when both digests match", () => {
    const raw = Buffer.from('{"files":{}}');
    const manifestDoc = { digests: { "static.index.json": fileDigest(raw), "routes.json": fileDigest(routesRaw) } };
    expect(checkManifestDigests(manifestDoc, raw, routesRaw)).toHaveLength(0);
  });

  it("requires an entry for static.index.json and routes.json", () => {
    expect(checkManifestDigests({ digests: {} }, undefined, undefined).map((e) => e.message)).toEqual([
      "static.index.json: manifest.json digests has no entry for it",
      "routes.json: manifest.json digests has no entry for it",
    ]);
  });

  it("returns an error naming static.index.json when the digest doesn't match", () => {
    const raw = Buffer.from('{"files":{}}');
    const manifestDoc = {
      digests: { "static.index.json": "sha256:" + "0".repeat(64), "routes.json": fileDigest(routesRaw) },
    };
    const errs = checkManifestDigests(manifestDoc, raw, routesRaw);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain("static.index.json");
  });
});

describe("checkStaticFiles", () => {
  it("returns an error naming the file when its on-disk content doesn't match its declared digest", () => {
    const staticIndexDoc = {
      files: { "/": { file: "index.html", digest: "sha256:" + "0".repeat(64) } },
    };
    const { errors } = checkStaticFiles(dir, staticIndexDoc);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("index.html");
  });

  it('returns an error containing "escapes static/" for a file value that climbs out via ..', () => {
    writeFileSync(join(dir, "secret.txt"), "top-secret");
    const staticIndexDoc = {
      files: { "/evil": { file: "../secret.txt", digest: "sha256:" + "0".repeat(64) } },
    };
    const { errors } = checkStaticFiles(dir, staticIndexDoc);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("escapes static/");
    expect(errors[0]!.message).toContain("../secret.txt");
  });

  it("returns no errors and references the file when its digest matches", () => {
    const raw = "<h1>hi</h1>";
    const staticIndexDoc = {
      files: { "/": { file: "index.html", digest: fileDigest(Buffer.from(raw)) } },
    };
    const { errors, referenced } = checkStaticFiles(dir, staticIndexDoc);
    expect(errors).toHaveLength(0);
    expect(referenced.size).toBe(1);
  });
});

describe("checkStaticFiles malformed input", () => {
  it("does not throw when a files entry is null", () => {
    const staticIndexDoc = { files: { "/": null } };
    expect(() => checkStaticFiles(dir, staticIndexDoc)).not.toThrow();
  });
});

describe("unreferencedStaticFiles", () => {
  it("returns exactly one error naming a file under static/ that isn't referenced", () => {
    mkdirSync(join(dir, "static", "assets"));
    writeFileSync(join(dir, "static", "assets", "stale.abc123.js"), "old");
    const referenced = new Set([join(dir, "static", "index.html")]);
    const errs = unreferencedStaticFiles(dir, referenced);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain("stale.abc123.js");
    expect(errs[0]!.message).toContain("not referenced");
  });

  it("returns no error for a file that is in the referenced set", () => {
    const fullPath = join(dir, "static", "index.html");
    expect(unreferencedStaticFiles(dir, new Set([fullPath]))).toHaveLength(0);
  });
});

describe("reservedStaticKeys", () => {
  it("names a static key under /_nbo/", () => {
    const staticIndexDoc = { files: { "/_nbo/x": { file: "index.html" } } };
    expect(reservedStaticKeys(staticIndexDoc).map((e) => e.message)).toEqual([
      'static.index.json: "/_nbo/x": paths under /_nbo/ are reserved for the platform',
    ]);
  });

  it("accepts /_nbox and /_next/, and checkStaticFiles itself no longer reports /_nbo/ keys", () => {
    const raw = "<h1>hi</h1>";
    const d = fileDigest(Buffer.from(raw));
    expect(reservedStaticKeys({ files: { "/_next/a": {}, "/_nbox": {} } })).toEqual([]);
    expect(checkStaticFiles(dir, { files: { "/_nbo/x": { file: "index.html", digest: d } } }).errors).toEqual([]);
  });

  it("does not throw on malformed input", () => {
    expect(() => reservedStaticKeys(null)).not.toThrow();
    expect(() => reservedStaticKeys({ files: 3 })).not.toThrow();
  });
});
