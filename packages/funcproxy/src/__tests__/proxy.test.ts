// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import * as zlib from "node:zlib";
import { gzipSync } from "node:zlib";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "undici";
import { proxyRequest, hostScriptPath, fetchDecoded, FETCH_DECODED_CODINGS } from "../proxy.js";

let opensslAvailable = true;
try {
  execFileSync("openssl", ["version"]);
} catch {
  opensslAvailable = false;
}

// A throwaway self-signed cert generated fresh per test run via the
// real openssl binary already on PATH in this environment — no new
// npm dependency just to generate one PEM pair for one test.
function createSelfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "funcproxy-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  try {
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
    ]);
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("hostScriptPath", () => {
  it("returns a path to a file that exists on disk", () => {
    expect(existsSync(hostScriptPath())).toBe(true);
  });
});

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function startBackend(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("proxyRequest", () => {
  // Final-review finding (sub-project 7, @nbo/serve's middleware
  // invoker): this function only ever read options.signal, never the
  // incoming request's own — a caller aborting its own request
  // (e.g. a timed-out middleware budget) left the outbound fetch
  // running for however long the backend took, leaking a connection.
  it("cancels the outgoing request when the incoming request's own signal aborts", async () => {
    let aborted = false;
    let requestReceived = false;
    const backendURL = await startBackend((req) => {
      requestReceived = true;
      req.on("aborted", () => {
        aborted = true;
      });
      // deliberately never responds
    });

    const controller = new AbortController();
    const request = new Request("http://example.com/slow", { signal: controller.signal });
    const proxyPromise = proxyRequest(request, new URL(backendURL)).catch(() => {});

    const receivedDeadline = Date.now() + 2000;
    while (!requestReceived && Date.now() < receivedDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    controller.abort();
    await proxyPromise;

    const deadline = Date.now() + 2000;
    while (!aborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(aborted).toBe(true);
  });

  it("passes a 3xx response straight back instead of following the redirect", async () => {
    const backendURL = await startBackend((req, res) => {
      if (req.url === "/x") {
        res.writeHead(302, { Location: "/login" });
        res.end();
      } else {
        res.writeHead(200).end("LOGIN PAGE");
      }
    });

    const response = await proxyRequest(new Request("http://example.com/x"), new URL(backendURL));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("does not forward a stale content-encoding/content-length once the body has already been decompressed", async () => {
    const compressed = gzipSync(Buffer.from("hello world"));
    const backendURL = await startBackend((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip", "content-length": String(compressed.length) });
      res.end(compressed);
    });

    const response = await proxyRequest(new Request("http://example.com/x"), new URL(backendURL));

    expect(await response.text()).toBe("hello world");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("strips hop-by-hop request headers instead of forwarding them as-is, so the proxied request doesn't fail", async () => {
    // fetch() throws outright ("invalid transfer-encoding header") if
    // this request header is forwarded as-is — the wire framing
    // fetch() itself chooses for a streamed body is a separate,
    // legitimate concern this test doesn't assert on.
    const backendURL = await startBackend((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => res.end(`got:${body}`));
    });

    const request = new Request("http://example.com/x", {
      method: "POST",
      headers: { "transfer-encoding": "chunked", connection: "keep-alive" },
      body: "hi",
    });
    const response = await proxyRequest(request, new URL(backendURL));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("got:hi");
  });

  it("joins the target's own path/query with the request's, instead of overwriting them", async () => {
    let gotURL: string | undefined;
    const backendURL = await startBackend((req, res) => {
      gotURL = req.url;
      res.end();
    });

    const target = new URL(`${backendURL}/prefix/?a=1`);
    const response = await proxyRequest(new Request("http://example.com/x?b=2"), target);

    expect(response.status).toBe(200);
    expect(gotURL).toBe("/prefix/x?a=1&b=2");
  });
});

describe.skipIf(!opensslAvailable)("proxyRequest's dispatcher option", () => {
  let httpsServer: HttpsServer | undefined;

  afterEach(async () => {
    if (httpsServer) {
      await new Promise<void>((resolve) => httpsServer!.close(() => resolve()));
      httpsServer = undefined;
    }
  });

  function startSelfSignedBackend(): string {
    const { key, cert } = createSelfSignedCert();
    httpsServer = createHttpsServer({ key, cert }, (_req, res) => res.end("secure response"));
    httpsServer.listen(0);
    const { port } = httpsServer.address() as AddressInfo;
    return `https://127.0.0.1:${port}`;
  }

  it("rejects a self-signed backend cert when no dispatcher is given", async () => {
    const backendURL = startSelfSignedBackend();

    await expect(proxyRequest(new Request("http://example.com/"), new URL(backendURL))).rejects.toThrow();
  });

  it("succeeds against the same self-signed backend when a verification-skipping dispatcher is passed", async () => {
    const backendURL = startSelfSignedBackend();
    const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });

    const response = await proxyRequest(new Request("http://example.com/"), new URL(backendURL), undefined, {
      dispatcher,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("secure response");
  });
});

// --- content-encoding: strip only what fetch() really decoded ---

const PLAIN = "hello hello hello hello hello hello hello hello";

function encodeWith(coding: string, input: string): Buffer | null {
  switch (coding) {
    case "gzip":
    case "x-gzip":
      return zlib.gzipSync(input);
    case "deflate":
      return zlib.deflateSync(input);
    case "br":
      return zlib.brotliCompressSync(input);
    case "zstd": {
      const z = (zlib as unknown as { zstdCompressSync?: (b: string) => Buffer }).zstdCompressSync;
      return z ? z(input) : null;
    }
    default:
      return null;
  }
}

// Answers what the query asks: ?ce=<header value>&status=<n>&raw=<coding to encode the body with, or plain>.
let encServer: Server | undefined;
async function listenOn(server: Server): Promise<string> {
  encServer = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function startEncodingBackend(): Promise<string> {
  return listenOn(
    createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const ce = url.searchParams.get("ce");
      const status = Number(url.searchParams.get("status") ?? "200");
      const raw = url.searchParams.get("raw") ?? "plain";
      const body = raw === "plain" ? Buffer.from(PLAIN) : (encodeWith(raw, PLAIN) ?? Buffer.from(PLAIN));
      const headers: Record<string, string | number> = {};
      if (ce !== null) headers["content-encoding"] = ce;
      if (status !== 304 && status !== 204) headers["content-length"] = body.length;
      res.writeHead(status, headers);
      res.end(req.method === "HEAD" || status === 304 || status === 204 ? undefined : body);
    }),
  );
}
afterEach(() => {
  encServer?.close();
  encServer?.closeAllConnections();
  encServer = undefined;
});

describe("fetchDecoded", () => {
  it("is false for methods and statuses where fetch decodes nothing", () => {
    expect(fetchDecoded("HEAD", 200, "gzip")).toBe(false);
    expect(fetchDecoded("CONNECT", 200, "gzip")).toBe(false);
    for (const status of [101, 204, 205, 304]) expect(fetchDecoded("GET", status, "gzip")).toBe(false);
  });
  it("is false for an absent or empty header", () => {
    expect(fetchDecoded("GET", 200, null)).toBe(false);
    expect(fetchDecoded("GET", 200, "")).toBe(false);
  });
  it("trims and lower-cases, and needs every coding known", () => {
    expect(fetchDecoded("GET", 200, " GZIP ")).toBe(true);
    expect(fetchDecoded("GET", 200, "gzip, br")).toBe(true);
    expect(fetchDecoded("GET", 200, "gzip, x-custom")).toBe(false);
    expect(fetchDecoded("GET", 200, "x-custom")).toBe(false);
    expect(fetchDecoded("GET", 200, "identity")).toBe(false);
    expect(fetchDecoded("GET", 200, "gzip,")).toBe(false);
  });
});

describe("FETCH_DECODED_CODINGS matches the running Node's fetch()", () => {
  for (const coding of ["gzip", "x-gzip", "deflate", "br", "zstd"]) {
    it(`probe: ${coding}`, async () => {
      const raw = coding === "x-gzip" ? "gzip" : coding;
      if (!encodeWith(raw, PLAIN)) return; // this Node's zlib cannot make it
      const base = await startEncodingBackend();
      const res = await fetch(`${base}/?ce=${coding}&raw=${raw}`);
      const decoded = (await res.text()) === PLAIN;
      expect(decoded).toBe(FETCH_DECODED_CODINGS.has(coding));
    });
  }
});

describe("proxyRequest content-encoding", () => {
  async function through(path: string, method = "GET") {
    const base = await startEncodingBackend();
    const res = await proxyRequest(new Request(`http://example.com${path}`, { method }), new URL(base));
    return { res, bytes: Buffer.from(await res.arrayBuffer()) };
  }

  for (const coding of ["gzip", "br"]) {
    it(`GET ${coding} comes back decoded without stale headers`, async () => {
      const { res, bytes } = await through(`/?ce=${coding}&raw=${coding}`);
      expect(bytes.toString()).toBe(PLAIN);
      expect(res.headers.has("content-encoding")).toBe(false);
      expect(res.headers.has("content-length")).toBe(false);
    });
  }

  it("GET with two codings decodes both layers", async () => {
    const body = zlib.gzipSync(zlib.brotliCompressSync(PLAIN));
    const base = await listenOn(
      createServer((_req, res) => {
        res.writeHead(200, { "content-encoding": "br, gzip", "content-length": body.length });
        res.end(body);
      }),
    );
    const res = await proxyRequest(new Request("http://example.com/"), new URL(base));
    expect(await res.text()).toBe(PLAIN);
    expect(res.headers.has("content-encoding")).toBe(false);
    expect(res.headers.has("content-length")).toBe(false);
  });

  it("HEAD keeps content-encoding", async () => {
    const { res } = await through("/?ce=gzip&raw=gzip", "HEAD");
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  it("304 keeps content-encoding", async () => {
    const { res } = await through("/?ce=gzip&raw=gzip&status=304");
    expect(res.status).toBe(304);
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  for (const ce of ["x-custom", "identity", "gzip,"]) {
    it(`GET ${JSON.stringify(ce)} keeps the header and the exact raw bytes`, async () => {
      const { res, bytes } = await through(`/?ce=${encodeURIComponent(ce)}&raw=plain`);
      expect(res.headers.get("content-encoding")).toBe(ce);
      expect(bytes.toString()).toBe(PLAIN);
    });
  }

  it("GET gzip, x-custom keeps the header and the compressed bytes", async () => {
    const { res, bytes } = await through(`/?ce=${encodeURIComponent("gzip, x-custom")}&raw=gzip`);
    expect(res.headers.get("content-encoding")).toBe("gzip, x-custom");
    expect(bytes.equals(zlib.gzipSync(PLAIN))).toBe(true);
  });
});
