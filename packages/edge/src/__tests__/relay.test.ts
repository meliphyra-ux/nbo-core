// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer as createHttp, type Server, type IncomingHttpHeaders } from "node:http";
import { createServer as createHttps } from "node:https";
import type { AddressInfo } from "node:net";
import { webcrypto } from "node:crypto";
import { Agent } from "undici";
import * as x509 from "@peculiar/x509";
import { proxyRequest } from "@nbo/funcproxy";
import { createRegistry } from "../registry.js";
import { createProxyHandler } from "../proxy.js";
import { createRelayHandler } from "../relay.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.close(() => r());
          s.closeAllConnections();
        }),
    ),
  );
});

const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

async function makeCa(name: string) {
  const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${name}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
    signingAlgorithm: alg,
    keys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return { keys, cert };
}

async function makeLeaf(ca: Awaited<ReturnType<typeof makeCa>>) {
  const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=relay",
    issuer: ca.cert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
    signingAlgorithm: alg,
    publicKey: keys.publicKey,
    signingKey: ca.keys.privateKey,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: "ip", value: "127.0.0.1" }])],
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  const key = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { cert: cert.toString("pem"), key };
}

const UPSTREAM = "web.nbo-p-abc.svc.cluster.local:8080";

async function setup(opts: { trustedCa?: "same" | "other" } = {}) {
  const ca = await makeCa("test-ca");
  const otherCa = await makeCa("other-ca");
  const leaf = await makeLeaf(ca);
  const seen: IncomingHttpHeaders[] = [];
  const paths: string[] = [];
  const up = createHttp((req, res) => {
    seen.push(req.headers);
    paths.push(req.url ?? "");
    res.end("upstream-ok");
  });
  servers.push(up);
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
  const upPort = (up.address() as AddressInfo).port;

  const token = "secret-token";
  const relay = createRelayHandler({
    token,
    fetchUpstream: async (url, req) => {
      expect(url.host).toBe(UPSTREAM);
      return proxyRequest(req, new URL(`http://127.0.0.1:${upPort}`));
    },
  });
  const rs = createHttps({ cert: leaf.cert, key: leaf.key }, async (nodeReq, nodeRes) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(nodeReq.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await relay(new Request(`https://127.0.0.1${nodeReq.url}`, { method: nodeReq.method, headers }));
    nodeRes.writeHead(r.status, Object.fromEntries(r.headers));
    nodeRes.end(Buffer.from(await r.arrayBuffer()));
  });
  servers.push(rs);
  await new Promise<void>((r) => rs.listen(0, "127.0.0.1", () => r()));
  const relayUrl = `https://127.0.0.1:${(rs.address() as AddressInfo).port}`;

  const registry = createRegistry();
  const caPem = (opts.trustedCa === "other" ? otherCa.cert : ca.cert).toString("pem");
  const goodCaPem = ca.cert.toString("pem");
  const mk = (t: string) => ({
    id: "env_k",
    url: `http://${UPSTREAM}`,
    weight: 100,
    insecureSkipVerify: false,
    via: { url: relayUrl, caPem, token: t },
  });
  registry.set("app.test", [mk(token)]);
  return { registry, handler: createProxyHandler(registry), relayUrl, goodCaPem, seen, paths, mk };
}

describe("relay forwarding", () => {
  it("reaches the upstream through the relay without relay headers", async () => {
    const { handler, seen, paths } = await setup();
    const res = await handler(new Request("http://app.test/a/b?x=1", { headers: { host: "app.test" } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
    expect(res.headers.get("x-nbo-edge-backend")).toBe(`http://${UPSTREAM}`);
    expect(paths[0]).toBe("/a/b?x=1");
    expect(seen[0]["x-nbo-relay-token"]).toBeUndefined();
    expect(seen[0]["x-nbo-upstream"]).toBeUndefined();
    expect(seen[0]["x-forwarded-host"]).toBe("app.test");
  });

  it("hands the app the edge's x-forwarded-for as the relay received it", async () => {
    const { registry, seen } = await setup();
    const clusterEdge = createProxyHandler(registry, { scheme: "https" });
    await clusterEdge(new Request("http://app.test/", { headers: { host: "app.test", "x-forwarded-for": "6.6.6.6", "x-nbo-client-ip": "203.0.113.7" } }));
    expect(seen[0]["x-forwarded-for"]).toBe("203.0.113.7");
    expect(seen[0]["x-nbo-client-ip"]).toBeUndefined();
  });

  it("ignores visitor-supplied relay headers (the edge's own values are used)", async () => {
    const { handler, seen } = await setup();
    const res = await handler(
      new Request("http://app.test/", { headers: { host: "app.test", "x-nbo-relay-token": "x", "x-nbo-upstream": "evil" } }),
    );
    // A forged token or upstream would have produced 403 or 400.
    expect(res.status).toBe(200);
    expect(seen[0]["x-nbo-relay-token"]).toBeUndefined();
    expect(seen[0]["x-nbo-upstream"]).toBeUndefined();
  });

  it("strips visitor relay headers for backends without via", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const up = createHttp((req, res) => {
      seen.push(req.headers);
      res.end("ok");
    });
    servers.push(up);
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
    const registry = createRegistry();
    registry.set("app.test", [
      { id: "e", url: `http://127.0.0.1:${(up.address() as AddressInfo).port}`, weight: 100, insecureSkipVerify: false },
    ]);
    await createProxyHandler(registry)(
      new Request("http://app.test/", { headers: { host: "app.test", "x-nbo-relay-token": "x", "x-nbo-upstream": "evil" } }),
    );
    expect(seen[0]["x-nbo-relay-token"]).toBeUndefined();
    expect(seen[0]["x-nbo-upstream"]).toBeUndefined();
  });

  it("answers 403 for a wrong token", async () => {
    const { registry, mk } = await setup();
    registry.set("app.test", [mk("wrong")]);
    const res = await createProxyHandler(registry)(new Request("http://app.test/", { headers: { host: "app.test" } }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("relay: forbidden");
  });

  it("answers 400 for an upstream outside the pattern", async () => {
    const { relayUrl, goodCaPem } = await setup();
    const res = await fetch(`${relayUrl}/`, {
      headers: { "x-nbo-relay-token": "secret-token", "x-nbo-upstream": "evil.com:80" },
      dispatcher: new Agent({ connect: { ca: goodCaPem } }),
    } as RequestInit);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("relay: bad upstream");
  });

  it("answers 502 when the relay certificate is signed by a different CA", async () => {
    const { handler } = await setup({ trustedCa: "other" });
    const res = await handler(new Request("http://app.test/", { headers: { host: "app.test" } }));
    expect(res.status).toBe(502);
  });
});
