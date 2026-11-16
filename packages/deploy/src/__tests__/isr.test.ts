// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasPrerenderRoutes, ISR_CACHE_KEY } from "../isr.js";

describe("hasPrerenderRoutes", () => {
  it("is false when prerender.json is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "isr-"));
    expect(await hasPrerenderRoutes(dir)).toBe(false);
  });

  it("is false for an empty prerenders list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "isr-"));
    await writeFile(join(dir, "prerender.json"), JSON.stringify({ prerenders: [] }));
    expect(await hasPrerenderRoutes(dir)).toBe(false);
  });

  it("is false when prerenders is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "isr-"));
    await writeFile(join(dir, "prerender.json"), JSON.stringify({}));
    expect(await hasPrerenderRoutes(dir)).toBe(false);
  });

  it("is true for one prerender route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "isr-"));
    await writeFile(
      join(dir, "prerender.json"),
      JSON.stringify({ prerenders: [{ id: "/blog/[slug]", function: "ssr", expiration: 60 }] }),
    );
    expect(await hasPrerenderRoutes(dir)).toBe(true);
  });
});

describe("ISR_CACHE_KEY", () => {
  it("is the pinned /functions.json key", () => {
    expect(ISR_CACHE_KEY).toBe("__isrcache");
  });
});
