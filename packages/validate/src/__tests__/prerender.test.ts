// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "@nbo/digest";
import { fileDigest } from "../digests.js";
import { checkPrerender } from "../prerender.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nbo-validate-prerender-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const goodDoc = {
  version: 1,
  prerenders: [
    {
      id: "/isr",
      match: "^/isr$",
      function: "ssr",
      revalidateSec: 60,
      expireSec: 31536000,
      seeds: { "/isr": { file: "/isr" } },
      onMiss: "blocking",
      bypassToken: { env: "NBO_PRERENDER_BYPASS" },
    },
  ],
};

function writePrerender(doc: unknown): { digests: Record<string, string> } {
  const raw = Buffer.from(canonicalize(doc));
  writeFileSync(join(dir, "prerender.json"), raw);
  return { digests: { "prerender.json": fileDigest(raw) } };
}

describe("checkPrerender", () => {
  it("returns no errors and the doc when there is no prerender.json and no digest", () => {
    expect(checkPrerender(dir, { digests: {} })).toEqual({ errors: [] });
  });

  it("accepts a schema-valid, canonical prerender.json whose digest matches", () => {
    const manifest = writePrerender(goodDoc);
    const { errors, doc } = checkPrerender(dir, manifest);
    expect(errors).toEqual([]);
    expect(doc).toEqual(goodDoc);
  });

  it("fails on a digest mismatch, in checkManifestDigests's form", () => {
    writePrerender(goodDoc);
    const want = "sha256:" + "0".repeat(64);
    const { errors } = checkPrerender(dir, { digests: { "prerender.json": want } });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(
      /^prerender\.json: digest mismatch: manifest says sha256:0{64}, actual is sha256:[0-9a-f]{64}$/,
    );
  });

  it("fails on a schema error", () => {
    const manifest = writePrerender({ ...goodDoc, prerenders: [{ ...goodDoc.prerenders[0], onMiss: "sometimes" }] });
    const { errors } = checkPrerender(dir, manifest);
    expect(errors.some((e) => e.message.startsWith("prerender.json: schema validation failed"))).toBe(true);
  });

  it("fails when prerender.json exists but the manifest has no digest for it", () => {
    writePrerender(goodDoc);
    const { errors } = checkPrerender(dir, { digests: {} });
    expect(errors.map((e) => e.message)).toEqual([
      "prerender.json: present, but manifest.json digests has no entry for it",
    ]);
  });

  it("fails when the manifest has a digest but prerender.json is missing", () => {
    const { errors } = checkPrerender(dir, { digests: { "prerender.json": "sha256:" + "0".repeat(64) } });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("prerender.json: manifest.json digests names it, but");
  });

  it("fails on non-canonical JSON", () => {
    const raw = Buffer.from(JSON.stringify(goodDoc, null, 2));
    writeFileSync(join(dir, "prerender.json"), raw);
    const { errors } = checkPrerender(dir, { digests: { "prerender.json": fileDigest(raw) } });
    expect(errors.map((e) => e.message)).toEqual(["prerender.json: not canonical JSON (RFC 8785)"]);
  });

  it("fails on invalid JSON without throwing", () => {
    writeFileSync(join(dir, "prerender.json"), "{not json");
    const { errors } = checkPrerender(dir, { digests: { "prerender.json": "sha256:" + "0".repeat(64) } });
    expect(errors.some((e) => e.message.includes("prerender.json: invalid JSON"))).toBe(true);
  });
});
