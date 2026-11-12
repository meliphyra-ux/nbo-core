// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "@nbo/digest";
import { runValidate } from "../validate.js";

function fileDigest(raw: Buffer): string {
  return `sha256:${sha256Hex(raw)}`;
}

// writeNboDir builds a minimal, well-formed .nbo dir — same shape as
// @nbo/validate's own test helper of the same name.
function writeNboDir(dir: string): void {
  mkdirSync(join(dir, "static"), { recursive: true });
  const indexHtml = "<h1>hi</h1>";
  writeFileSync(join(dir, "static", "index.html"), indexHtml);

  const staticIndex = {
    files: {
      "/": { file: "index.html", digest: fileDigest(Buffer.from(indexHtml)), size: indexHtml.length, contentType: "text/html; charset=utf-8", cache: "revalidate" },
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
    digests: { "static.index.json": fileDigest(staticIndexBytes), "routes.json": fileDigest(routesBytes) },
  };
  writeFileSync(join(dir, "manifest.json"), canonicalize(manifest));
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nbo-cli-validate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runValidate", () => {
  it("returns 0 for a valid .nbo dir", async () => {
    writeNboDir(dir);

    expect(await runValidate([dir])).toBe(0);
  });

  it("returns 1 and prints the specific errors for an invalid .nbo dir", async () => {
    // No manifest.json at all.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await runValidate([dir]);
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("runValidate warnings", () => {
  function addNboKey(dir: string): void {
    // Rewrite static.index.json with an extra /_nbo/ key and fix its digest.
    const indexHtml = "<h1>hi</h1>";
    const entry = { file: "index.html", digest: fileDigest(Buffer.from(indexHtml)), size: indexHtml.length, contentType: "text/html; charset=utf-8", cache: "revalidate" };
    const staticIndexBytes = Buffer.from(canonicalize({ files: { "/": entry, "/_nbo/x": entry } }));
    writeFileSync(join(dir, "static.index.json"), staticIndexBytes);
    const routesBytes = Buffer.from(canonicalize({ version: 1 }));
    const manifest = {
      specVersion: "1.0",
      build: { id: "b_test", createdAt: "2026-10-22T00:00:00Z", framework: { name: "static" } },
      requires: { capabilities: [], extensions: [] },
      functions: [],
      digests: { "static.index.json": fileDigest(staticIndexBytes), "routes.json": fileDigest(routesBytes) },
    };
    writeFileSync(join(dir, "manifest.json"), canonicalize(manifest));
  }

  it("prints a warning and returns 0 without --strict, and returns 1 with it", async () => {
    writeNboDir(dir);
    addNboKey(dir);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runValidate([dir])).toBe(0);
      expect(errorSpy.mock.calls.flat()).toContain('warning: static.index.json: "/_nbo/x": paths under /_nbo/ are reserved for the platform');
      errorSpy.mockClear();
      expect(await runValidate(["--strict", dir])).toBe(1);
      expect(errorSpy.mock.calls.flat()).toContain('static.index.json: "/_nbo/x": paths under /_nbo/ are reserved for the platform');
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
