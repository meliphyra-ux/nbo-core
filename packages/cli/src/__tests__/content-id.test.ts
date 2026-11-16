// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, sha256Hex, contentId } from "@nbo/digest";
import { runContentId } from "../content-id.js";

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
    digests: { "static.index.json": fileDigest(staticIndexBytes), "routes.json": fileDigest(routesBytes) },
  };
  writeFileSync(join(dir, "manifest.json"), canonicalize(manifest));
}

let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nbo-cli-cid-"));
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("runContentId", () => {
  it("prints exactly the content id of a valid dir and returns 0", async () => {
    writeNboDir(dir);
    const expected = contentId(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
    expect(await runContentId([dir])).toBe(0);
    expect(out.join("").trim()).toBe(expected);
    expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(err).toEqual([]);
  });

  it("ignores the build block", async () => {
    writeNboDir(dir);
    await runContentId([dir]);
    const first = out.join("").trim();
    const p = join(dir, "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.build.createdAt = "2030-01-01T00:00:00Z";
    writeFileSync(p, canonicalize(m));
    out.length = 0;
    expect(await runContentId([dir])).toBe(0);
    expect(out.join("").trim()).toBe(first);
  });

  it("returns 1 with errors on stderr and nothing on stdout for a tampered file", async () => {
    writeNboDir(dir);
    writeFileSync(join(dir, "static", "index.html"), "<h1>tampered</h1>");
    expect(await runContentId([dir])).toBe(1);
    expect(out).toEqual([]);
    expect(err.length).toBeGreaterThan(0);
  });

  it("returns 1 and names the version for a manifest built for a newer spec minor", async () => {
    writeNboDir(dir);
    const p = join(dir, "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.specVersion = "1.1";
    writeFileSync(p, canonicalize(m));
    expect(await runContentId([dir])).toBe(1);
    expect(out).toEqual([]);
    expect(err).toContain("manifest.json: built for NBO spec 1.1; this nbo reads spec 1.0 and older 1.x; upgrade NBO");
  });

  it("prints usage and returns 1 without an argument", async () => {
    expect(await runContentId([])).toBe(1);
    expect(err).toEqual(["usage: nbo content-id <dir>"]);
    expect(out).toEqual([]);
  });
});
