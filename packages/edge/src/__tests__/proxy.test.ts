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
import { Agent } from "undici";
import { createRegistry } from "../registry.js";
import { CLIENT_IP_HEADER } from "@nbo/nodehost";
import { createCloudflareTrust } from "../cloudflare-trust.js";
import {
  createProxyHandler,
  edgeResponseHeaderTimeoutMs,
  fanOutRevalidate,
  isRevalidateRequest,
  setEdgeStrictDispatcherForTest,
} from "../proxy.js";
import type { Backend } from "../registry.js";

let opensslAvailable = true;
try {
  execFileSync("openssl", ["version"]);
} catch {
  opensslAvailable = false;
}

function createSelfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "edge-tls-"));
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

function startBackend(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function startSelfSignedBackend(handler: (req: IncomingMessage, res: ServerResponse) => void): string {
  const { key, cert } = createSelfSignedCert();
  httpsServer = createHttpsServer({ key, cert }, handler);
  httpsServer.listen(0);
  const { port } = httpsServer.address() as AddressInfo;
  return `https://127.0.0.1:${port}`;
}

describe("createProxyHandler", () => {
  it("returns 404 for an unknown host", async () => {
    const handler = createProxyHandler(createRegistry());
    const request = new Request("http://edge/", { headers: { host: "nope.test" } });

    const response = await handler(request);

    expect(response.status).toBe(404);
  });

  it("the backend sees its own Host header, not the public one", async () => {
    let gotHost: string | undefined;
    const backendURL = await startBackend((req, res) => {
      gotHost = req.headers.host;
      res.end();
    });
    const registry = createRegistry();
    registry.set("public.test", [{ url: backendURL, weight: 1, insecureSkipVerify: false }]);
    const handler = createProxyHandler(registry);

    await handler(new Request("http://edge/", { headers: { host: "public.test" } }));

    expect(gotHost).toBe(backendURL.replace("http://", ""));
  });

  it("passes a backend's 401 to a visitor POST with a streamed body (not a 502)", async () => {
    let got = "";
    const backendURL = await startBackend((req, res) => {
      req.setEncoding("utf8");
      req.on("data", (c: string) => (got += c));
      req.on("end", () => {
        res.writeHead(401, { "www-authenticate": 'Bearer realm="app"', "content-type": "text/plain" });
        res.end("sign in first");
      });
    });
    const registry = createRegistry();
    registry.set("public.test", [{ url: backendURL, weight: 1, insecureSkipVerify: false }]);
    const handler = createProxyHandler(registry);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("name=a"));
        c.close();
      },
    });
    const request = new Request("http://edge/api/login", {
      method: "POST",
      headers: { host: "public.test", "content-type": "application/x-www-form-urlencoded" },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const response = await handler(request);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("sign in first");
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="app"');
    expect(got).toBe("name=a");
  });

  it("edgeResponseHeaderTimeoutMs is a positive constant", () => {
    expect(edgeResponseHeaderTimeoutMs).toBeGreaterThan(0);
  });

  it("fails an unreachable backend with a 502 within a generous bound", async () => {
    const origStrict = setEdgeStrictDispatcherForTest(new Agent({ headersTimeout: 300, bodyTimeout: 0 }));
    try {
      let accepted = false;
      await new Promise<void>((resolveListen) => {
        server = createServer(() => {
          accepted = true;
          // deliberately never responds
        });
        server.listen(0, resolveListen);
      });
      const { port } = server!.address() as AddressInfo;
      const backendURL = `http://127.0.0.1:${port}`;
      const registry = createRegistry();
      registry.set("hang.test", [{ url: backendURL, weight: 1, insecureSkipVerify: false }]);
      const handler = createProxyHandler(registry);

      const start = Date.now();
      const response = await handler(new Request("http://edge/", { headers: { host: "hang.test" } }));
      const elapsed = Date.now() - start;

      expect(response.status).toBe(502);
      expect(await response.text()).toBe("edge: backend unreachable");
      expect(elapsed).toBeLessThan(5000);
      expect(accepted).toBe(true);
    } finally {
      setEdgeStrictDispatcherForTest(origStrict);
    }
  });

  it("sets x-nbo-edge-backend to the picked backend's id, never its URL", async () => {
    const backendURL = await startBackend((_req, res) => res.end());
    const registry = createRegistry();
    registry.set("app.test", [{ id: "env_k8s", url: backendURL, weight: 1, insecureSkipVerify: false }]);
    registry.set("old.test", [{ url: backendURL, weight: 1, insecureSkipVerify: false }]);
    const handler = createProxyHandler(registry);

    const response = await handler(new Request("http://edge/", { headers: { host: "app.test" } }));
    expect(response.headers.get("x-nbo-edge-backend")).toBe("env_k8s");

    // A backend without an id (an older route table) gets no header at all.
    const old = await handler(new Request("http://edge/", { headers: { host: "old.test" } }));
    expect(old.status).toBe(200);
    expect(old.headers.get("x-nbo-edge-backend")).toBeNull();
  });

  it("sets x-forwarded-host to the original public host", async () => {
    let gotForwardedHost: string | undefined;
    const backendURL = await startBackend((req, res) => {
      gotForwardedHost = req.headers["x-forwarded-host"] as string | undefined;
      res.end();
    });
    const registry = createRegistry();
    registry.set("public.test", [{ url: backendURL, weight: 1, insecureSkipVerify: false }]);
    const handler = createProxyHandler(registry);

    await handler(new Request("http://edge/", { headers: { host: "public.test" } }));

    expect(gotForwardedHost).toBe("public.test");
  });

  it("leaves x-forwarded-for, x-real-ip and forwarded as they came in dev mode", async () => {
    let got: Record<string, unknown> = {};
    const backendURL = await startBackend((req, res) => {
      got = { ...req.headers };
      res.end();
    });
    const registry = createRegistry();
    registry.set("public.test", [{ url: backendURL, weight: 1, insecureSkipVerify: false }]);
    const handler = createProxyHandler(registry);

    await handler(
      new Request("http://edge/", {
        headers: {
          host: "public.test",
          "x-forwarded-for": "1.2.3.4",
          "x-real-ip": "1.2.3.4",
          forwarded: "for=1.2.3.4",
        },
      }),
    );

    expect(got).toMatchObject({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4", forwarded: "for=1.2.3.4" });
  });
});

describe.skipIf(!opensslAvailable)("createProxyHandler (TLS)", () => {
  it("scopes insecureSkipVerify to only the backends that opt in", async () => {
    const insecureBackendURL = startSelfSignedBackend((_req, res) => res.end("insecure-ok"));
    const strictBackendURL = startSelfSignedBackend((_req, _res) => {
      throw new Error("a backend not marked insecureSkipVerify must never be reached through an unverified connection");
    });
    const registry = createRegistry();
    registry.set("insecure.test", [{ url: insecureBackendURL, weight: 1, insecureSkipVerify: true }]);
    registry.set("strict.test", [{ url: strictBackendURL, weight: 1, insecureSkipVerify: false }]);
    const handler = createProxyHandler(registry);

    const okResponse = await handler(new Request("http://edge/", { headers: { host: "insecure.test" } }));
    expect(okResponse.status).toBe(200);

    const failResponse = await handler(new Request("http://edge/", { headers: { host: "strict.test" } }));
    expect(failResponse.status).not.toBe(200);
  });
});

describe("createProxyHandler Cloudflare trust (cluster mode)", () => {
  async function run(opts: { cloudflare: boolean; peer: string; cfIp?: string; extra?: Record<string, string> }) {
    let seen: IncomingMessage["headers"] = {};
    const url = await startBackend((req, res) => {
      seen = req.headers;
      res.end("ok");
    });
    const registry = createRegistry();
    registry.replaceAll({
      "a.test": {
        backends: [{ url, weight: 1, insecureSkipVerify: false }],
        ...(opts.cloudflare ? { cloudflare: true } : {}),
      },
    });
    const trust = createCloudflareTrust();
    trust.replace(["104.16.0.0/13", "2606:4700::/32"]);
    const handler = createProxyHandler(registry, { scheme: "https", cloudflareTrust: trust });
    const headers: Record<string, string> = { host: "a.test", [CLIENT_IP_HEADER]: opts.peer, ...(opts.extra ?? {}) };
    if (opts.cfIp !== undefined) headers["cf-connecting-ip"] = opts.cfIp;
    await handler(new Request("http://edge/", { headers }));
    return seen;
  }

  it("uses cf-connecting-ip from a trusted peer on a marked target and strips it", async () => {
    const seen = await run({ cloudflare: true, peer: "104.16.0.1", cfIp: "203.0.113.9" });
    expect(seen["x-forwarded-for"]).toBe("203.0.113.9");
    expect(seen["cf-connecting-ip"]).toBeUndefined();
  });
  it("uses the socket address when the peer is outside the ranges", async () => {
    const seen = await run({ cloudflare: true, peer: "8.8.8.8", cfIp: "203.0.113.9" });
    expect(seen["x-forwarded-for"]).toBe("8.8.8.8");
  });
  it("uses the socket address when the target is not marked", async () => {
    const seen = await run({ cloudflare: false, peer: "104.16.0.1", cfIp: "203.0.113.9" });
    expect(seen["x-forwarded-for"]).toBe("104.16.0.1");
  });
  it("uses the socket address when the header is garbage", async () => {
    const seen = await run({ cloudflare: true, peer: "104.16.0.1", cfIp: "garbage" });
    expect(seen["x-forwarded-for"]).toBe("104.16.0.1");
  });
  it("trusts an IPv6 Cloudflare peer", async () => {
    const seen = await run({ cloudflare: true, peer: "2606:4700::1", cfIp: "2001:db8::7" });
    expect(seen["x-forwarded-for"]).toBe("2001:db8::7");
  });
  it("trusts an IPv4-mapped IPv6 Cloudflare peer and not a mapped outsider", async () => {
    const trusted = await run({ cloudflare: true, peer: "::ffff:104.16.0.1", cfIp: "203.0.113.9" });
    expect(trusted["x-forwarded-for"]).toBe("203.0.113.9");
    const outsider = await run({ cloudflare: true, peer: "::ffff:8.8.8.8", cfIp: "203.0.113.9" });
    expect(outsider["x-forwarded-for"]).toBe("::ffff:8.8.8.8");
  });
  it("never forwards true-client-ip or cf-connecting-ip", async () => {
    const seen = await run({
      cloudflare: false,
      peer: "8.8.8.8",
      cfIp: "1.2.3.4",
      extra: { "true-client-ip": "5.6.7.8" },
    });
    expect(seen["true-client-ip"]).toBeUndefined();
    expect(seen["cf-connecting-ip"]).toBeUndefined();
  });
});

describe("createProxyHandler revalidation fan-out to a host with no backends", () => {
  it("answers as for an unknown host (404, the edge's text), not 204", async () => {
    // The registry refuses such a target, so a stand-in registry hands one over.
    const registry = { get: (host: string) => ({ host, backends: [] }) } as unknown as ReturnType<
      typeof createRegistry
    >;
    const handler = createProxyHandler(registry);
    const res = await handler(
      new Request("http://edge/_nbo/revalidate", { method: "POST", headers: { host: "empty.test" }, body: "{}" }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("edge: no target registered for host empty.test");
    expect(res.headers.get("x-nbo-edge-fanout")).toBe("0");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("isRevalidateRequest", () => {
  it("is POST to exactly /_nbo/revalidate", () => {
    expect(isRevalidateRequest(new Request("http://e/_nbo/revalidate", { method: "POST" }))).toBe(true);
    expect(isRevalidateRequest(new Request("http://e/_nbo/revalidate?x=1", { method: "POST" }))).toBe(true);
    expect(isRevalidateRequest(new Request("http://e/_nbo/revalidate"))).toBe(false);
    expect(isRevalidateRequest(new Request("http://e/_nbo/revalidate/", { method: "POST" }))).toBe(false);
    expect(isRevalidateRequest(new Request("http://e/_nbo/revalidatex", { method: "POST" }))).toBe(false);
    expect(isRevalidateRequest(new Request("http://e/x/_nbo/revalidate", { method: "POST" }))).toBe(false);
  });
});

describe("fanOutRevalidate", () => {
  const backends: Backend[] = [
    { id: "env_a", url: "http://a", weight: 1, insecureSkipVerify: false },
    { url: "http://b", weight: 0, insecureSkipVerify: false },
  ];
  const post = (body: string) =>
    new Request("http://e/_nbo/revalidate", {
      method: "POST",
      body,
      headers: { authorization: "Bearer t", "content-type": "application/json" },
    });

  it("calls every backend with the same body and headers and answers 204 when all are 2xx", async () => {
    const got: { url: string; body: string; auth: string | null }[] = [];
    const res = await fanOutRevalidate(post('{"tags":["a"]}'), backends, async (b, r) => {
      got.push({ url: b.url, body: await r.text(), auth: r.headers.get("authorization") });
      return new Response(null, { status: b.url === "http://a" ? 204 : 200 });
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("x-nbo-edge-fanout")).toBe("2");
    expect(got).toEqual([
      { url: "http://a", body: '{"tags":["a"]}', auth: "Bearer t" },
      { url: "http://b", body: '{"tags":["a"]}', auth: "Bearer t" },
    ]);
  });

  it("answers the shared status when every backend answered the same non-2xx", async () => {
    const res = await fanOutRevalidate(post("{}"), backends, async () => new Response("no", { status: 401 }));
    expect(res.status).toBe(401);
    expect(res.headers.get("x-nbo-edge-fanout")).toBe("2");
  });

  it("answers 502 with each id (null without one, never the URL) and status, 0 for a failed call", async () => {
    const res = await fanOutRevalidate(post("{}"), backends, async (b) => {
      if (b.url === "http://b") throw new Error("refused");
      return new Response(null, { status: 204 });
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      backends: [
        { id: "env_a", status: 204 },
        { id: null, status: 0 },
      ],
    });
  });

  it("answers 413 for a body over 65536 bytes without calling a backend", async () => {
    let calls = 0;
    const res = await fanOutRevalidate(post("x".repeat(65537)), backends, async () => {
      calls++;
      return new Response(null, { status: 204 });
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("x-nbo-edge-fanout")).toBe("2");
    expect(calls).toBe(0);
  });
});
