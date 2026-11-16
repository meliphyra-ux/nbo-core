// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { run, type Transcript } from "../conformance.js";

let opensslAvailable = true;
try {
  execFileSync("openssl", ["version"]);
} catch {
  opensslAvailable = false;
}

function createSelfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "conformance-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  try {
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
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

function sha256Digest(raw: string): string {
  return "sha256:" + createHash("sha256").update(raw).digest("hex");
}

let server: Server | undefined;
let httpsServer: HttpsServer | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (httpsServer) {
    await new Promise<void>((resolve) => httpsServer!.close(() => resolve()));
    httpsServer = undefined;
  }
});

describe("run: expectHeaders", () => {
  it("reports a header that differs or is missing, next to a body check", async () => {
    const url = await startBackend((_req, res) => {
      res.setHeader("cache-control", "private, no-store");
      res.end("page");
    });
    const check = (expectHeaders: Record<string, string>): Promise<string[]> =>
      run(url, [{ method: "GET", path: "/", expectStatus: 200, expectBodyContains: "page", expectHeaders }], false);
    expect(await check({ "Cache-Control": "private, no-store" })).toEqual([]);
    expect(await check({ "cache-control": "no-cache" })).toEqual([
      '/: expected header cache-control "no-cache", got "private, no-store"',
    ]);
    expect(await check({ "x-missing": "1" })).toEqual(['/: expected header x-missing "1", got null']);
  });
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

describe("run", () => {
  it("passes when every transcript matches", async () => {
    const baseURL = await startBackend((_req, res) => res.writeHead(200).end("hello"));
    const transcripts: Transcript[] = [
      { method: "GET", path: "/", expectStatus: 200, expectBodySha256: sha256Digest("hello") },
    ];

    const errors = await run(baseURL, transcripts, false);

    expect(errors).toHaveLength(0);
  });

  it("reports status and body mismatches by path", async () => {
    const baseURL = await startBackend((req, res) => {
      if (req.url === "/a") res.writeHead(404).end();
      else res.writeHead(200).end("wrong-body");
    });
    const transcripts: Transcript[] = [
      { method: "GET", path: "/a", expectStatus: 200 },
      { method: "GET", path: "/b", expectStatus: 200, expectBodySha256: sha256Digest("right-body") },
    ];

    const errors = await run(baseURL, transcripts, false);

    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.includes("/a"))).toBe(true);
    expect(errors.some((e) => e.includes("/b"))).toBe(true);
  });

  it("reports a body digest mismatch even when status matches", async () => {
    const baseURL = await startBackend((_req, res) => res.writeHead(200).end("actual"));
    const transcripts: Transcript[] = [
      { method: "GET", path: "/", expectStatus: 200, expectBodySha256: sha256Digest("expected") },
    ];

    const errors = await run(baseURL, transcripts, false);

    expect(errors).toHaveLength(1);
  });

  it("expectBodyContains matches on substring", async () => {
    const baseURL = await startBackend((_req, res) => res.writeHead(200).end("hello world"));
    const transcripts: Transcript[] = [{ method: "GET", path: "/", expectStatus: 200, expectBodyContains: "wor" }];

    const errors = await run(baseURL, transcripts, false);

    expect(errors).toHaveLength(0);
  });

  it("expectBodyContains fails when the substring is missing", async () => {
    const baseURL = await startBackend((_req, res) => res.writeHead(200).end("hello world"));
    const transcripts: Transcript[] = [{ method: "GET", path: "/", expectStatus: 200, expectBodyContains: "nope" }];

    const errors = await run(baseURL, transcripts, false);

    expect(errors).toHaveLength(1);
  });

  it("a status-only transcript skips the body check entirely", async () => {
    const baseURL = await startBackend((_req, res) => res.writeHead(200).end("anything at all"));
    const transcripts: Transcript[] = [{ method: "GET", path: "/", expectStatus: 200 }];

    const errors = await run(baseURL, transcripts, false);

    expect(errors).toHaveLength(0);
  });

  it("sends the transcript's own request body", async () => {
    let gotBody = "";
    const baseURL = await startBackend((req, res) => {
      req.on("data", (c) => (gotBody += c));
      req.on("end", () => res.writeHead(200).end());
    });
    const transcripts: Transcript[] = [{ method: "POST", path: "/", body: '{"tags":["x"]}', expectStatus: 200 }];

    await run(baseURL, transcripts, false);

    expect(gotBody).toBe('{"tags":["x"]}');
  });

  it("sends the transcript's own request headers", async () => {
    let gotHeader: string | undefined;
    const baseURL = await startBackend((req, res) => {
      gotHeader = req.headers["x-custom"] as string | undefined;
      res.writeHead(200).end();
    });
    const transcripts: Transcript[] = [
      { method: "GET", path: "/", headers: { "X-Custom": "value" }, expectStatus: 200 },
    ];

    await run(baseURL, transcripts, false);

    expect(gotHeader).toBe("value");
  });
});

describe.skipIf(!opensslAvailable)("run (TLS)", () => {
  function startSelfSignedBackend(handler: (req: IncomingMessage, res: ServerResponse) => void): string {
    const { key, cert } = createSelfSignedCert();
    httpsServer = createHttpsServer({ key, cert }, handler);
    httpsServer.listen(0);
    const { port } = httpsServer.address() as AddressInfo;
    return `https://127.0.0.1:${port}`;
  }

  it("rejects a self-signed cert by default", async () => {
    const baseURL = startSelfSignedBackend((_req, res) => res.writeHead(200).end("ok"));
    const transcripts: Transcript[] = [{ method: "GET", path: "/", expectStatus: 200 }];

    const errors = await run(baseURL, transcripts, false);

    expect(errors).toHaveLength(1);
  });

  it("insecure:true skips cert verification", async () => {
    const baseURL = startSelfSignedBackend((_req, res) => res.writeHead(200).end("ok"));
    const transcripts: Transcript[] = [
      { method: "GET", path: "/", expectStatus: 200, expectBodySha256: sha256Digest("ok") },
    ];

    const errors = await run(baseURL, transcripts, true);

    expect(errors).toHaveLength(0);
  });
});

describe("run: expectHeaderPatterns", () => {
  it("matches the whole value; a mismatch or a missing header is one error naming the path", async () => {
    const url = await startBackend((_req, res) => {
      res.setHeader("x-nbo-deployment-id", "sha256:" + "b".repeat(64));
      res.end("page");
    });
    const check = (expectHeaderPatterns: Record<string, string>): Promise<string[]> =>
      run(url, [{ method: "GET", path: "/p", expectStatus: 200, expectHeaderPatterns }], false);
    expect(await check({ "X-Nbo-Deployment-Id": "sha256:[0-9a-f]{64}" })).toEqual([]);
    expect(await check({ "x-nbo-deployment-id": "sha256:[0-9a-f]{10}" })).toHaveLength(1);
    const missing = await check({ "x-missing": ".*" });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("/p");
  });
});
