// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appImageTag } from "../tag.js";

vi.mock("@nbo/adapter-k8s", () => ({
  capabilities: { name: "kubernetes" },
  buildImage: vi.fn().mockResolvedValue(undefined),
  buildFunctionImage: vi.fn().mockResolvedValue(undefined),
  loadImageIntoKind: vi.fn().mockResolvedValue(undefined),
  pushImage: vi.fn().mockResolvedValue(undefined),
  renderManifests: vi.fn().mockReturnValue("yaml"),
  renderFunctionManifests: vi.fn().mockReturnValue("yaml"),
  apply: vi.fn().mockResolvedValue(undefined),
  waitForRollout: vi.fn().mockResolvedValue(undefined),
  liveContentID: vi.fn().mockResolvedValue({ id: "", ok: false }),
  liveFunctionState: vi.fn().mockResolvedValue(undefined),
  functionConfigHash: () => "0123456789abcdef01234567",
  functionObjectName: (app: string, fn: string) => `${app}-fn-${fn}`,
  kubeName: (name: string) => name,
  functionImageHash: vi.fn().mockResolvedValue("0123456789abcdef01234567"),
  // A stand-in for the real hash: it changes with functions.json and env.json.
  appBakedHash: vi.fn(async (_dir: string, f?: Record<string, string>, e?: Record<string, string>) =>
    (await import("node:crypto"))
      .createHash("sha256")
      .update(JSON.stringify([f ?? {}, e ?? {}]))
      .digest("hex")
      .slice(0, 8),
  ),
}));
vi.mock("@nbo/adapter-cloudrun", () => ({
  capabilities: { name: "cloudrun" },
  deploy: vi.fn().mockResolvedValue("https://myapp-abc123-uc.a.run.app"),
  liveContentID: vi.fn().mockResolvedValue({ id: "", ok: false }),
  liveServiceState: vi.fn().mockResolvedValue(undefined),
  functionDeployConfigHash: () => "0123456789abcdef0123456789abcdef",
  serviceIdentityEmail: (project: string, service: string) => `${service}@${project}.iam.gserviceaccount.com`,
  pushImage: vi.fn().mockResolvedValue(undefined),
  defaultComputeServiceAccount: vi.fn().mockResolvedValue("123-compute@developer.gserviceaccount.com"),
  grantInvoker: vi.fn().mockResolvedValue(undefined),
  contentIDLabel: (id: string) => id.replace(/^sha256:/, "").slice(0, 32),
}));
vi.mock("../run.js", () => ({ run: vi.fn().mockResolvedValue("") }));

const { buildImage } = await import("@nbo/adapter-k8s");
const { createKubernetesTarget } = await import("../kubernetes-target.js");
const { createCloudRunTarget } = await import("../cloudrun-target.js");

const ID = "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1";

async function build(name: string, files: Record<string, unknown>, bytes: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `carry-target-${name}-`));
  await mkdir(join(d, "static"), { recursive: true });
  for (const [f, b] of Object.entries(bytes)) await writeFile(join(d, "static", f), b);
  await writeFile(join(d, "static.index.json"), JSON.stringify({ files }));
  await writeFile(join(d, "manifest.json"), JSON.stringify({ specVersion: "1.0", name }));
  return d;
}

const prevFiles = { "/assets/a.js": { file: "a.js", contentType: "text/javascript", cache: "immutable" } };

describe("appImageTag", () => {
  it("adds -c<hash> only when files are carried, and always -b<baked inputs hash>", () => {
    expect(appImageTag(ID, "", "0123abcd")).toBe("4b66654e468e-b0123abcd");
    expect(appImageTag(ID, "deadbeef", "0123abcd")).toBe("4b66654e468e-cdeadbeef-b0123abcd");
  });

  it("differs for the same content id when the baked inputs differ", () => {
    expect(appImageTag(ID, "", "0123abcd")).not.toBe(appImageTag(ID, "", "fedc9876"));
  });
});

describe.each([
  ["kubernetes", (cb: (m: string) => void) => createKubernetesTarget("myapp", undefined, { onProgress: cb })],
  [
    "cloudrun",
    (cb: (m: string) => void) => createCloudRunTarget("proj", "region", "repo", undefined, { onProgress: cb }),
  ],
] as const)("%s target carryFrom", (_name, make) => {
  it("tags with the carry hash, passes the carry dir, reports it, and removes the dir", async () => {
    const prev = await build("prev", prevFiles, { "a.js": "aa" });
    const next = await build("next", {}, {});
    try {
      const messages: string[] = [];
      const target = make((m) => messages.push(m));
      target.carryFrom = prev;
      await target.deployer.buildAndDeploy(next, "myapp", ID);
      const call = vi.mocked(buildImage).mock.calls.at(-1)!;
      expect(call[2]).toMatch(/^nbo-app-myapp:4b66654e468e-c[0-9a-f]{8}-b[0-9a-f]{8}$/);
      expect(call[5]).toBeTruthy();
      expect(existsSync(call[5] as string)).toBe(false);
      expect(messages.some((m) => m.includes("carried 1 files from the previous build"))).toBe(true);
    } finally {
      await rm(prev, { recursive: true, force: true });
      await rm(next, { recursive: true, force: true });
    }
  }, 30000);

  it("keeps today's tag without carryFrom, and says why when the previous build is unusable", async () => {
    const next = await build("next2", {}, {});
    try {
      await make(() => {}).deployer.buildAndDeploy(next, "myapp", ID);
      const plain = vi.mocked(buildImage).mock.calls.at(-1)!;
      expect(plain[2]).toMatch(/^nbo-app-myapp:4b66654e468e-b[0-9a-f]{8}$/);
      expect(plain[5]).toBeUndefined();

      const messages: string[] = [];
      const target = make((m) => messages.push(m));
      target.carryFrom = join(next, "does-not-exist");
      await target.deployer.buildAndDeploy(next, "myapp", ID);
      const call = vi.mocked(buildImage).mock.calls.at(-1)!;
      expect(call[2]).toBe(plain[2]);
      expect(call[5]).toBeUndefined();
      expect(messages.some((m) => m.includes("previous build's files not kept"))).toBe(true);
    } finally {
      await rm(next, { recursive: true, force: true });
    }
  }, 30000);

  it("gives the same build a new tag when what is baked into the image changes", async () => {
    const next = await build("next3", {}, {});
    try {
      const first = make(() => {});
      first.extraEnv = { NBO_SOMETHING: "one" };
      await first.deployer.buildAndDeploy(next, "myapp", ID);
      const a = vi.mocked(buildImage).mock.calls.at(-1)!;
      const second = make(() => {});
      second.extraEnv = { NBO_SOMETHING: "two" };
      await second.deployer.buildAndDeploy(next, "myapp", ID);
      const b = vi.mocked(buildImage).mock.calls.at(-1)!;
      expect(a[4]).not.toEqual(b[4]);
      expect(a[2]).toMatch(/^nbo-app-myapp:4b66654e468e-b[0-9a-f]{8}$/);
      expect(b[2]).toMatch(/^nbo-app-myapp:4b66654e468e-b[0-9a-f]{8}$/);
      expect(b[2]).not.toBe(a[2]);
    } finally {
      await rm(next, { recursive: true, force: true });
    }
  }, 30000);
});
