// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { mkdir, mkdtemp, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { contentId } from "@nbo/digest";

// The carry is the previous build's immutable files, baked into the new app
// image so a visitor holding an old page can still fetch its hashed assets
// during a rollout. Written here, read by @nbo/serve (carry.ts there); the
// format is spec'd in the carried-files design.
export const CARRY_MAX_BYTES = 268435456;

export interface CarrySummary {
  files: number;
  bytes: number;
  hash: string;
  skipped?: string;
}

interface IndexEntry {
  file: string;
  contentType: string;
  cache?: string;
}

const MIB = 1048576;

async function readIndex(nboDir: string): Promise<Record<string, IndexEntry>> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(join(nboDir, "static.index.json"), "utf8"));
  } catch (err) {
    // eslint-disable-next-line preserve-caught-error -- message-only error, adding cause would change the error object
    throw new Error(`static.index.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  const files = (doc as { files?: unknown } | null)?.files;
  if (files === null || typeof files !== "object" || Array.isArray(files))
    throw new Error("static.index.json: files must be an object");
  return files as Record<string, IndexEntry>;
}

// safeRel accepts only a plain relative path that stays under static/.
function safeRel(file: unknown): file is string {
  if (typeof file !== "string" || file === "" || file.includes("\\") || file.startsWith("/") || file.includes("\0"))
    return false;
  return file.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

async function writeEmpty(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "index.json"), JSON.stringify({ version: 1, contentId: "", files: {} }));
}

export async function writeCarry(
  previousNboDir: string,
  nboDir: string,
  outDir: string,
  maxBytes = CARRY_MAX_BYTES,
): Promise<CarrySummary> {
  const skip = async (reason: string): Promise<CarrySummary> => {
    await writeEmpty(outDir);
    return { files: 0, bytes: 0, hash: "", skipped: `previous build's files not kept: ${reason}` };
  };

  let before: Record<string, IndexEntry>;
  let previousId: string;
  try {
    before = await readIndex(previousNboDir);
    previousId = contentId(
      JSON.parse(await readFile(join(previousNboDir, "manifest.json"), "utf8")) as Record<string, unknown>,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return skip(code === "ENOENT" ? "its output is missing" : err instanceof Error ? err.message : String(err));
  }
  let after: Record<string, IndexEntry> = {};
  try {
    after = await readIndex(nboDir);
  } catch {
    // A new build with no readable index has nothing a carried file could clash with.
  }

  const picked: { path: string; entry: IndexEntry; size: number }[] = [];
  let bytes = 0;
  for (const path of Object.keys(before).sort()) {
    const entry = before[path]!;
    if (
      entry === null ||
      typeof entry !== "object" ||
      entry.cache !== "immutable" ||
      typeof entry.contentType !== "string"
    )
      continue;
    if (Object.hasOwn(after, path) || !safeRel(entry.file)) continue;
    let size: number;
    try {
      const st = await stat(join(previousNboDir, "static", entry.file));
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    picked.push({ path, entry, size });
    bytes += size;
  }
  if (bytes > maxBytes)
    return skip(`${Math.ceil(bytes / MIB)} MiB is over the ${Math.round((maxBytes / MIB) * 100) / 100} MiB limit`);
  if (picked.length === 0) {
    await writeEmpty(outDir);
    return { files: 0, bytes: 0, hash: "" };
  }

  const files: Record<string, { file: string; contentType: string }> = {};
  for (const { path, entry } of picked) files[path] = { file: entry.file, contentType: entry.contentType };
  const indexJSON = JSON.stringify({ version: 1, contentId: previousId, files });
  const hash = createHash("sha256");
  hash.update(indexJSON);
  await mkdir(outDir, { recursive: true });
  const copied = new Set<string>();
  for (const { path, entry } of picked) {
    const dest = join(outDir, "static", entry.file);
    if (!copied.has(entry.file)) {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(previousNboDir, "static", entry.file), dest);
      copied.add(entry.file);
    }
    hash.update(`\0${path}\0`);
    hash.update(await readFile(dest));
  }
  await writeFile(join(outDir, "index.json"), indexJSON);
  return { files: picked.length, bytes, hash: hash.digest("hex").slice(0, 8) };
}

// withCarry runs fn with a carry directory written from carryFrom (the previous
// build's .nbo/), or with no directory and an empty hash when carryFrom is unset
// or nothing is carried. What was carried, or why not, goes to report. The
// temp directory is removed afterwards, whatever fn does.
export async function withCarry<T>(
  carryFrom: string | undefined,
  nboDir: string,
  report: (message: string) => void,
  fn: (carryDir: string | undefined, carryHash: string) => Promise<T>,
): Promise<T> {
  if (!carryFrom) return fn(undefined, "");
  const dir = await mkdtemp(join(tmpdir(), "nbo-carry-"));
  try {
    let summary: CarrySummary;
    try {
      summary = await writeCarry(carryFrom, nboDir, dir);
    } catch (err) {
      // A carry problem never stops a deploy.
      report(`previous build's files not kept: ${err instanceof Error ? err.message : String(err)}`);
      return await fn(undefined, "");
    }
    if (summary.skipped) report(summary.skipped);
    else if (summary.files > 0) report(`carried ${summary.files} files from the previous build`);
    return await fn(summary.files > 0 ? dir : undefined, summary.hash);
  } finally {
    // Best effort: a failed removal never replaces fn's error or result.
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `nbo: could not remove the carry directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
