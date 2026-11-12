// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentId } from "@nbo/digest";
import { writeCarry } from "../carry.js";

type Entry = { file: string; contentType: string; cache: string };

async function nbo(name: string, files: Record<string, Entry>, bytes: Record<string, string>, manifest: Record<string, unknown> | null = { specVersion: "1.0", name }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `carry-${name}-`));
  await mkdir(join(dir, "static"), { recursive: true });
  for (const [f, body] of Object.entries(bytes)) {
    await mkdir(join(dir, "static", f, ".."), { recursive: true });
    await writeFile(join(dir, "static", f), body);
  }
  await writeFile(join(dir, "static.index.json"), JSON.stringify({ files }));
  if (manifest) await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

const imm = (file: string): Entry => ({ file, contentType: "text/javascript", cache: "immutable" });

async function fixtures() {
  const a = await nbo(
    "a",
    {
      "/": { file: "index.html", contentType: "text/html", cache: "revalidate" },
      "/assets/old.js": imm("assets/old.js"),
      "/assets/same.js": imm("assets/same.js"),
      "/assets/page.css": { file: "assets/page.css", contentType: "text/css", cache: "revalidate" },
    },
    { "index.html": "home-a", "assets/old.js": "old-bytes", "assets/same.js": "same-a", "assets/page.css": "css" },
  );
  const b = await nbo("b", { "/assets/same.js": imm("assets/same.js") }, { "assets/same.js": "same-b" }, { specVersion: "1.0", name: "b" });
  const out = await mkdtemp(join(tmpdir(), "carry-out-"));
  return { a, b, out };
}

describe("writeCarry", () => {
  it("carries only immutable entries missing from B, at the same static/ path", async () => {
    const { a, b, out } = await fixtures();
    const s = await writeCarry(a, b, out);
    expect(s.files).toBe(1);
    expect(s.bytes).toBe("old-bytes".length);
    expect(s.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(s.skipped).toBeUndefined();
    const index = JSON.parse(await readFile(join(out, "index.json"), "utf8"));
    expect(index).toEqual({
      version: 1,
      contentId: contentId({ specVersion: "1.0", name: "a" }),
      files: { "/assets/old.js": { file: "assets/old.js", contentType: "text/javascript" } },
    });
    expect(await readFile(join(out, "static", "assets", "old.js"), "utf8")).toBe("old-bytes");
    expect(await readdir(join(out, "static", "assets"))).toEqual(["old.js"]);
  });

  it("gives files 0 and a reason for a missing or invalid previous build, and still writes index.json", async () => {
    const { b, out } = await fixtures();
    const s = await writeCarry(join(out, "nope"), b, out);
    expect(s).toMatchObject({ files: 0, bytes: 0, hash: "" });
    expect(s.skipped).toMatch(/^previous build's files not kept: /);
    expect(JSON.parse(await readFile(join(out, "index.json"), "utf8"))).toEqual({ version: 1, contentId: "", files: {} });

    const bad = await nbo("bad", {}, {});
    await writeFile(join(bad, "static.index.json"), "{not json");
    const out2 = await mkdtemp(join(tmpdir(), "carry-out-"));
    const s2 = await writeCarry(bad, b, out2);
    expect(s2.files).toBe(0);
    expect(s2.skipped).toMatch(/static\.index\.json/);
  });

  it("skips when the immutable files are over the cap", async () => {
    const { a, b, out } = await fixtures();
    const s = await writeCarry(a, b, out, 4);
    expect(s).toMatchObject({ files: 0, hash: "" });
    expect(s.skipped).toMatch(/^previous build's files not kept: \d+ MiB is over the \S+ MiB limit$/);
    const full = await mkdtemp(join(tmpdir(), "carry-out-"));
    const big = await writeCarry(a, b, full, 256 * 1048576);
    expect(big.files).toBe(1);
  });

  it("states the default limit as 256 MiB", async () => {
    const { a, b, out } = await fixtures();
    const big = await nbo("big", { "/assets/big.js": imm("assets/big.js") }, {}, { specVersion: "1.0", name: "big" });
    await mkdir(join(big, "static", "assets"), { recursive: true });
    const { truncate } = await import("node:fs/promises");
    await writeFile(join(big, "static", "assets", "big.js"), "");
    await truncate(join(big, "static", "assets", "big.js"), 257 * 1048576);
    const s = await writeCarry(big, b, out);
    expect(s.skipped).toBe("previous build's files not kept: 257 MiB is over the 256 MiB limit");
    void a;
  });

  it("is deterministic and the hash follows the bytes", async () => {
    const { a, b } = await fixtures();
    const o1 = await mkdtemp(join(tmpdir(), "carry-out-"));
    const o2 = await mkdtemp(join(tmpdir(), "carry-out-"));
    const h1 = (await writeCarry(a, b, o1)).hash;
    expect((await writeCarry(a, b, o2)).hash).toBe(h1);
    await writeFile(join(a, "static", "assets", "old.js"), "old-byteZ");
    const o3 = await mkdtemp(join(tmpdir(), "carry-out-"));
    expect((await writeCarry(a, b, o3)).hash).not.toBe(h1);
  });

  it("never reads an entry that climbs out of static/", async () => {
    const { a, b, out } = await fixtures();
    await writeFile(
      join(a, "static.index.json"),
      JSON.stringify({ files: { "/assets/evil.js": imm("../manifest.json"), "/assets/old.js": imm("assets/old.js") } }),
    );
    const s = await writeCarry(a, b, out);
    expect(s.files).toBe(1);
    expect(await readdir(out)).not.toContain("manifest.json");
  });
});
