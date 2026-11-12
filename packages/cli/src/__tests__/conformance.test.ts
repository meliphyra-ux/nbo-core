// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTranscripts, runConformance } from "../conformance.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nbo-cli-conformance-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadTranscripts", () => {
  it("reads every *.json file sorted by filename", async () => {
    writeFileSync(join(dir, "b.json"), JSON.stringify({ method: "GET", path: "/b", expectStatus: 200 }));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ method: "GET", path: "/a", expectStatus: 200 }));

    const transcripts = await loadTranscripts(dir);

    expect(transcripts.map((t) => t.path)).toEqual(["/a", "/b"]);
  });

  it("ignores a non-JSON file in the same directory", async () => {
    writeFileSync(join(dir, "a.json"), JSON.stringify({ method: "GET", path: "/a", expectStatus: 200 }));
    writeFileSync(join(dir, "README.md"), "not a transcript");

    const transcripts = await loadTranscripts(dir);

    expect(transcripts).toHaveLength(1);
  });

  it("wraps a malformed JSON file's parse error with its own filename", async () => {
    writeFileSync(join(dir, "bad.json"), "{not valid json");

    await expect(loadTranscripts(dir)).rejects.toThrow(/bad\.json/);
  });
});

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("runConformance", () => {
  it("missing args returns 1 with the usage message", async () => {
    expect(await runConformance([])).toBe(1);
  });

  it("returns 0 when every transcript passes against a real local server", async () => {
    server = createServer((_req, res) => res.writeHead(200).end("ok"));
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    writeFileSync(join(dir, "a.json"), JSON.stringify({ method: "GET", path: "/", expectStatus: 200, expectBodyContains: "ok" }));

    expect(await runConformance([dir, `http://127.0.0.1:${port}`])).toBe(0);
  });

  it("returns 1 when a transcript fails, printing the mismatch", async () => {
    server = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    writeFileSync(join(dir, "a.json"), JSON.stringify({ method: "GET", path: "/", expectStatus: 200 }));

    expect(await runConformance([dir, `http://127.0.0.1:${port}`])).toBe(1);
  });
});
