// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { functionImageHash } from "../image.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function fn(
  files: Record<string, string> = { "index.mjs": "export default () => 1;", "lib/a.js": "a" },
  functionJSON = '{"handler":{"entry":"index.mjs"}}',
) {
  const dir = await mkdtemp(join(tmpdir(), "fn-hash-"));
  dirs.push(dir);
  const bundle = join(dir, "bundle");
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(bundle, rel, ".."), { recursive: true });
    await writeFile(join(bundle, rel), content);
  }
  await mkdir(bundle, { recursive: true });
  await writeFile(join(dir, "function.json"), functionJSON);
  return { bundle, json: join(dir, "function.json") };
}

describe("functionImageHash", () => {
  it("is a docker-tag-safe hex string, identical for identical content in different places", async () => {
    const a = await fn();
    const b = await fn();
    const ha = await functionImageHash(a.bundle, a.json, { A: "1" });
    expect(ha).toMatch(/^[0-9a-f]{24}$/);
    expect(await functionImageHash(b.bundle, b.json, { A: "1" })).toBe(ha);
  });

  it("ignores env key order but not env values", async () => {
    const a = await fn();
    const base = await functionImageHash(a.bundle, a.json, { A: "1", B: "2" });
    expect(await functionImageHash(a.bundle, a.json, { B: "2", A: "1" })).toBe(base);
    expect(await functionImageHash(a.bundle, a.json, { A: "1", B: "3" })).not.toBe(base);
    expect(await functionImageHash(a.bundle, a.json)).not.toBe(base);
  });

  it("changes when a bundle file's content, a bundle file's path, or function.json changes", async () => {
    const base = await fn();
    const h = await functionImageHash(base.bundle, base.json);
    const content = await fn({ "index.mjs": "export default () => 2;", "lib/a.js": "a" });
    const renamed = await fn({ "index.mjs": "export default () => 1;", "lib/b.js": "a" });
    const json = await fn(undefined, '{"handler":{"entry":"index.mjs"},"resources":{"memoryMb":1024}}');
    for (const other of [content, renamed, json]) expect(await functionImageHash(other.bundle, other.json)).not.toBe(h);
  });

  it("never contains an env value", async () => {
    const a = await fn();
    const h = await functionImageHash(a.bundle, a.json, { SECRET: "abc123" });
    expect(h).not.toContain("abc123");
  });
});
