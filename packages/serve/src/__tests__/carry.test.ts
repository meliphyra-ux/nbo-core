// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../serve.js";
import { loadCarry, CARRIED_FROM_HEADER } from "../carry.js";

const A_ID = "sha256:" + "a".repeat(64);
const B_ID = "sha256:" + "b".repeat(64);

async function buildB(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "carry-b-"));
  await mkdir(join(dir, "static"), { recursive: true });
  await writeFile(join(dir, "static", "index.html"), "home-b");
  await writeFile(join(dir, "static", "shared.js"), "shared-from-b");
  await writeFile(
    join(dir, "static.index.json"),
    JSON.stringify({
      files: {
        "/": { file: "index.html", contentType: "text/html; charset=utf-8", cache: "revalidate" },
        "/assets/shared.js": { file: "shared.js", contentType: "text/javascript", cache: "immutable" },
      },
    }),
  );
  await writeFile(
    join(dir, "routes.json"),
    JSON.stringify({
      version: 1,
      beforeFiles: [
        {
          id: "go",
          match: { path: "^/assets/old\\.js$" },
          action: { type: "redirect", location: "/assets/shared.js", status: 308 },
        },
      ],
    }),
  );
  return dir;
}

async function buildCarry(
  files: Record<string, { file: string; contentType: string }>,
  contents: Record<string, string> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "carry-a-"));
  await mkdir(join(dir, "static"), { recursive: true });
  for (const [name, body] of Object.entries(contents)) await writeFile(join(dir, "static", name), body);
  await writeFile(join(dir, "index.json"), JSON.stringify({ version: 1, contentId: A_ID, files }));
  return dir;
}

async function setup(extra: Record<string, { file: string; contentType: string }> = {}) {
  const bDir = await buildB();
  const carryDir = await buildCarry(
    {
      "/assets/old-123.js": { file: "old-123.js", contentType: "text/javascript" },
      "/assets/shared.js": { file: "shared.js", contentType: "text/javascript" },
      "/assets/old.js": { file: "old-123.js", contentType: "text/javascript" },
      "/assets/my file.js": { file: "my file.js", contentType: "text/javascript" },
      "/assets/evil.js": { file: "../../manifest.json", contentType: "application/json" },
      "/": { file: "index.html", contentType: "text/html" },
      ...extra,
    },
    { "old-123.js": "old-bytes", "shared.js": "shared-from-a", "my file.js": "spaced", "index.html": "home-a" },
  );
  await writeFile(join(bDir, "manifest.json"), "{}");
  const handler = await createHandler(bDir, undefined, undefined, { deploymentId: B_ID, carryDir });
  return { handler, bDir, carryDir };
}

describe("carried files", () => {
  it("answers a carried path B lacks with the entry's headers", async () => {
    const { handler } = await setup();
    const res = await handler(new Request("http://x/assets/old-123.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("old-bytes");
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(res.headers.get("cache-control")).toBe("max-age=31536000, immutable");
    expect(res.headers.get(CARRIED_FROM_HEADER)).toBe(A_ID);
    expect(res.headers.get("x-nbo-deployment-id")).toBe(B_ID);
  });

  it("HEAD gives headers and an empty body", async () => {
    const { handler } = await setup();
    const res = await handler(new Request("http://x/assets/old-123.js", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get(CARRIED_FROM_HEADER)).toBe(A_ID);
    expect(res.headers.get("content-type")).toBe("text/javascript");
  });

  it("a path in both builds serves B's bytes with no carried-from header", async () => {
    const { handler } = await setup();
    const res = await handler(new Request("http://x/assets/shared.js"));
    expect(await res.text()).toBe("shared-from-b");
    expect(res.headers.has(CARRIED_FROM_HEADER)).toBe(false);
  });

  it("a path B redirects stays a redirect", async () => {
    const { handler } = await setup();
    const res = await handler(new Request("http://x/assets/old.js", { redirect: "manual" }));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/assets/shared.js");
    expect(res.headers.has(CARRIED_FROM_HEADER)).toBe(false);
  });

  it("an entry escaping the carry dir stays a 404", async () => {
    const { handler } = await setup();
    const res = await handler(new Request("http://x/assets/evil.js"));
    expect(res.status).toBe(404);
    expect(res.headers.has(CARRIED_FROM_HEADER)).toBe(false);
  });

  it("an entry whose file is missing stays a 404", async () => {
    const { handler } = await setup({ "/assets/gone.js": { file: "gone.js", contentType: "text/javascript" } });
    const res = await handler(new Request("http://x/assets/gone.js"));
    expect(res.status).toBe(404);
  });

  it("POST to a carried path is B's normal answer", async () => {
    const { handler } = await setup();
    const res = await handler(new Request("http://x/assets/old-123.js", { method: "POST" }));
    expect(res.status).toBe(404);
    expect(res.headers.has(CARRIED_FROM_HEADER)).toBe(false);
  });

  it("matches a %20 path against its decoded key", async () => {
    const { handler } = await setup();
    const res = await handler(new Request("http://x/assets/my%20file.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("spaced");
  });

  it("an unknown path stays a 404", async () => {
    const { handler } = await setup();
    expect((await handler(new Request("http://x/nope.js"))).status).toBe(404);
  });
});

describe("loadCarry", () => {
  it("a carry dir with invalid JSON returns null once and B still serves /", async () => {
    const bDir = await buildB();
    const carryDir = await mkdtemp(join(tmpdir(), "carry-bad-"));
    await writeFile(join(carryDir, "index.json"), "{not json");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadCarry(carryDir)).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
    const handler = await createHandler(bDir, undefined, undefined, { deploymentId: B_ID });
    expect(await (await handler(new Request("http://x/"))).text()).toBe("home-b");
  });

  it("returns null for a missing dir, wrong version or bad entries", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadCarry(join(tmpdir(), "carry-does-not-exist"))).toBeNull();
    for (const doc of [
      { version: 2, contentId: A_ID, files: {} },
      { version: 1, contentId: 5, files: {} },
      { version: 1, contentId: A_ID, files: { "/a": { file: 1, contentType: "x" } } },
      { version: 1, contentId: A_ID, files: { "/a": { file: "a" } } },
      { version: 1, contentId: A_ID },
    ]) {
      const dir = await mkdtemp(join(tmpdir(), "carry-v-"));
      await writeFile(join(dir, "index.json"), JSON.stringify(doc));
      expect(await loadCarry(dir)).toBeNull();
    }
    err.mockRestore();
  });

  it("loads a valid carry", async () => {
    const dir = await buildCarry({ "/a": { file: "a", contentType: "text/plain" } });
    const c = await loadCarry(dir);
    expect(c?.index.contentId).toBe(A_ID);
    expect(c?.dir).toBe(dir);
  });
});
