// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, request as httpRequest, type Server, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { createRegistry } from "../registry.js";
import { createCertStore, createChallengeStore } from "../cert-store.js";
import { createAggregator } from "../insights/aggregator.js";
import { startClusterListeners } from "../cluster-listeners.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

async function selfSigned(dns: string) {
  const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${dns}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
    signingAlgorithm: alg,
    keys,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: "dns", value: dns }])],
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  const key = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { cert: cert.toString("pem"), key };
}

let backend: Server | undefined;
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
  if (backend) {
    const b = backend;
    backend = undefined;
    await new Promise<void>((r) => {
      b.close(() => r());
      b.closeAllConnections();
    });
  }
});

async function startBackend(): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  backend = createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader("content-type", "text/html");
    res.end("backend");
  });
  await new Promise<void>((r) => backend!.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, seen };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function get(port: number, host: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host, ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function getTls(port: number, sni: string, ca: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: "127.0.0.1", port, servername: sni, ca, path: "/", headers: { host: sni, ...headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function setup() {
  const b = await startBackend();
  const registry = createRegistry();
  const certs = createCertStore();
  const challenges = createChallengeStore();
  const insights = createAggregator();
  const a = await selfSigned("a.test");
  const bb = await selfSigned("b.test");
  certs.set("a-tls", a.cert, a.key);
  certs.set("b-tls", bb.cert, bb.key);
  registry.replaceAll({
    "a.test": { backends: [{ url: b.url, weight: 1 }], tls: "a-tls", redirectHttps: true },
    "b.test": { backends: [{ url: b.url, weight: 1 }], tls: "b-tls" },
    "nocert.test": { backends: [{ url: b.url, weight: 1 }], tls: "missing", redirectHttps: true },
  });
  const l = await startClusterListeners({
    registry,
    certs,
    challenges,
    insights,
    httpPort: 0,
    httpsPort: 0,
    adminPort: 0,
    drainToken: "s3cret",
  });
  stop = l.close;
  return { l, b, a, bb, challenges };
}

describe("cluster listeners", () => {
  it("answers ACME challenges on HTTP for any host, 404 for unknown tokens", async () => {
    const { l, challenges } = await setup();
    challenges.replace({ tok1: "tok1.keyauth" });
    const ok = await get(l.ports.http, "unregistered.test", "/.well-known/acme-challenge/tok1");
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/plain");
    expect(ok.body).toBe("tok1.keyauth");
    expect((await get(l.ports.http, "a.test", "/.well-known/acme-challenge/nope")).status).toBe(404);
    expect((await get(l.ports.http, "a.test", "/.well-known/acme-challenge/__proto__")).status).toBe(404);
  });

  it("answers ACME challenges over HTTPS too, 404 for unknown tokens, other paths still proxied", async () => {
    const { l, a, challenges } = await setup();
    challenges.replace({ tok1: "tok1.keyauth" });
    const tls = (path: string) =>
      new Promise<Reply>((resolve, reject) => {
        const req = httpsRequest(
          {
            host: "127.0.0.1",
            port: l.ports.https,
            servername: "a.test",
            ca: a.cert,
            path,
            headers: { host: "a.test" },
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    const ok = await tls("/.well-known/acme-challenge/tok1");
    expect(ok.status).toBe(200);
    expect(ok.body).toBe("tok1.keyauth");
    expect((await tls("/.well-known/acme-challenge/nope")).status).toBe(404);
    const other = await tls("/page");
    expect(other.status).toBe(200);
    expect(other.body).toBe("backend");
  });

  it("redirects with 308 only when tls and redirectHttps are set and the cert exists", async () => {
    const { l } = await setup();
    const r = await get(l.ports.http, "a.test", "/x/y?q=1");
    expect(r.status).toBe(308);
    expect(r.headers.location).toBe("https://a.test/x/y?q=1");
    // tls without redirectHttps: served.
    expect((await get(l.ports.http, "b.test", "/")).status).toBe(200);
    // redirectHttps but the Secret is absent: served, never redirected.
    const n = await get(l.ports.http, "nocert.test", "/");
    expect(n.status).toBe(200);
    expect(n.body).toBe("backend");
  });

  it("terminates TLS by SNI and sets x-forwarded-proto from the listener", async () => {
    const { l, b, a, bb } = await setup();
    const r = await getTls(l.ports.https, "a.test", a.cert, {
      "x-forwarded-proto": "http",
      forwarded: "proto=http",
      accept: "text/html",
    });
    expect(r.status).toBe(200);
    expect(b.seen.at(-1)!["x-forwarded-proto"]).toBe("https");
    expect(b.seen.at(-1)!.forwarded).toBeUndefined();
    expect(String(r.headers["set-cookie"])).toContain("Secure");
    // b.test presents its own cert: a.test's cert does not verify for it.
    await expect(getTls(l.ports.https, "b.test", a.cert)).rejects.toThrow();
    expect((await getTls(l.ports.https, "b.test", bb.cert)).status).toBe(200);
  });

  it("fails the handshake for a host whose Secret is absent, others still work", async () => {
    const { l, bb } = await setup();
    await expect(getTls(l.ports.https, "nocert.test", bb.cert)).rejects.toThrow();
    await expect(getTls(l.ports.https, "unknown.test", bb.cert)).rejects.toThrow();
    expect((await getTls(l.ports.https, "b.test", bb.cert)).status).toBe(200);
  });

  it("forwards the socket's address and drops what the visitor claimed, on both listeners", async () => {
    const { l, b, a } = await setup();
    const claimed = {
      "x-forwarded-for": "6.6.6.6",
      "x-real-ip": "6.6.6.6",
      forwarded: "for=6.6.6.6",
      "x-nbo-client-ip": "6.6.6.6",
      accept: "text/html",
    };
    for (const send of [
      () => get(l.ports.http, "b.test", "/", claimed),
      () => getTls(l.ports.https, "a.test", a.cert, claimed),
    ]) {
      await send();
      const seen = b.seen.at(-1)!;
      expect(seen["x-forwarded-for"]).toBe("127.0.0.1");
      expect(seen["x-real-ip"]).toBeUndefined();
      expect(seen.forwarded).toBeUndefined();
      expect(seen["x-nbo-client-ip"]).toBeUndefined();
    }
  });

  it("uses the http scheme for forwarded proto and cookies on the HTTP listener, ignoring the visitor", async () => {
    const { l, b } = await setup();
    const r = await get(l.ports.http, "b.test", "/", { "x-forwarded-proto": "https", accept: "text/html" });
    expect(b.seen.at(-1)!["x-forwarded-proto"]).toBe("http");
    expect(String(r.headers["set-cookie"])).not.toContain("Secure");
  });

  it("serves a drain-only admin API guarded by the token", async () => {
    const { l } = await setup();
    expect((await get(l.ports.admin, "x", "/targets/a.test")).status).toBe(404);
    expect((await get(l.ports.admin, "x", "/insights/drain")).status).toBe(403);
    expect((await get(l.ports.admin, "x", "/insights/drain?token=wrong")).status).toBe(403);
    const ok = await get(l.ports.admin, "x", "/insights/drain?token=s3cret");
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toHaveProperty("batches");
  });

  it("skips a bad PEM pair without throwing", () => {
    const certs = createCertStore();
    const registry = createRegistry();
    certs.set("bad", "nope", "nope");
    registry.replaceAll({ "c.test": { backends: [{ url: "http://127.0.0.1:1", weight: 1 }], tls: "bad" } });
    expect(certs.contextFor("c.test", registry)).toBeUndefined();
  });
});

describe("cluster bridge streaming", () => {
  it("aborts the upstream request when the visitor disconnects mid-stream", async () => {
    let upstreamClosed = false;
    let upstreamStarted: () => void;
    const started = new Promise<void>((r) => (upstreamStarted = r));
    backend = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hi\n\n");
      const t = setInterval(() => res.write("data: tick\n\n"), 50);
      res.on("close", () => {
        upstreamClosed = true;
        clearInterval(t);
      });
      upstreamStarted();
    });
    await new Promise<void>((r) => backend!.listen(0, "127.0.0.1", () => r()));
    const registry = createRegistry();
    registry.replaceAll({
      "s.test": { backends: [{ url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, weight: 1 }] },
    });
    const l = await startClusterListeners({
      registry,
      certs: createCertStore(),
      challenges: createChallengeStore(),
      insights: createAggregator(),
      httpPort: 0,
      httpsPort: 0,
      adminPort: 0,
      drainToken: "t",
    });
    stop = l.close;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: l.ports.http, path: "/", headers: { host: "s.test" } },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", () => undefined);
      req.on("error", reject);
      req.end();
    });
    await started;
    const deadline = Date.now() + 1500;
    while (!upstreamClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(upstreamClosed).toBe(true);
  });

  it("does not read far ahead of a client that has paused", async () => {
    let written = 0;
    const chunk = Buffer.alloc(64 * 1024, 1);
    backend = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const pump = () => {
        while (written < 2000) {
          written++;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    });
    await new Promise<void>((r) => backend!.listen(0, "127.0.0.1", () => r()));
    const registry = createRegistry();
    registry.replaceAll({
      "p.test": { backends: [{ url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, weight: 1 }] },
    });
    const l = await startClusterListeners({
      registry,
      certs: createCertStore(),
      challenges: createChallengeStore(),
      insights: createAggregator(),
      httpPort: 0,
      httpsPort: 0,
      adminPort: 0,
      drainToken: "t",
    });
    stop = l.close;
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: l.ports.http, path: "/", headers: { host: "p.test" } },
        (res) => {
          res.pause();
          setTimeout(() => {
            // 2000 chunks = 128 MB; a paused client must leave most unread.
            expect(written).toBeLessThan(600);
            res.destroy();
            resolve();
          }, 800);
        },
      );
      req.on("error", () => undefined);
      req.end();
    });
  });
});
