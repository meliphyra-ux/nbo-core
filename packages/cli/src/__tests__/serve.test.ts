// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentId } from "@nbo/digest";
import { ISR_CACHE_KEY } from "@nbo/serve";
import {
  readBakedEnv,
  resolveFunctions,
  resolveISRCache,
  parseServeArgs,
  manifestContentId,
  protectionFromEnv,
} from "../serve.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nbo-cli-serve-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readBakedEnv", () => {
  it("parses an existing file", async () => {
    const path = join(dir, "env.json");
    writeFileSync(path, JSON.stringify({ NBO_ISRCACHE_URL: "http://x" }));

    expect(await readBakedEnv(path)).toEqual({ NBO_ISRCACHE_URL: "http://x" });
  });

  it("a missing file is nil, not an error", async () => {
    expect(await readBakedEnv(join(dir, "nope.json"))).toBeNull();
  });
});

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

// The metadata server (http://metadata.google.internal) is unreachable
// outside a real GCP environment, which is exactly what distinguishes
// these two tests without needing one: if resolveFunctions picked the
// authenticated resolver, the token fetch fails and the backend is
// never reached; if it picked the plain static-URL resolver, the
// backend is reached directly.
describe("resolveFunctions", () => {
  it("routes through the authenticated resolver on Cloud Run", async () => {
    let backendHit = false;
    server = createServer((_req, res) => {
      backendHit = true;
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    process.env.K_SERVICE = "next-app";
    try {
      const { resolve } = await resolveFunctions(dir, { ssr: `http://127.0.0.1:${port}` });
      const handler = resolve!("ssr");
      const response = await handler(new Request("http://x/x"));
      expect(response.status).not.toBe(200);
      expect(backendHit).toBe(false);
    } finally {
      delete process.env.K_SERVICE;
    }
  });

  it("signs function calls (SigV4) on AWS Lambda", async () => {
    let auth: string | undefined;
    server = createServer((req, res) => {
      auth = req.headers.authorization;
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    const set = {
      AWS_LAMBDA_FUNCTION_NAME: "app",
      AWS_REGION: "eu-west-1",
      AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret",
    };
    const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
    Object.assign(process.env, set);
    try {
      const { resolve } = await resolveFunctions(dir, { ssr: `http://127.0.0.1:${port}` });
      await resolve!("ssr")(new Request("http://x/x"));
      expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/lambda\/aws4_request, /);
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });

  it("uses the plain static-URL resolver off Cloud Run", async () => {
    server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    delete process.env.K_SERVICE;
    const { resolve } = await resolveFunctions(dir, { ssr: `http://127.0.0.1:${port}` });
    const handler = resolve!("ssr");
    const response = await handler(new Request("http://x/x"));

    expect(await response.text()).toBe("ok");
  });
});

describe("parseServeArgs", () => {
  it("parses dir, port, and function overrides", () => {
    expect(parseServeArgs(["dir", "--port", "5000", "--function", "ssr=http://x"])).toEqual({
      dir: "dir",
      port: "5000",
      functionURLs: { ssr: "http://x" },
    });
  });

  it("parses --carry", () => {
    expect(parseServeArgs(["dir", "--carry", "/x"])).toEqual({
      dir: "dir",
      port: "4000",
      functionURLs: {},
      carryDir: "/x",
    });
  });

  it("defaults port to 4000 with none given", () => {
    expect(parseServeArgs(["dir"])).toEqual({ dir: "dir", port: "4000", functionURLs: {} });
  });
});

describe("manifestContentId", () => {
  it("equals contentId of the manifest, and is undefined without manifest.json", async () => {
    const manifest = { version: 1, name: "x", build: { at: "now" } };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    expect(await manifestContentId(dir)).toBe(contentId(manifest));
    expect(await manifestContentId(join(dir, "nowhere"))).toBeUndefined();
  });
});

describe("the ISR cache from /functions.json", () => {
  async function echoServer(text: string): Promise<string> {
    server = createServer((_req, res) => res.end(text));
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("the key is __isrcache", () => {
    expect(ISR_CACHE_KEY).toBe("__isrcache");
  });

  it("resolveISRCache uses the map's __isrcache with no NBO_ISRCACHE_URL", async () => {
    const saved = process.env.NBO_ISRCACHE_URL;
    delete process.env.NBO_ISRCACHE_URL;
    delete process.env.K_SERVICE;
    try {
      const url = await echoServer("from map");
      const resolve = resolveISRCache({ ssr: "http://127.0.0.1:1", __isrcache: url });
      expect(resolve).toBeDefined();
      const res = await resolve!("__isrcache")(new Request("http://isrcache/entries/k"));
      expect(await res.text()).toBe("from map");
    } finally {
      if (saved !== undefined) process.env.NBO_ISRCACHE_URL = saved;
    }
  });

  it("resolveISRCache prefers NBO_ISRCACHE_URL over the map", async () => {
    const saved = process.env.NBO_ISRCACHE_URL;
    delete process.env.K_SERVICE;
    try {
      process.env.NBO_ISRCACHE_URL = await echoServer("from env");
      const resolve = resolveISRCache({ __isrcache: "http://127.0.0.1:1" });
      const res = await resolve!("__isrcache")(new Request("http://isrcache/entries/k"));
      expect(await res.text()).toBe("from env");
    } finally {
      if (saved === undefined) delete process.env.NBO_ISRCACHE_URL;
      else process.env.NBO_ISRCACHE_URL = saved;
    }
  });

  it("resolveISRCache is undefined with neither", () => {
    const saved = process.env.NBO_ISRCACHE_URL;
    delete process.env.NBO_ISRCACHE_URL;
    try {
      expect(resolveISRCache({ ssr: "http://x" })).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.NBO_ISRCACHE_URL = saved;
    }
  });

  it("resolveFunctions never treats __isrcache as a function", async () => {
    delete process.env.K_SERVICE;
    const url = await echoServer("ok");
    const { resolve } = await resolveFunctions(dir, { ssr: url, __isrcache: url });
    expect(await (await resolve!("ssr")(new Request("http://x/x"))).text()).toBe("ok");
    expect(() => resolve!("__isrcache")).toThrow(/__isrcache/);
  });

  it("a map holding only __isrcache resolves no functions", async () => {
    const { resolve } = await resolveFunctions(dir, { __isrcache: "http://127.0.0.1:1" });
    expect(resolve).toBeUndefined();
  });
});

describe("protectionFromEnv", () => {
  const hash = "scrypt$16384$8$1$BwcHBwcHBwcHBwcHBwcHBw$jqNYMZJ6k8yP9UrEwEFdAphyQW3NDqRG8javhwKNA-0";

  it("is off without NBO_PROTECTION, or with it empty", () => {
    expect(protectionFromEnv({})).toBeUndefined();
    expect(protectionFromEnv({ NBO_PROTECTION: "" })).toBeUndefined();
  });

  it("passes the hash and the cron signing secret to the handler", () => {
    expect(protectionFromEnv({ NBO_PROTECTION: hash, NBO_CRON_SIGNING_SECRET: "c" })).toEqual({
      hash,
      cronSecret: "c",
    });
    expect(protectionFromEnv({ NBO_PROTECTION: hash })).toEqual({ hash });
  });

  it("refuses a malformed NBO_PROTECTION, naming the variable and not the value", () => {
    expect(() => protectionFromEnv({ NBO_PROTECTION: "hunter2-secret" })).toThrow(/NBO_PROTECTION/);
    try {
      protectionFromEnv({ NBO_PROTECTION: "hunter2-secret" });
    } catch (err) {
      expect(String(err)).not.toContain("hunter2-secret");
    }
  });
});
