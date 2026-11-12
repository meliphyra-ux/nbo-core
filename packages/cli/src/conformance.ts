// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { run, type Transcript } from "@nbo/conformance";

// loadTranscripts reads every *.json file in dir as a single
// Transcript, sorted by filename so results print in a stable,
// predictable order — port of loadTranscripts (cmd/nbo/conformance.go
// lines 14-42).
export async function loadTranscripts(dir: string): Promise<Transcript[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();

  const transcripts: Transcript[] = [];
  for (const name of names) {
    const raw = await readFile(join(dir, name), "utf8");
    try {
      transcripts.push(JSON.parse(raw) as Transcript);
    } catch (err) {
      throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  return transcripts;
}

// runConformance — port of runConformance (cmd/nbo/conformance.go
// lines 44-69).
export async function runConformance(args: string[]): Promise<number> {
  if (args.length < 2) {
    console.error("usage: nbo conformance <transcripts-dir> <baseURL> [--insecure]");
    return 1;
  }
  const [dir, baseURL] = args;
  const insecure = args.slice(2).includes("--insecure");

  let transcripts: Transcript[];
  try {
    transcripts = await loadTranscripts(dir!);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const errors = await run(baseURL!, transcripts, insecure);
  if (errors.length !== 0) {
    for (const e of errors) console.error(e);
    return 1;
  }
  console.log(`ok (${transcripts.length} transcripts passed)`);
  return 0;
}
