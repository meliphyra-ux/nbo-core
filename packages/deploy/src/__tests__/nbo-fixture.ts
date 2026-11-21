// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalize } from "@nbo/digest";

export function sha256Hex(raw: string | Buffer): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

// writeManifestFixture writes a minimal but schema-valid .nbo/
// directory: one static file, referenced by static.index.json, with
// every digest computed from the actual bytes on disk so validate()
// accepts it.
export async function writeManifestFixture(dir: string): Promise<void> {
  await mkdir(join(dir, "static"), { recursive: true });
  const indexHTML = Buffer.from("hi");
  await writeFile(join(dir, "static", "index.html"), indexHTML);

  const staticIndex = Buffer.from(
    canonicalize({
      files: {
        "/": {
          file: "index.html",
          digest: sha256Hex(indexHTML),
          size: 2,
          contentType: "text/html; charset=utf-8",
          cache: "revalidate",
        },
      },
    }),
  );
  await writeFile(join(dir, "static.index.json"), staticIndex);

  const routes = Buffer.from(canonicalize({ version: 1 }));
  await writeFile(join(dir, "routes.json"), routes);

  const manifest = Buffer.from(
    canonicalize({
      specVersion: "1.0",
      build: { id: "b1", createdAt: "2026-10-22T00:00:00Z", framework: { name: "static" } },
      requires: { capabilities: [], extensions: [] },
      functions: [],
      digests: { "static.index.json": sha256Hex(staticIndex), "routes.json": sha256Hex(routes) },
    }),
  );
  await writeFile(join(dir, "manifest.json"), manifest);
}

// writeManifestFixtureWithFunction writes the same fixture
// writeManifestFixture does, but also adds a minimal, schema-valid
// function to it, so manifest.functions is non-empty.
export async function writeManifestFixtureWithFunction(dir: string, name: string): Promise<void> {
  await writeManifestFixture(dir);

  const bundleDir = join(dir, "functions", name, "bundle");
  await mkdir(bundleDir, { recursive: true });
  const entry = Buffer.from("export default { fetch() {} };");
  await writeFile(join(bundleDir, "index.mjs"), entry);

  const bundleIndex = Buffer.from(
    canonicalize({ files: { "index.mjs": { digest: sha256Hex(entry), size: entry.length } } }),
  );
  await writeFile(join(bundleDir, "bundle.index.json"), bundleIndex);

  const functionJSON = Buffer.from(
    canonicalize({
      name,
      runtime: { kind: "node" },
      handler: { style: "fetch", entry: "index.mjs", export: "default" },
      artifact: { type: "bundle", path: "bundle/", digest: sha256Hex(bundleIndex), files: "bundle.index.json" },
      concurrency: "multi",
    }),
  );
  await writeFile(join(dir, "functions", name, "function.json"), functionJSON);

  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.functions = [name];
  manifest.digests[`functions/${name}/function.json`] = sha256Hex(functionJSON);
  await writeFile(manifestPath, canonicalize(manifest));
}
