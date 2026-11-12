// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { createRegistry } from "../registry.js";
import { createCertStore, createChallengeStore } from "../cert-store.js";
import { createProxyHandler } from "../proxy.js";
import { startKubeSource } from "../kube-source.js";
import { createCloudflareTrust } from "../cloudflare-trust.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const NS = "nbo-system";
let api: Server | undefined;
let source: { stop(): void } | undefined;
afterEach(async () => {
  source?.stop();
  source = undefined;
  if (api) {
    const s = api;
    api = undefined;
    await new Promise<void>((r) => {
      s.close(() => r());
      s.closeAllConnections();
    });
  }
});

interface State {
  configmap: string | undefined; // undefined => 404
  secrets: { name: string; crt: string; key: string }[];
  auth: string[];
}

async function fakeApi(state: State): Promise<string> {
  api = createServer((req, res) => {
    state.auth.push(req.headers.authorization ?? "");
    const url = req.url ?? "";
    if (url === `/api/v1/namespaces/${NS}/configmaps/nbo-edge-routes`) {
      if (state.configmap === undefined) return void res.writeHead(404).end("{}");
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ metadata: { name: "nbo-edge-routes" }, data: { "routes.json": state.configmap } }));
    }
    if (url === `/api/v1/namespaces/${NS}/secrets?labelSelector=nbo.dev%2Fedge-cert%3Dtrue`) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({
          items: state.secrets.map((s) => ({
            metadata: { name: s.name },
            data: { "tls.crt": Buffer.from(s.crt).toString("base64"), "tls.key": Buffer.from(s.key).toString("base64") },
          })),
        }),
      );
    }
    res.writeHead(500).end("unexpected " + url);
  });
  await new Promise<void>((r) => api!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
}

function table(host: string, tls?: string): string {
  return JSON.stringify({
    version: 1,
    targets: { [host]: { ...(tls ? { tls } : {}), backends: [{ id: "env_a", url: "http://127.0.0.1:1", weight: 100 }] } },
    challenges: {},
  });
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function selfSigned() {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=app.test",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
    signingAlgorithm: alg,
    keys,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  return { crt: cert.toString("pem"), key: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n` };
}

describe("startKubeSource", () => {
  it("no ConfigMap: ready resolves, registry empty, edge answers 404; a table then appears", async () => {
    const state: State = { configmap: undefined, secrets: [], auth: [] };
    const apiBase = await fakeApi(state);
    const registry = createRegistry();
    let tok = "t1";
    source = startKubeSource({
      apiBase,
      token: () => tok,
      namespace: NS,
      intervalMs: 30,
      registry,
      certs: createCertStore(),
      challenges: createChallengeStore(),
      log: () => {},
    });
    await source.ready;
    expect(registry.get("app.test")).toBeUndefined();
    const res = await createProxyHandler(registry)(new Request("http://app.test/", { headers: { host: "app.test" } }));
    expect(res.status).toBe(404);

    tok = "t2";
    state.configmap = table("app.test");
    await until(() => registry.get("app.test") !== undefined);
    expect(state.auth).toContain("Bearer t1");
    await until(() => state.auth.includes("Bearer t2"));
  });

  it("a malformed table keeps the last good one and logs", async () => {
    const state: State = { configmap: table("app.test"), secrets: [], auth: [] };
    const apiBase = await fakeApi(state);
    const registry = createRegistry();
    const logs: string[] = [];
    source = startKubeSource({
      apiBase,
      token: () => "t",
      namespace: NS,
      intervalMs: 30,
      registry,
      certs: createCertStore(),
      challenges: createChallengeStore(),
      log: (m) => logs.push(m),
    });
    await source.ready;
    expect(registry.get("app.test")).toBeDefined();
    state.configmap = "{not json";
    await until(() => logs.length > 0);
    expect(registry.get("app.test")).toBeDefined();
    expect(logs[0]).toMatch(/route table/);
  });

  it("a cert Secret added then removed", async () => {
    const pair = await selfSigned();
    const state: State = { configmap: table("app.test", "cert-app"), secrets: [], auth: [] };
    const apiBase = await fakeApi(state);
    const registry = createRegistry();
    const certs = createCertStore();
    source = startKubeSource({ apiBase, token: () => "t", namespace: NS, intervalMs: 30, registry, certs, challenges: createChallengeStore(), log: () => {} });
    await source.ready;
    expect(certs.contextFor("app.test", registry)).toBeUndefined();
    state.secrets = [{ name: "cert-app", crt: pair.crt, key: pair.key }];
    await until(() => certs.contextFor("app.test", registry) !== undefined);
    state.secrets = [];
    await until(() => certs.contextFor("app.test", registry) === undefined);
  });

  it("ready resolves even when the API is unreachable", async () => {
    const logs: string[] = [];
    source = startKubeSource({
      apiBase: "http://127.0.0.1:1",
      token: () => "t",
      namespace: NS,
      intervalMs: 1000,
      registry: createRegistry(),
      certs: createCertStore(),
      challenges: createChallengeStore(),
      log: (m) => logs.push(m),
    });
    await source.ready;
    expect(logs.length).toBeGreaterThan(0);
  });

  it("does not leak sockets when the API answers 404/403 repeatedly", async () => {
    let open = 0;
    let maxOpen = 0;
    let requests = 0;
    api = createServer((req, res) => {
      requests++;
      const code = req.url?.includes("/configmaps/") ? 404 : 403;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "x".repeat(3_000_000) }));
    });
    api.on("connection", (sock) => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      sock.on("close", () => open--);
    });
    await new Promise<void>((r) => api!.listen(0, "127.0.0.1", () => r()));
    const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    source = startKubeSource({
      apiBase,
      token: () => "t",
      namespace: NS,
      intervalMs: 5,
      registry: createRegistry(),
      certs: createCertStore(),
      challenges: createChallengeStore(),
      log: () => {},
    });
    await until(() => requests >= 60);
    // cancelling a body closes its socket (a few may still be closing); a leak reached ~40
    expect(maxOpen).toBeLessThanOrEqual(5);
  });
});

describe("startKubeSource cloudflare ranges", () => {
  it("updates the trust from the table and empties it when the table has none", async () => {
    const state: State = {
      configmap: JSON.stringify({ version: 1, targets: {}, challenges: {}, cloudflareRanges: ["104.16.0.0/13"] }),
      secrets: [],
      auth: [],
    };
    const apiBase = await fakeApi(state);
    const trust = createCloudflareTrust();
    source = startKubeSource({
      apiBase,
      token: () => "t",
      namespace: NS,
      intervalMs: 20,
      registry: createRegistry(),
      certs: createCertStore(),
      challenges: createChallengeStore(),
      cloudflareTrust: trust,
      log: () => {},
    });
    await source.ready;
    expect(trust.has("104.16.0.1")).toBe(true);
    state.configmap = JSON.stringify({ version: 1, targets: {}, challenges: {} });
    await until(() => !trust.has("104.16.0.1"));
  });
});
