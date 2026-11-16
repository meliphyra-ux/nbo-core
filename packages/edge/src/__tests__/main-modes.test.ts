// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { connect as tlsConnect } from "node:tls";
import { createServer as createHttp, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { proxyRequest } from "@nbo/funcproxy";
import {
  resolveClusterConfig,
  resolveEdgeMode,
  resolveRelayPort,
  resolveRelayUpstreamOverride,
  startClusterEdge,
} from "../main.js";
import { createRelayServer } from "../relay-server.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

describe("resolveEdgeMode", () => {
  it("defaults to dev", () => {
    expect(resolveEdgeMode({})).toEqual({ mode: "dev" });
  });
  it("cluster needs a drain token, namespace defaults to nbo-system", () => {
    expect(() => resolveEdgeMode({ NBO_EDGE_SOURCE: "kubernetes" })).toThrow(/NBO_EDGE_DRAIN_TOKEN/);
    expect(() => resolveEdgeMode({ NBO_EDGE_SOURCE: "kubernetes", NBO_EDGE_DRAIN_TOKEN: "   " })).toThrow(
      /NBO_EDGE_DRAIN_TOKEN/,
    );
    expect(() => resolveEdgeMode({ NBO_EDGE_SOURCE: "kubernetes", NBO_EDGE_DRAIN_TOKEN: "" })).toThrow(
      /NBO_EDGE_DRAIN_TOKEN/,
    );
    expect(resolveEdgeMode({ NBO_EDGE_SOURCE: "kubernetes", NBO_EDGE_DRAIN_TOKEN: "d" })).toEqual({
      mode: "cluster",
      namespace: "nbo-system",
      drainToken: "d",
    });
    expect(
      resolveEdgeMode({ NBO_EDGE_SOURCE: "kubernetes", NBO_EDGE_DRAIN_TOKEN: "d", NBO_EDGE_NAMESPACE: "x" }),
    ).toMatchObject({ namespace: "x" });
  });
  it("relay needs a token", () => {
    expect(() => resolveEdgeMode({ NBO_EDGE_MODE: "relay" })).toThrow(/NBO_RELAY_TOKEN/);
    expect(() => resolveEdgeMode({ NBO_EDGE_MODE: "relay", NBO_RELAY_TOKEN: " \t" })).toThrow(/NBO_RELAY_TOKEN/);
    expect(resolveEdgeMode({ NBO_EDGE_MODE: "relay", NBO_RELAY_TOKEN: "r" })).toEqual({ mode: "relay", token: "r" });
  });
});

const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
async function selfSigned() {
  const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=relay",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
    signingAlgorithm: alg,
    keys,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  return {
    cert: cert.toString("pem"),
    key: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`,
  };
}

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

describe("relay server", () => {
  it("ignores an absolute-form request target: only path+query reach the upstream", async () => {
    const pair = await selfSigned();
    const upstreamPaths: string[] = [];
    const up = createHttp((req, res) => {
      upstreamPaths.push(req.url ?? "");
      res.end("ok");
    });
    servers.push(up);
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
    const upPort = (up.address() as AddressInfo).port;
    const fetched: string[] = [];
    const relay = createRelayServer({
      token: "tok",
      cert: pair.cert,
      key: pair.key,
      fetchUpstream: async (url, req) => {
        fetched.push(url.href);
        return proxyRequest(req, new URL(`http://127.0.0.1:${upPort}`));
      },
    });
    servers.push(relay as unknown as Server);
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
    const port = (relay.address() as AddressInfo).port;

    const raw = await new Promise<string>((resolve, reject) => {
      const sock = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
        sock.write(
          "GET http://evil.com/x?q=1 HTTP/1.1\r\nHost: evil.com\r\nx-nbo-relay-token: tok\r\nx-nbo-upstream: web.nbo-p-abc.svc.cluster.local:8080\r\nConnection: close\r\n\r\n",
        );
      });
      let data = "";
      sock.on("data", (d) => {
        data += d;
        // the response carries the upstream's keep-alive, so end on the body
        if (data.endsWith("\r\n\r\nok")) sock.destroy();
      });
      sock.on("close", () => resolve(data));
      sock.on("error", reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.1 200/);
    expect(upstreamPaths).toEqual(["/x?q=1"]);
    expect(fetched).toEqual(["http://web.nbo-p-abc.svc.cluster.local:8080/x?q=1"]);
    expect(fetched.join()).not.toContain("evil.com");
  });
});

describe("startClusterEdge", () => {
  it("opens no listener until the first poll has completed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let hit!: () => void;
    const hitP = new Promise<void>((r) => (hit = r));
    const api = createHttp(async (req, res) => {
      hit();
      await gate;
      if (req.url?.includes("/configmaps/")) return void res.writeHead(404).end("{}");
      res.writeHead(200, { "content-type": "application/json" }).end('{"items":[]}');
    });
    servers.push(api);
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
    const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const probe = createHttp();
    // reserve a free port number for the edge's HTTP listener
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const httpPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const started = startClusterEdge({
      apiBase,
      token: () => "t",
      namespace: "nbo-system",
      drainToken: "d",
      httpPort,
      httpsPort: 0,
      adminPort: 0,
      intervalMs: 1000,
    });
    await hitP;
    await new Promise((r) => setTimeout(r, 100));
    const early = await fetch(`http://127.0.0.1:${httpPort}/`).then(
      () => "answered",
      () => "refused",
    );
    expect(early).toBe("refused");
    release();
    const edge = await started;
    const res = await fetch(`http://127.0.0.1:${edge.ports.http}/`, { headers: { host: "x.test" } });
    expect(res.status).toBe(404);
    edge.stop();
    await edge.close();
  });
});

describe("test-only overrides", () => {
  it("leave the production defaults alone when unset", () => {
    expect(resolveClusterConfig({})).toEqual({
      apiBase: "https://kubernetes.default.svc",
      tokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token",
      caFile: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
      httpPort: 8080,
      httpsPort: 8443,
      adminPort: 9444,
    });
    expect(resolveRelayPort({})).toBe(8443);
  });
  it("read ports, the API, token and CA files and the poll interval", () => {
    expect(
      resolveClusterConfig({
        NBO_EDGE_CLUSTER_PORTS: "1,2,3",
        NBO_EDGE_KUBE_API: "https://127.0.0.1:9",
        NBO_EDGE_KUBE_TOKEN_FILE: "/t",
        NBO_EDGE_KUBE_CA_FILE: "/c",
        NBO_EDGE_KUBE_POLL_MS: "100",
      }),
    ).toEqual({
      apiBase: "https://127.0.0.1:9",
      tokenFile: "/t",
      caFile: "/c",
      httpPort: 1,
      httpsPort: 2,
      adminPort: 3,
      intervalMs: 100,
    });
    expect(resolveRelayPort({ NBO_EDGE_RELAY_PORT: "7" })).toBe(7);
    expect(() => resolveClusterConfig({ NBO_EDGE_CLUSTER_PORTS: "1,2" })).toThrow(/NBO_EDGE_CLUSTER_PORTS/);
    expect(resolveRelayUpstreamOverride({})).toBeUndefined();
    expect(resolveRelayUpstreamOverride({ NBO_EDGE_RELAY_UPSTREAM_OVERRIDE: "127.0.0.1:9" })).toBe("127.0.0.1:9");
    expect(() => resolveRelayUpstreamOverride({ NBO_EDGE_RELAY_UPSTREAM_OVERRIDE: "http://x/" })).toThrow(/host:port/);
  });
});
