// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { toStaticEntry } from "../static-files.js";

describe("toStaticEntry", () => {
  it("normalizes backslash-separated pathnames to forward slashes (observed on Windows builds)", () => {
    const entry = toStaticEntry({ pathname: "/_next/static/\\pve9EA3el0hSCGq6v61lr\\_buildManifest.js", filePath: "C:\\x\\y.js", immutableHash: undefined });
    expect(entry.pathname).toBe("/_next/static/pve9EA3el0hSCGq6v61lr/_buildManifest.js");
  });

  it("marks anything under /_next/static/ immutable even when immutableHash is unset (a Next/Windows bug corrupts that field for this exact path shape)", () => {
    const entry = toStaticEntry({ pathname: "/_next/static/\\pve9EA3el0hSCGq6v61lr\\_buildManifest.js", filePath: "x", immutableHash: undefined });
    expect(entry.cache).toBe("immutable");
  });

  it("marks a file with immutableHash set immutable even outside /_next/static/", () => {
    const entry = toStaticEntry({ pathname: "/assets/app.abc123.js", filePath: "x", immutableHash: "abc123" });
    expect(entry.cache).toBe("immutable");
  });

  it("marks an ordinary file revalidate", () => {
    const entry = toStaticEntry({ pathname: "/favicon.ico", filePath: "x", immutableHash: undefined });
    expect(entry.cache).toBe("revalidate");
  });
});
