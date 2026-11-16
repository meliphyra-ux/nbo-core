// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "@nbo/deploy";
import { defaultBuildEdgeImage } from "../edge-install.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

// A checkout with just the files the image build looks at.
async function fakeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "edge-image-root-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const crate = join(root, "packages", "edge-rs");
  await mkdir(join(crate, "src"), { recursive: true });
  await mkdir(join(crate, "target", "debug"), { recursive: true });
  await mkdir(join(crate, "assets"), { recursive: true });
  await writeFile(join(crate, "Dockerfile"), "FROM scratch\n");
  await writeFile(join(crate, "Cargo.toml"), "[package]\n");
  await writeFile(join(crate, "Cargo.lock"), "# lock\n");
  await writeFile(join(crate, "rust-toolchain.toml"), "[toolchain]\n");
  await writeFile(join(crate, "src", "main.rs"), "fn main() {}\n");
  await writeFile(join(crate, "assets", "web-vitals.iife.js"), "//\n");
  await writeFile(join(crate, "target", "debug", "junk"), "1");
  return root;
}

interface Call {
  cmd: string;
  args: string[];
}

function recorder(): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      // pnpm deploy writes the build context into its last argument.
      if (cmd === "pnpm" && args.includes("deploy")) {
        await mkdir(args[args.length - 1]!, { recursive: true });
        await writeFile(join(args[args.length - 1]!, "package.json"), "{}");
      }
      return "";
    },
  };
}

const build = async (root: string, env?: string): Promise<{ tag: string; calls: Call[] }> => {
  const { run, calls } = recorder();
  const tag = await defaultBuildEdgeImage({ run, root, impl: env })();
  return { tag, calls };
};

describe("defaultBuildEdgeImage", () => {
  it("builds the Rust image from packages/edge-rs, without pnpm, when NBO_EDGE_IMPL is rust", async () => {
    const root = await fakeRoot();
    const { tag, calls } = await build(root, "rust");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("docker");
    expect(calls[0]!.args).toEqual([
      "build",
      "-t",
      tag,
      "-f",
      join(root, "packages", "edge-rs", "Dockerfile"),
      join(root, "packages", "edge-rs"),
    ]);
    expect(tag).toMatch(/^nbo-edge:[0-9a-f]{12}$/);
  });

  it("builds the Node image by default and when NBO_EDGE_IMPL is ts", async () => {
    const root = await fakeRoot();
    const dflt = await build(root);
    expect(dflt.calls.map((c) => c.cmd)).toEqual(["pnpm", "pnpm", "docker"]);
    const { tag, calls } = await build(root, "ts");
    expect(calls.map((c) => c.cmd)).toEqual(["pnpm", "pnpm", "docker"]);
    expect(calls[1]!.args).toContain("deploy");
    expect(calls[2]!.args.slice(0, 2)).toEqual(["build", "-t"]);
    expect(calls[2]!.args).toContain(join(root, "packages", "edge", "Dockerfile"));
    expect(tag).toMatch(/^nbo-edge:/);
  });

  it("rejects an unknown NBO_EDGE_IMPL, naming the allowed values", async () => {
    const root = await fakeRoot();
    const { run, calls } = recorder();
    await expect(defaultBuildEdgeImage({ run, root, impl: "go" })()).rejects.toThrow(/"ts".*"rust".*"go"/);
    expect(calls).toHaveLength(0);
  });

  it("changes the tag when a source, Cargo.lock or the Dockerfile changes", async () => {
    const root = await fakeRoot();
    const crate = join(root, "packages", "edge-rs");
    const base = (await build(root, "rust")).tag;
    expect((await build(root, "rust")).tag).toBe(base);
    const seen = new Set([base]);
    for (const [file, text] of [
      ["src/main.rs", "fn main() { }\n"],
      ["Cargo.lock", "# lock 2\n"],
      ["Dockerfile", "FROM scratch\n# x\n"],
    ] as const) {
      await writeFile(join(crate, file), text);
      const tag = (await build(root, "rust")).tag;
      expect(seen.has(tag), file).toBe(false);
      seen.add(tag);
    }
  });

  it("ignores cargo output in target/", async () => {
    const root = await fakeRoot();
    const before = (await build(root, "rust")).tag;
    await writeFile(join(root, "packages", "edge-rs", "target", "debug", "junk"), "2");
    await writeFile(join(root, "packages", "edge-rs", "target", "more"), "3");
    expect((await build(root, "rust")).tag).toBe(before);
  });
});
