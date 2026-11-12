// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, symlink, lstat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// buildIsrcacheImage runs one `docker build`; the runner is faked so no
// Docker is needed, and the build context is inspected while it exists.
const seen: { args: string[]; dockerfile: string; mainJs: string; linkedIsDir: boolean; hasApp: boolean }[] = [];
vi.mock("../run.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../run.js")>();
  return {
    ...real,
    run: vi.fn(async (cmd: string, args: string[]) => {
      if (cmd !== "docker") throw new Error(`unexpected ${cmd}`);
      const ctx = args[args.length - 1]!;
      const linked = join(ctx, "cli", "node_modules", "@nbo", "isrcache");
      seen.push({
        args,
        dockerfile: await readFile(join(ctx, "Dockerfile"), "utf8"),
        mainJs: await readFile(join(ctx, "cli", "dist", "main.js"), "utf8"),
        linkedIsDir: (await lstat(linked)).isDirectory(),
        hasApp: await access(join(ctx, "app")).then(
          () => true,
          () => false,
        ),
      });
      return "";
    }),
  };
});

const { buildIsrcacheImage } = await import("../image.js");
const { renderIsrcacheDockerfile } = await import("../templates.js");

beforeEach(() => {
  seen.length = 0;
});

describe("buildIsrcacheImage", () => {
  it("builds the tag from the pinned Dockerfile with the bundle under cli/, links resolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "adapter-k8s-isrcache-build-"));
    const cli = join(root, "cli-deploy");
    await mkdir(join(cli, "dist"), { recursive: true });
    await writeFile(join(cli, "dist", "main.js"), "// cli main\n");
    const pkg = join(root, "store", "isrcache");
    await mkdir(join(pkg, "dist"), { recursive: true });
    await writeFile(join(pkg, "dist", "index.js"), "");
    await mkdir(join(cli, "node_modules", "@nbo"), { recursive: true });
    await symlink(pkg, join(cli, "node_modules", "@nbo", "isrcache"), "junction");

    await buildIsrcacheImage(cli, "nbo-isrcache:0123456789ab");

    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.args.slice(0, 3)).toEqual(["build", "-t", "nbo-isrcache:0123456789ab"]);
    expect(s.dockerfile).toBe(renderIsrcacheDockerfile());
    expect(s.mainJs).toBe("// cli main\n");
    expect(s.linkedIsDir).toBe(true);
    expect(s.hasApp).toBe(false);
  });
});
