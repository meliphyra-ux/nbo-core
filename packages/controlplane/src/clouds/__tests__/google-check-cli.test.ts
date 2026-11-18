// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// nbo-server google check: the core's own self-check of its keyless Google
// connection, run on the core's machine (never through a platform).
import { describe, expect, it } from "vitest";
import { runServerCli, type ServerCliIO } from "../../server-cli.js";

const CLEAN = "Google trusts only this core's key, and nothing else can act as nbo-deployer.";

function cli(answer: unknown, status = 200) {
  const out: string[] = [];
  const err: string[] = [];
  const requests: { url: string; method: string }[] = [];
  const io: ServerCliIO = {
    fetch: (async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    readFile: async () => "",
    stdin: async () => "",
    env: {},
  };
  return { io, out, err, requests };
}

const wif = { kind: "google", auth: "wif", warnings: ["a connect note"], status: "connected" };

describe("nbo-server google check", () => {
  it("runs the connection test and prints the clean sentence, exit 0", async () => {
    const c = cli({ ...wif, checkWarnings: [], otherCores: [] });
    expect(await runServerCli(["google", "check"], c.io)).toBe(0);
    expect(c.requests).toEqual([
      { url: expect.stringMatching(/\/system\/connections\/google\/test$/), method: "POST" },
    ]);
    expect(c.out).toEqual([CLEAN]);
  });

  it("prints each warning and each other core on its own line, exit 1", async () => {
    const c = cli({
      ...wif,
      checkWarnings: ["warning one", "warning two"],
      otherCores: ["core-aaaaaaaaaaaaaaaa", "core-bbbbbbbbbbbbbbbb"],
    });
    expect(await runServerCli(["google", "check"], c.io)).toBe(1);
    expect(c.out).toEqual([
      "warning one",
      "warning two",
      "Other core this project trusts: core-aaaaaaaaaaaaaaaa",
      "Other core this project trusts: core-bbbbbbbbbbbbbbbb",
    ]);
  });

  it("lists other cores without the clean sentence when nothing else is wrong, exit 0", async () => {
    const c = cli({ ...wif, checkWarnings: [], otherCores: ["core-aaaaaaaaaaaaaaaa"] });
    expect(await runServerCli(["google", "check"], c.io)).toBe(0);
    expect(c.out).toEqual(["Other core this project trusts: core-aaaaaaaaaaaaaaaa"]);
  });

  it("a key connection has no keyless check: says so, exit 1", async () => {
    const c = cli({ kind: "google", auth: "key", warnings: [], status: "connected" });
    expect(await runServerCli(["google", "check"], c.io)).toBe(1);
    expect(c.out.join("\n")).toMatch(/uses a key/);
  });

  it("a failed test is a failure, exit 1", async () => {
    const c = cli({ error: "Cloud Run is not connected" }, 404);
    expect(await runServerCli(["google", "check"], c.io)).toBe(1);
    expect(c.err.join("\n")).toContain("Cloud Run is not connected");
  });
});
