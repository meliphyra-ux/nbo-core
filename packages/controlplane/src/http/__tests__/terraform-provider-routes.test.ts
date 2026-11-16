// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createTestMux } from "../../__tests__/test-mux.js";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../../store/store.js";
import { createRouter } from "../router.js";
import { registerTerraformProviderRoutes } from "../terraform-provider-routes.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function providerDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tf-provider-"));
  dirs.push(dir);
  await mkdir(join(dir, "linux_amd64"), { recursive: true });
  await mkdir(join(dir, "windows_amd64"), { recursive: true });
  await writeFile(join(dir, "linux_amd64", "terraform-provider-nbo_v0.1.0"), "linux-bytes");
  await writeFile(join(dir, "windows_amd64", "terraform-provider-nbo_v0.1.0.exe"), "win-bytes");
  return dir;
}

function routerFor(dir: string | undefined, hash?: (path: string) => Promise<string>) {
  const router = createRouter();
  registerTerraformProviderRoutes(router, () => dir, hash);
  return (path: string) => router(new Request(`http://127.0.0.1${path}`));
}

describe("terraform provider routes", () => {
  it("lists only the files that exist, with size and sha256", async () => {
    const res = await routerFor(await providerDir())("/system/terraform-provider");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      platforms: { platform: string; fileName: string; size: number; sha256: string }[];
    };
    expect(body.version).toBe("0.1.0");
    expect(body.platforms).toEqual([
      {
        platform: "linux_amd64",
        fileName: "terraform-provider-nbo_v0.1.0",
        size: 11,
        sha256: createHash("sha256").update("linux-bytes").digest("hex"),
      },
      {
        platform: "windows_amd64",
        fileName: "terraform-provider-nbo_v0.1.0.exe",
        size: 9,
        sha256: createHash("sha256").update("win-bytes").digest("hex"),
      },
    ]);
  });

  it("does not hash an unchanged file again on the next list, but does after it changes", async () => {
    const dir = await providerDir();
    const hashed: string[] = [];
    const get = routerFor(dir, async (path) => {
      hashed.push(path);
      return "h" + hashed.length;
    });
    await get("/system/terraform-provider");
    expect(hashed).toHaveLength(2);
    await get("/system/terraform-provider");
    expect(hashed).toHaveLength(2);
    await writeFile(join(dir, "linux_amd64", "terraform-provider-nbo_v0.1.0"), "linux-bytes-changed");
    await get("/system/terraform-provider");
    expect(hashed).toHaveLength(3);
  });

  it("downloads the bytes as an attachment", async () => {
    const res = await routerFor(await providerDir())("/system/terraform-provider/linux_amd64");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="terraform-provider-nbo_v0.1.0"');
    expect(await res.text()).toBe("linux-bytes");
    const win = await routerFor(await providerDir())("/system/terraform-provider/windows_amd64");
    expect(win.headers.get("content-disposition")).toBe('attachment; filename="terraform-provider-nbo_v0.1.0.exe"');
  });

  it("404s unknown, missing and traversal platform names", async () => {
    const get = routerFor(await providerDir());
    for (const p of ["plan9_amd64", "darwin_arm64", "..%2F..%2Fetc", "linux_amd64%2F..", "..", "linux_amd64/x"]) {
      expect((await get(`/system/terraform-provider/${p}`)).status).toBe(404);
    }
  });

  it("404s both routes with the message when the folder is not set", async () => {
    const get = routerFor(undefined);
    for (const path of ["/system/terraform-provider", "/system/terraform-provider/linux_amd64"]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "The Terraform provider isn't built into this NBO" });
    }
  });

  it("refuses an API token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-provider-store-"));
    dirs.push(dir);
    const store = createStore(join(dir, "t.db"));
    stores.push(store);
    const { secret } = store.createApiToken("ci");
    const mux = createTestMux(store);
    for (const path of ["/system/terraform-provider", "/system/terraform-provider/linux_amd64"]) {
      const res = await mux(new Request(`http://127.0.0.1${path}`, { headers: { authorization: `Bearer ${secret}` } }));
      expect(res.status).toBe(403);
    }
  });
});
