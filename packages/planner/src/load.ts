// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest, Function as NboFunction } from "@nbo/spec";

// loadFromDir reads manifest.json and every functions/<name>/function.json
// it names from an .nbo/ build directory, returning them as the typed
// values evaluate consumes — port of LoadFromDir (load.go lines 11-38).
// Trusts its input the same way Go's version does (decodes but doesn't
// re-validate against the schema — that's @nbo/validate's own job).
export async function loadFromDir(
  nboDir: string,
): Promise<{ manifest: Manifest; functions: Record<string, NboFunction> }> {
  const raw = await readFile(join(nboDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as Manifest;

  // Object.create(null): a function literally named "__proto__" must
  // become an own, plain data property, not silently replace this
  // object's own prototype — a plain `{}` here would let bracket
  // assignment do exactly that.
  const functions: Record<string, NboFunction> = Object.create(null);
  for (const name of manifest.functions) {
    let fnRaw: string;
    try {
      fnRaw = await readFile(join(nboDir, "functions", name, "function.json"), "utf8");
    } catch (err) {
      throw new Error(`planner: loading function "${name}": ${String(err)}`, { cause: err });
    }
    functions[name] = JSON.parse(fnRaw) as NboFunction;
  }

  return { manifest, functions };
}
