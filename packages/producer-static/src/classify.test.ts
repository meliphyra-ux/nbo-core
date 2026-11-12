// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBuildDir } from "./classify.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nbo-classify-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("classifyBuildDir", () => {
  it("maps index.html at the root to /", () => {
    writeFileSync(join(dir, "index.html"), "x");
    const result = classifyBuildDir(dir);
    expect(result.find((r) => r.urlPath === "/")).toBeDefined();
  });

  it("maps nested index.html to the directory path", () => {
    mkdirSync(join(dir, "blog"));
    writeFileSync(join(dir, "blog", "hello.html"), "x");
    const result = classifyBuildDir(dir);
    expect(result.find((r) => r.urlPath === "/blog/hello")).toBeDefined();
  });

  it("keeps non-html files at their literal path", () => {
    mkdirSync(join(dir, "_assets"));
    writeFileSync(join(dir, "_assets", "app.js"), "x");
    const result = classifyBuildDir(dir);
    expect(result.find((r) => r.urlPath === "/_assets/app.js")).toBeDefined();
  });

  it("preserves non-ASCII file names unmangled", () => {
    mkdirSync(join(dir, "blog"));
    writeFileSync(join(dir, "blog", "café.html"), "x");
    const result = classifyBuildDir(dir);
    expect(result.find((r) => r.urlPath === "/blog/café")).toBeDefined();
  });

  it("normalizes NFD-decomposed file names to NFC url paths", () => {
    // "cafe" + U+0301 COMBINING ACUTE ACCENT: the NFD spelling of "café".
    const nfdName = "café.html";
    expect(nfdName).not.toBe("café.html");
    writeFileSync(join(dir, nfdName), "x");
    const result = classifyBuildDir(dir);
    // Some filesystems (e.g. APFS/HFS+) normalize on their own; either way the
    // key must come out as the single precomposed U+00E9 code point.
    expect(result.map((r) => r.urlPath)).toEqual(["/café"]);
  });

  it("skips any directory named .nbo (previous output)", () => {
    writeFileSync(join(dir, "index.html"), "x");
    mkdirSync(join(dir, ".nbo", "static"), { recursive: true });
    writeFileSync(join(dir, ".nbo", "manifest.json"), "{}");
    writeFileSync(join(dir, ".nbo", "static", "index.html"), "x");
    const result = classifyBuildDir(dir);
    expect(result.map((r) => r.urlPath)).toEqual(["/"]);
  });

  it("skips explicitly excluded directories", () => {
    writeFileSync(join(dir, "index.html"), "x");
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "manifest.json"), "{}");
    const result = classifyBuildDir(dir, [join(dir, "out")]);
    expect(result.map((r) => r.urlPath)).toEqual(["/"]);
  });

  it("fails on symlinks instead of following them", () => {
    // A directory link: "junction" on Windows (no admin rights needed, and
    // lstat reports it as a symlink); the type is ignored elsewhere.
    const target = mkdtempSync(join(tmpdir(), "nbo-classify-target-"));
    try {
      writeFileSync(join(target, "secret.html"), "x");
      symlinkSync(target, join(dir, "linked"), "junction");
      expect(() => classifyBuildDir(dir)).toThrow(/symlink.*linked/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
