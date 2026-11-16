// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// withCarry removes its temp directory whatever fn does. A failing
// removal must never replace fn's own error, and must not fail a
// deploy that worked.
const state = vi.hoisted(() => ({ rmError: undefined as Error | undefined, rmCalls: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rm: vi.fn(async (path: string, opts?: Parameters<typeof real.rm>[1]) => {
      state.rmCalls.push(String(path));
      if (state.rmError && String(path).includes("nbo-carry-")) throw state.rmError;
      return real.rm(path, opts);
    }),
  };
});

const { withCarry } = await import("../carry.js");

async function nboDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "carry-cleanup-"));
  await mkdir(join(dir, "static"), { recursive: true });
  await writeFile(join(dir, "static.index.json"), JSON.stringify({ files: {} }));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));
  return dir;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.rmError = undefined;
  state.rmCalls.length = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("withCarry cleanup", () => {
  it("rethrows fn's error when removing the carry directory also fails", async () => {
    state.rmError = Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    const prev = await nboDir();
    const next = await nboDir();
    await expect(
      withCarry(
        prev,
        next,
        () => {},
        async () => {
          throw new Error("image build failed");
        },
      ),
    ).rejects.toThrow("image build failed");
    expect(state.rmCalls.some((p) => p.includes("nbo-carry-"))).toBe(true);
  });

  it("returns fn's result when the removal fails, and says so", async () => {
    state.rmError = Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    const prev = await nboDir();
    const next = await nboDir();
    await expect(
      withCarry(
        prev,
        next,
        () => {},
        async () => "built",
      ),
    ).resolves.toBe("built");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not remove"));
  });
});
