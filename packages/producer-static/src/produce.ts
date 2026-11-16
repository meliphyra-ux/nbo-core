// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { resolve } from "node:path";
import { NboWriter } from "@nbo/writer";
import { classifyBuildDir } from "./classify.js";

// A file is safe to cache forever only if its name carries a content hash
// (e.g. `index.3f9a1c2b.js`) or it sits in Vite's top-level hashed-output
// directory `/assets/`. A nested `.../assets/...` path (e.g. copied from
// `public/`) is not enough on its own. Moved from cli.ts so produce.ts has
// no dependency on it (cli.ts now depends on produce.ts, not the reverse —
// importing it back from cli.ts here would be a circular import).
export function isHashedAsset(urlPath: string): boolean {
  return /\.[0-9a-f]{6,}\.[a-z0-9]+$/i.test(urlPath) || /^\/assets\//.test(urlPath);
}

// produce runs the same build-dir-to-.nbo/ pipeline cli.ts's own main()
// used to run inline — extracted so a caller already in the same
// process (the control plane's own build runner) can call it directly
// instead of shelling out to this package's CLI.
export async function produce(
  buildDir: string,
  outDir: string,
  opts?: { spa?: boolean },
): Promise<{ contentId: string }> {
  const writer = new NboWriter({ outDir, framework: { name: "static" } });
  // Never ingest our own output, even when outDir points inside buildDir.
  for (const file of classifyBuildDir(buildDir, [resolve(outDir)])) {
    writer.addStatic(file.urlPath, file.sourceFilePath, {
      cache: isHashedAsset(file.urlPath) ? "immutable" : "revalidate",
    });
  }
  if (opts?.spa) writer.setFallbackToRoot();
  return writer.write();
}
