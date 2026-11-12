// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";

// `nbo deploy` prints deploy()'s progress lines on stderr, so a build
// with prerender routes says it is served uncached (the CLI runs no ISR
// cache). deploy() is faked: no cluster is touched.
vi.mock("@nbo/deploy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@nbo/deploy")>();
  return {
    ...real,
    deploy: vi.fn(async (_d: unknown, _dir: string, _app: string, progress?: { onProgress?: (m: string) => void }) => {
      progress?.onProgress?.("prerender routes are served uncached: this deploy runs no ISR cache");
      return { contentID: "sha256:x", alreadyLive: false, url: "http://x", plan: "" };
    }),
  };
});

const { runDeploy } = await import("../deploy.js");

describe("runDeploy progress", () => {
  it("prints deploy progress lines on stderr", async () => {
    const errs: string[] = [];
    const spyErr = vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      errs.push(String(m));
    });
    const spyLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runDeploy(["dir", "--app", "myapp"])).toBe(0);
    } finally {
      spyErr.mockRestore();
      spyLog.mockRestore();
    }
    expect(errs).toContain("prerender routes are served uncached: this deploy runs no ISR cache");
  });
});
