// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Black-box: cluster mode (NBO_EDGE_SOURCE=kubernetes) against a fake
// Kubernetes API: route table and certificates from the API, ACME answers,
// the 308, TLS by SNI, forwarding headers, Cloudflare trust, relays.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect as tlsConnect } from "node:tls";
import {
  connect as http2Connect,
  type ClientHttp2Session,
  type IncomingHttpHeaders as Http2Headers,
  type OutgoingHttpHeaders,
} from "node:http2";
import { createServer as createHttps } from "node:https";
import {
  createTestCa,
  edgeImpl,
  PRODUCTION_NAMESPACE,
  removeDir,
  send,
  startBackend,
  startEdge,
  startFakeKube,
  tempDir,
  until,
  type FakeBackend,
  type FakeKube,
  type RunningEdge,
  type TestCa,
} from "./harness.js";

const DRAIN_TOKEN = "drain-s3cret";
const RELAY_TOKEN = "relay-tok";
const UPSTREAM = "web.nbo-p-abc123.svc.cluster.local:8080";

describe("black-box: cluster mode", () => {
  let edge: RunningEdge;
  let kube: FakeKube;
  let ca: TestCa;
  let otherCa: TestCa;
  let dir: string;
  let app: FakeBackend;
  let relayFake: FakeBackend;
  let certA: { cert: string; key: string };
  let certB: { cert: string; key: string };
  let edgeEnv: Record<string, string>;

  function table(overrides: { cloudflareRanges?: string[]; extraHosts?: Record<string, unknown> } = {}): string {
    const backends = [{ id: "env_a", url: app.url, weight: 1 }];
    return JSON.stringify({
      version: 1,
      targets: {
        "a.test": { backends, tls: "a-tls", redirectHttps: true },
        "b.test": { backends, tls: "b-tls" },
        "nocert.test": { backends, tls: "missing", redirectHttps: true },
        "cf.test": { backends, cloudflare: true },
        "plain.test": { backends },
        "relayed.test": {
          backends: [
            {
              id: "env_r",
              url: `http://${UPSTREAM}`,
              weight: 1,
              via: { url: `${relayFake.url}/`, caPem: ca.cert, token: RELAY_TOKEN },
            },
          ],
        },
        "fan-relayed.test": {
          backends: [
            { id: "env_a", url: app.url, weight: 1 },
            {
              id: "env_r",
              url: `http://${UPSTREAM}`,
              weight: 0,
              via: { url: `${relayFake.url}/`, caPem: ca.cert, token: RELAY_TOKEN },
            },
          ],
        },
        // Pins a CA that did not sign the relay's certificate.
        "relayed-badca.test": {
          backends: [
            {
              id: "env_r",
              url: `http://${UPSTREAM}`,
              weight: 1,
              via: { url: `${relayFake.url}/`, caPem: otherCa.cert, token: RELAY_TOKEN },
            },
          ],
        },
        ...(overrides.extraHosts ?? {}),
      },
      challenges: { tok1: "tok1.keyauth", "tok_2-B": "tok2.keyauth" },
      cloudflareRanges: overrides.cloudflareRanges ?? ["127.0.0.0/8", "::1/128"],
    });
  }

  beforeAll(async () => {
    dir = tempDir();
    ca = await createTestCa();
    otherCa = await createTestCa();
    app = await startBackend("app");
    const relayLeaf = await ca.leaf({ ip: ["127.0.0.1"] });
    relayFake = await startBackend("relay", (listener) =>
      createHttps({ cert: relayLeaf.cert, key: relayLeaf.key }, listener),
    );
    certA = await ca.leaf({ dns: ["a.test"] });
    certB = await ca.leaf({ dns: ["b.test"] });
    // The production namespace, not the binary's default (nbo-system).
    kube = await startFakeKube(ca, dir, PRODUCTION_NAMESPACE);
    kube.configmap = table();
    kube.secrets = [
      { name: "a-tls", crt: certA.cert, key: certA.key },
      { name: "b-tls", crt: certB.cert, key: certB.key },
      { name: "broken-tls", crt: "not a cert", key: "not a key" },
    ];
    edgeEnv = {
      NBO_EDGE_DRAIN_TOKEN: DRAIN_TOKEN,
      NBO_EDGE_NAMESPACE: PRODUCTION_NAMESPACE,
      NBO_EDGE_KUBE_API: kube.url,
      NBO_EDGE_KUBE_TOKEN_FILE: kube.tokenFile,
      NBO_EDGE_KUBE_CA_FILE: kube.caFile,
      NBO_EDGE_KUBE_POLL_MS: "100",
    };
    edge = await startEdge({ mode: "cluster", env: edgeEnv });
  }, 30_000);
  afterAll(async () => {
    await edge?.stop();
    await Promise.all([app?.close(), relayFake?.close(), kube?.close()]);
    if (dir) removeDir(dir);
  });

  const http = (host: string, path = "/", headers: Record<string, string> = {}) =>
    send(`${edge.dataUrl}${path}`, { headers: { host, ...headers } });
  const https = (host: string, path = "/", headers: Record<string, string> = {}) =>
    send(`${edge.httpsUrl}${path}`, { ca: ca.cert, servername: host, headers: { host, ...headers } });
  const admin = (path: string, method = "GET") => send(`${edge.adminUrl}${path}`, { method });

  // peerNames connects with SNI servername and returns the certificate's SANs.
  function peerNames(servername: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect({ host: "127.0.0.1", port: edge.ports.https!, servername, ca: ca.cert }, () => {
        const san = socket.getPeerCertificate().subjectaltname ?? "";
        socket.end();
        resolve(san);
      });
      socket.on("error", reject);
    });
  }

  it("reads the Kubernetes API with the service-account token as a Bearer header", () => {
    expect(kube.auth.length).toBeGreaterThan(0);
    expect(kube.auth[0]).toBe("Bearer token-1");
  });

  it("serves only the token-guarded drain on the admin port", async () => {
    expect((await admin("/targets/a.test")).status).toBe(404);
    expect((await admin("/targets/a.test", "PUT")).status).toBe(404);
    expect((await admin("/targets/a.test", "DELETE")).status).toBe(404);
    expect((await admin("/")).status).toBe(404);
    expect((await admin("/insights/drain")).status).toBe(403);
    expect((await admin("/insights/drain?token=wrong")).status).toBe(403);
    expect((await admin(`/insights/drain?token=${DRAIN_TOKEN}x`)).status).toBe(403);
    const ok = await admin(`/insights/drain?token=${DRAIN_TOKEN}`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ batches: [] });
    expect((await admin(`/insights/drain?token=${DRAIN_TOKEN}`, "POST")).status).toBe(405);
  });

  it("answers ACME challenges on http for any host and on https, 404 for unknown tokens", async () => {
    for (const host of ["a.test", "unregistered.test"]) {
      const r = await http(host, "/.well-known/acme-challenge/tok1");
      expect(r.status, host).toBe(200);
      expect(r.headers["content-type"]).toMatch(/^text\/plain/);
      expect(r.body).toBe("tok1.keyauth");
    }
    expect((await http("a.test", "/.well-known/acme-challenge/tok_2-B")).body).toBe("tok2.keyauth");
    expect((await http("a.test", "/.well-known/acme-challenge/nope")).status).toBe(404);
    expect((await http("a.test", "/.well-known/acme-challenge/__proto__")).status).toBe(404);
    const tls = await https("b.test", "/.well-known/acme-challenge/tok1");
    expect(tls.status).toBe(200);
    expect(tls.body).toBe("tok1.keyauth");
    expect((await https("b.test", "/.well-known/acme-challenge/nope")).status).toBe(404);
    // ACME paths never reach the app.
    expect(app.seen.some((s) => s.url.startsWith("/.well-known/acme-challenge/"))).toBe(false);
  });

  it("redirects with 308 only for a target with tls, redirectHttps and a loaded certificate", async () => {
    const r = await http("a.test", "/x/y?q=1");
    expect(r.status).toBe(308);
    expect(r.headers.location).toBe("https://a.test/x/y?q=1");
    expect((await http("A.Test:80", "/z")).headers.location).toBe("https://a.test/z");
    // tls without redirectHttps: served over http.
    const b = await http("b.test");
    expect(b.status).toBe(200);
    expect(b.body).toBe("app");
    // redirectHttps but the Secret is absent: served, never redirected.
    const n = await http("nocert.test");
    expect(n.status).toBe(200);
    expect(n.body).toBe("app");
  });

  it("picks the certificate by SNI from the target's Secret and refuses unknown names", async () => {
    expect(await peerNames("a.test")).toContain("DNS:a.test");
    expect(await peerNames("b.test")).toContain("DNS:b.test");
    await expect(peerNames("nocert.test")).rejects.toThrow();
    await expect(peerNames("unknown.test")).rejects.toThrow();
    const r = await https("a.test", "/page", { "sec-fetch-dest": "document" });
    expect(r.status).toBe(200);
    expect(r.body).toBe("app");
  });

  // Intended difference 2: HTTP/2 to visitors on the HTTPS listener, offered
  // by ALPN. The Node edge speaks only HTTP/1.1, so this runs only on Rust.
  const rustOnly = edgeImpl() === "rust" ? it : it.skip;

  function h2Get(
    session: ClientHttp2Session,
    headers: OutgoingHttpHeaders,
  ): Promise<{ headers: Http2Headers; body: string }> {
    return new Promise((resolve, reject) => {
      const stream = session.request(headers);
      let body = "";
      let head: Http2Headers = {};
      stream.setEncoding("utf8");
      stream.on("response", (h) => (head = h));
      stream.on("data", (c: string) => (body += c));
      stream.on("end", () => resolve({ headers: head, body }));
      stream.on("error", reject);
    });
  }

  rustOnly(
    "Intended difference 2: HTTP/2 by ALPN on the HTTPS listener, :authority routing, CONNECT refused, idle close, NBO_EDGE_HTTP2=off offers only HTTP/1.1",
    async () => {
      const session = http2Connect(edge.httpsUrl!, { ca: ca.cert, servername: "a.test" });
      session.on("error", () => {});
      try {
        await new Promise<void>((resolve, reject) => {
          session.once("connect", () => resolve());
          session.once("error", reject);
        });
        expect(session.alpnProtocol).toBe("h2");
        const r = await h2Get(session, {
          ":path": "/h2?x=1",
          ":authority": "a.test",
          "sec-fetch-dest": "document",
          "x-forwarded-for": "6.6.6.6",
        });
        expect(r.headers[":status"]).toBe(200);
        expect(r.body).toBe("app");
        expect(r.headers["x-nbo-edge-backend"]).toBe("env_a");
        expect(String(r.headers["set-cookie"])).toMatch(/; Secure$/);
        const seen = app.seen.at(-1)!;
        expect(seen.url).toBe("/h2?x=1");
        expect(seen.headers["x-forwarded-proto"]).toBe("https");
        expect(seen.headers["x-forwarded-host"]).toBe("a.test");
        expect(seen.headers["x-forwarded-for"]).toBe("127.0.0.1");
        // :authority names the site over HTTP/2, not a Host header beside it.
        await h2Get(session, { ":path": "/authority", ":authority": "plain.test", host: "b.test" });
        expect(app.seen.at(-1)!.url).toBe("/authority");
        expect(app.seen.at(-1)!.headers["x-forwarded-host"]).toBe("plain.test");
        const unknown = await h2Get(session, { ":path": "/", ":authority": "unknown.test", host: "plain.test" });
        expect(unknown.headers[":status"]).toBe(404);
        expect(unknown.body).toBe("edge: no target registered for host unknown.test");
        const acme = await h2Get(session, { ":path": "/.well-known/acme-challenge/tok1", ":authority": "a.test" });
        expect(acme.headers[":status"]).toBe(200);
        expect(acme.body).toBe("tok1.keyauth");

        // CONNECT gets no answer (as over HTTP/1.1) and never reaches the app.
        const before = app.seen.length;
        const connect = session.request({ ":method": "CONNECT", ":authority": "evil.example:443" });
        const outcome = await new Promise<string>((resolve) => {
          connect.on("response", (h) => resolve(`answered ${h[":status"]}`));
          connect.on("error", () => resolve("refused"));
          connect.on("close", () => resolve("closed"));
        });
        expect(outcome).not.toMatch(/^answered/);
        expect(app.seen).toHaveLength(before);
      } finally {
        session.close();
      }

      // An idle HTTP/2 connection is closed (GOAWAY), like an idle HTTP/1.1
      // keep-alive one. NBO_EDGE_IDLE_TIMEOUT_MS (Rust, tests only) shortens
      // the 5 s wait.
      const idle = await startEdge({ mode: "cluster", env: { ...edgeEnv, NBO_EDGE_IDLE_TIMEOUT_MS: "300" } });
      try {
        const s = http2Connect(idle.httpsUrl!, { ca: ca.cert, servername: "a.test" });
        s.on("error", () => {});
        const r = await h2Get(s, { ":path": "/idle", ":authority": "a.test" });
        expect(r.headers[":status"]).toBe(200);
        const answeredAt = Date.now();
        const how = await new Promise<string>((resolve) => {
          s.on("goaway", () => resolve("goaway"));
          s.on("close", () => resolve("close"));
          setTimeout(() => resolve("still open"), 5000);
        });
        expect(how).not.toBe("still open");
        expect(Date.now() - answeredAt).toBeGreaterThanOrEqual(250);
        s.destroy();
      } finally {
        await idle.stop();
      }

      const off = await startEdge({ mode: "cluster", env: { ...edgeEnv, NBO_EDGE_HTTP2: "off" } });
      try {
        const alpn = await new Promise<string | false | undefined>((resolve, reject) => {
          const socket = tlsConnect(
            {
              host: "127.0.0.1",
              port: off.ports.https!,
              servername: "a.test",
              ca: ca.cert,
              ALPNProtocols: ["h2", "http/1.1"],
            },
            () => {
              resolve(socket.alpnProtocol);
              socket.end();
            },
          );
          socket.on("error", reject);
        });
        expect(alpn).toBe("http/1.1");
      } finally {
        await off.stop();
      }
    },
  );

  it("sets x-forwarded-proto from the listener and a Secure cookie over https only", async () => {
    const tls = await https("a.test", "/s1", {
      "x-forwarded-proto": "http",
      forwarded: "proto=http",
      "sec-fetch-dest": "document",
    });
    expect(app.seen.at(-1)!.url).toBe("/s1");
    expect(app.seen.at(-1)!.headers["x-forwarded-proto"]).toBe("https");
    expect(app.seen.at(-1)!.headers["x-forwarded-host"]).toBe("a.test");
    expect(tls.headers["set-cookie"]?.[0]).toMatch(/; Secure$/);
    const plain = await http("plain.test", "/s2", { "x-forwarded-proto": "https", "sec-fetch-dest": "document" });
    expect(app.seen.at(-1)!.headers["x-forwarded-proto"]).toBe("http");
    expect(plain.headers["set-cookie"]?.[0]).not.toMatch(/Secure/);
  });

  it("Review Focus 5: replaces the visitor's x-forwarded-for and drops their other address claims, on both listeners", async () => {
    const claims = {
      "x-forwarded-for": "6.6.6.6",
      "x-real-ip": "6.6.6.6",
      forwarded: "for=6.6.6.6",
      "x-nbo-client-ip": "6.6.6.6",
      "true-client-ip": "6.6.6.6",
      "cf-connecting-ip": "6.6.6.6",
      connection: "x-secret",
      "x-secret": "1",
      "x-nbo-relay-token": "stolen",
      "x-nbo-upstream": UPSTREAM,
    };
    for (const [name, call] of [
      ["http", () => http("plain.test", "/rf5", claims)],
      ["https", () => https("b.test", "/rf5", claims)],
    ] as const) {
      expect((await call()).status, name).toBe(200);
      const seen = app.seen.at(-1)!;
      expect(seen.url).toBe("/rf5");
      expect(seen.headers["x-forwarded-for"], name).toBe("127.0.0.1");
      for (const h of [
        "x-real-ip",
        "forwarded",
        "x-nbo-client-ip",
        "true-client-ip",
        "cf-connecting-ip",
        "x-secret",
        "x-nbo-relay-token",
        "x-nbo-upstream",
      ]) {
        expect(seen.headers[h], `${name} ${h}`).toBeUndefined();
      }
    }
  });

  it("believes cf-connecting-ip only on a Cloudflare-marked target, from a peer in cloudflareRanges, when it is an address", async () => {
    await http("cf.test", "/cf1", { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6" });
    expect(app.seen.at(-1)!.headers["x-forwarded-for"]).toBe("203.0.113.9");
    expect(app.seen.at(-1)!.headers["cf-connecting-ip"]).toBeUndefined();
    await http("cf.test", "/cf2", { "cf-connecting-ip": "2001:db8::1" });
    expect(app.seen.at(-1)!.headers["x-forwarded-for"]).toBe("2001:db8::1");
    await http("cf.test", "/cf3", { "cf-connecting-ip": "not-an-ip" });
    expect(app.seen.at(-1)!.headers["x-forwarded-for"]).toBe("127.0.0.1");
    await http("plain.test", "/cf4", { "cf-connecting-ip": "203.0.113.9" });
    expect(app.seen.at(-1)!.headers["x-forwarded-for"]).toBe("127.0.0.1");

    // A peer outside the ranges is not believed, even on a marked target.
    kube.configmap = table({ cloudflareRanges: ["10.0.0.0/8"] });
    await kube.nextPoll();
    await http("cf.test", "/cf5", { "cf-connecting-ip": "203.0.113.9" });
    expect(app.seen.at(-1)!.url).toBe("/cf5");
    expect(app.seen.at(-1)!.headers["x-forwarded-for"]).toBe("127.0.0.1");
    kube.configmap = table();
    await kube.nextPoll();
  });

  it("reaches a via backend through its relay with the CA pinned, the token and the upstream set by the edge", async () => {
    const r = await http("relayed.test", "/p/q?x=1", {
      "x-nbo-relay-token": "stolen",
      "x-nbo-upstream": "evil.nbo-p-x.svc.cluster.local:8080",
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe("relay");
    const seen = relayFake.seen.at(-1)!;
    expect(seen.url).toBe("/p/q?x=1");
    expect(seen.headers["x-nbo-relay-token"]).toBe(RELAY_TOKEN);
    expect(seen.headers["x-nbo-upstream"]).toBe(UPSTREAM);
    expect(seen.headers["x-forwarded-host"]).toBe("relayed.test");
    expect(seen.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(r.headers["x-nbo-edge-backend"]).toBe("env_r");
  });

  it("fans POST /_nbo/revalidate out to a direct and a relayed backend, the relayed one through its relay", async () => {
    const appBefore = app.seen.length;
    const relayBefore = relayFake.seen.length;
    const body = '{"tags":["posts"]}';
    const r = await send(`${edge.dataUrl}/_nbo/revalidate`, {
      method: "POST",
      body,
      headers: {
        host: "fan-relayed.test",
        authorization: "Bearer s3cret",
        "content-type": "application/json",
        "x-nbo-relay-token": "stolen",
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers["x-nbo-edge-fanout"]).toBe("2");
    expect(app.seen.length - appBefore).toBe(1);
    expect(relayFake.seen.length - relayBefore).toBe(1);
    const direct = app.seen.at(-1)!;
    expect(direct.url).toBe("/_nbo/revalidate");
    expect(direct.body).toBe(body);
    expect(direct.headers.authorization).toBe("Bearer s3cret");
    expect(direct.headers["x-nbo-relay-token"]).toBeUndefined();
    expect(direct.headers["x-forwarded-for"]).toBe("127.0.0.1");
    const relayed = relayFake.seen.at(-1)!;
    expect(relayed.method).toBe("POST");
    expect(relayed.url).toBe("/_nbo/revalidate");
    expect(relayed.body).toBe(body);
    expect(relayed.headers.authorization).toBe("Bearer s3cret");
    expect(relayed.headers["content-type"]).toBe("application/json");
    expect(relayed.headers["x-nbo-relay-token"]).toBe(RELAY_TOKEN);
    expect(relayed.headers["x-nbo-upstream"]).toBe(UPSTREAM);
    expect(relayed.headers["x-forwarded-host"]).toBe("fan-relayed.test");
  });

  it("trusts a relay only through the pinned CA: another CA's certificate gives 502 and nothing is sent", async () => {
    const before = relayFake.seen.length;
    const r = await http("relayed-badca.test", "/p");
    expect(r.status).toBe(502);
    expect(r.body).toBe("edge: backend unreachable");
    expect(relayFake.seen).toHaveLength(before);
  });

  it("reads only its own namespace (NBO_EDGE_NAMESPACE), never a ConfigMap elsewhere", async () => {
    kube.otherConfigmaps["nbo-system"] = JSON.stringify({
      version: 1,
      targets: { "decoy.test": { backends: [{ url: app.url, weight: 1 }] } },
      challenges: {},
    });
    await kube.nextPoll();
    expect((await http("decoy.test")).status).toBe(404);
    expect((await http("plain.test")).body).toBe("app");
    expect(kube.paths.length).toBeGreaterThan(0);
    for (const path of kube.paths)
      expect(path.startsWith(`/api/v1/namespaces/${PRODUCTION_NAMESPACE}/`), path).toBe(true);
    delete kube.otherConfigmaps["nbo-system"];
  });

  it("re-reads the service-account token on every poll", async () => {
    kube.setToken("token-2");
    await kube.nextPoll();
    expect(kube.auth.at(-1)).toBe("Bearer token-2");
  });

  it("Review Focus 4: a route table that fails to parse keeps the last good one serving, and the error is logged", async () => {
    const logBefore = edge.logs().length;
    for (const bad of [
      "{not json",
      JSON.stringify({ version: 2, targets: {}, challenges: {} }),
      JSON.stringify({
        version: 1,
        targets: { "a.test": { backends: [{ url: app.url, weight: 1 }], surprise: true } },
        challenges: {},
      }),
      JSON.stringify({
        version: 1,
        targets: { "a.test": { backends: [{ url: app.url, weight: 0 }] } },
        challenges: {},
      }),
      JSON.stringify({ version: 1, targets: {}, challenges: { "bad token!": "x" } }),
      JSON.stringify({ version: 1, targets: {}, challenges: {}, cloudflareRanges: ["10.0.0.0/33"] }),
    ]) {
      kube.configmap = bad;
      await kube.nextPoll();
      expect((await http("plain.test", "/still")).body, bad).toBe("app");
      expect((await https("a.test", "/still")).status, bad).toBe(200);
      expect((await http("a.test", "/still")).status, bad).toBe(308);
      expect((await http("x.test", "/.well-known/acme-challenge/tok1")).body, bad).toBe("tok1.keyauth");
    }
    await until(() => /route table/i.test(edge.logs().slice(logBefore)), 5000, "the rejection to be logged");

    // A good table after the bad ones is applied.
    kube.configmap = table({ extraHosts: { "new.test": { backends: [{ url: app.url, weight: 1 }] } } });
    await kube.nextPoll();
    expect((await http("new.test", "/")).body).toBe("app");
  });

  it("drops a certificate whose Secret disappears, keeping the others", async () => {
    kube.secrets = kube.secrets.filter((s) => s.name !== "b-tls");
    await kube.nextPoll();
    await expect(peerNames("b.test")).rejects.toThrow();
    expect(await peerNames("a.test")).toContain("DNS:a.test");
    // a.test still has its certificate, so it keeps its 308.
    expect((await http("a.test", "/")).status).toBe(308);
  });

  it("clears the table when the ConfigMap is gone", async () => {
    kube.configmap = undefined;
    await kube.nextPoll();
    const r = await http("plain.test");
    expect(r.status).toBe(404);
    expect(r.body).toBe("edge: no target registered for host plain.test");
    expect((await http("a.test", "/.well-known/acme-challenge/tok1")).status).toBe(404);
  });
});
