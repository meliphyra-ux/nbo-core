// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPublicFiles } from "../public-files.js";

describe("listPublicFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nbo-public-files-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists a top-level file as a root-relative pathname", () => {
    const publicDir = join(dir, "public");
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(join(publicDir, "file.svg"), "<svg/>");

    const files = listPublicFiles(publicDir);
    expect(files).toEqual([{ pathname: "/file.svg", filePath: join(publicDir, "file.svg") }]);
  });

  it("lists nested files with forward-slash pathnames regardless of platform separator", () => {
    const publicDir = join(dir, "public");
    mkdirSync(join(publicDir, "images"), { recursive: true });
    writeFileSync(join(publicDir, "images", "logo.png"), "x");

    const files = listPublicFiles(publicDir);
    expect(files).toEqual([{ pathname: "/images/logo.png", filePath: join(publicDir, "images", "logo.png") }]);
  });

  it("returns an empty list when the public directory doesn't exist (an app with no public/ assets)", () => {
    const files = listPublicFiles(join(dir, "does-not-exist"));
    expect(files).toEqual([]);
  });
});
