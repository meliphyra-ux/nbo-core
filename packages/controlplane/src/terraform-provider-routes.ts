// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Router } from "./router.js";

// The Terraform provider NBO's image carries (built by the Dockerfile's Go
// stage), served so an operator can download the file for their own computer.
// Under /system/, so API tokens can't reach it (guardRequest).
export const providerVersion = "0.1.0";

const platforms = ["linux_amd64", "linux_arm64", "darwin_amd64", "darwin_arm64", "windows_amd64"] as const;
const fileNameFor = (platform: string): string => `terraform-provider-nbo_v${providerVersion}${platform.startsWith("windows_") ? ".exe" : ""}`;

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const notBuilt = (): Response => json({ error: "The Terraform provider isn't built into this NBO" }, 404);

async function readIfFile(path: string): Promise<Buffer | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// dir: the folder holding <os>_<arch>/<file>, read on every request
// (NBO_TERRAFORM_PROVIDER_DIR); undefined means not built in.
export function registerTerraformProviderRoutes(router: Router, dir: () => string | undefined, hashFile: (path: string) => Promise<string> = sha256OfFile): void {
  // A hash is kept per file while its path, size and modified time stay the same.
  const hashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  router.handle("GET", "/system/terraform-provider", async () => {
    const root = dir();
    if (!root) return notBuilt();
    const list: { platform: string; fileName: string; size: number; sha256: string }[] = [];
    for (const platform of platforms) {
      const fileName = fileNameFor(platform);
      const path = join(root, platform, fileName);
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      let entry = hashes.get(path);
      if (!entry || entry.size !== info.size || entry.mtimeMs !== info.mtimeMs) {
        entry = { size: info.size, mtimeMs: info.mtimeMs, sha256: await hashFile(path) };
        hashes.set(path, entry);
      }
      list.push({ platform, fileName, size: info.size, sha256: entry.sha256 });
    }
    return json({ version: providerVersion, platforms: list }, 200);
  });
  router.handle("GET", "/system/terraform-provider/{platform}", async (_request, params) => {
    const root = dir();
    if (!root) return notBuilt();
    const platform = params.platform ?? "";
    // Only the five known names ever reach the file system.
    if (!(platforms as readonly string[]).includes(platform)) return json({ error: "No such platform" }, 404);
    const fileName = fileNameFor(platform);
    const bytes = await readIfFile(join(root, platform, fileName));
    if (!bytes) return json({ error: "No such platform" }, 404);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${fileName}"`,
        "content-length": String(bytes.length),
      },
    });
  });
}
