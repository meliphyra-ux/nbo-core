// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// deploy() writes plain values to a temp env file and removes its
// directory afterwards. A failing removal must never replace the
// deploy's own error, and must not fail a deploy that worked.
const state = vi.hoisted(() => ({ rmError: undefined as Error | undefined, rmCalls: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rm: vi.fn(async (path: string, opts?: Parameters<typeof real.rm>[1]) => {
      state.rmCalls.push(String(path));
      if (state.rmError) throw state.rmError;
      return real.rm(path, opts);
    }),
  };
});

const { deploy } = await import("../deploy.js");

const spec = {
  serviceName: "svc",
  imageTag: "img",
  project: "p",
  region: "r",
  contentID: "sha256:aaaa111122223333444455556666777788889999000011112222333344445555",
  allowUnauthenticated: true,
  plainEnv: { GREETING: "hello" },
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.rmError = undefined;
  state.rmCalls.length = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("deploy env file cleanup", () => {
  it("rethrows gcloud's error when removing the env file's directory also fails", async () => {
    state.rmError = Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    const run = vi.fn(async () => {
      throw new Error("gcloud run deploy failed: quota exceeded");
    });
    await expect(deploy(spec, { run })).rejects.toThrow("gcloud run deploy failed: quota exceeded");
    expect(state.rmCalls.some((p) => p.includes("nbo-env-"))).toBe(true);
  });

  it("does not fail a deploy that worked when the removal fails, and says so", async () => {
    state.rmError = Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    const run = vi.fn(async (_cmd: string, args: string[]) =>
      args.includes("describe") ? JSON.stringify({ status: { url: "https://svc.run.app" } }) : "",
    );
    await expect(deploy(spec, { run })).resolves.toBe("https://svc.run.app");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not remove"));
  });
});
