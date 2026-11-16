// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { withBuildId } from "../build-id.js";

describe("withBuildId", () => {
  it("uses NBO_BUILD_ID when the default generateBuildId returns null", async () => {
    const config = withBuildId({ generateBuildId: async () => null }, { NBO_BUILD_ID: "abc" });
    expect(await config.generateBuildId()).toBe("abc");
  });

  it("keeps a site's own id", async () => {
    const config = withBuildId({ generateBuildId: async () => "mine" }, { NBO_BUILD_ID: "abc" });
    expect(await config.generateBuildId()).toBe("mine");
  });

  it("uses NBO_BUILD_ID when generateBuildId is missing", async () => {
    const config = withBuildId({}, { NBO_BUILD_ID: "abc" });
    expect(await config.generateBuildId()).toBe("abc");
  });

  it("returns the config untouched without NBO_BUILD_ID", () => {
    const original = async () => null;
    const config = { generateBuildId: original };
    const out = withBuildId(config, {});
    expect(out).toBe(config);
    expect(out.generateBuildId).toBe(original);
  });

  it("rejects characters outside letters, digits, - and _", () => {
    expect(() => withBuildId({}, { NBO_BUILD_ID: "a/b" })).toThrow('NBO_BUILD_ID must be letters, digits, "-" or "_"');
  });
});
