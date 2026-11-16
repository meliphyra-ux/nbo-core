// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Black-box: relay mode (NBO_EDGE_MODE=relay), the edge inside a private
// cluster that the public edge reaches over TLS with a token.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTestCa,
  freePort,
  removeDir,
  send,
  startBackend,
  startEdge,
  tempDir,
  type FakeBackend,
  type RunningEdge,
  type TestCa,
} from "./harness.js";

const TOKEN = "relay-token-0123456789";
const UPSTREAM = "web.nbo-p-abc123.svc.cluster.local:8080";

describe("black-box: relay mode", () => {
  let edge: RunningEdge;
  let ca: TestCa;
  let dir: string;
  let decoy: FakeBackend;
  let upstream: FakeBackend;

  beforeAll(async () => {
    dir = tempDir();
    ca = await createTestCa();
    const leaf = await ca.leaf({ dns: ["relay.test"], ip: ["127.0.0.1"] });
    writeFileSync(join(dir, "relay.crt"), leaf.cert);
    writeFileSync(join(dir, "relay.key"), leaf.key);
    decoy = await startBackend("decoy");
    upstream = await startBackend("upstream");
    edge = await startEdge({
      mode: "relay",
      env: {
        NBO_RELAY_TOKEN: TOKEN,
        NBO_RELAY_TLS_CERT: join(dir, "relay.crt"),
        NBO_RELAY_TLS_KEY: join(dir, "relay.key"),
        // Test-only: connect to this address once x-nbo-upstream has passed
        // the pattern (the Service name does not resolve here).
        NBO_EDGE_RELAY_UPSTREAM_OVERRIDE: new URL(upstream.url).host,
      },
    });
  }, 30_000);
  afterAll(async () => {
    await edge?.stop();
    await decoy?.close();
    await upstream?.close();
    if (dir) removeDir(dir);
  });

  const relay = (headers: Record<string, string>, rawPath?: string) =>
    send(`${edge.dataUrl}/x`, { ca: ca.cert, headers: { host: "relay.test", ...headers }, rawPath });

  it("serves TLS with its configured certificate", async () => {
    // The CA verifies the handshake; a request without a token is refused.
    const r = await relay({});
    expect(r.status).toBe(403);
  });

  it("answers 403 to a missing, wrong or wrong-length token", async () => {
    for (const headers of [
      {},
      { "x-nbo-relay-token": "relay-token-0123456788" },
      { "x-nbo-relay-token": "short" },
      { "x-nbo-relay-token": `${TOKEN}x` },
    ]) {
      const r = await relay({ ...headers, "x-nbo-upstream": UPSTREAM });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.body).toBe("relay: forbidden");
    }
  });

  it("answers 502 relay: upstream unreachable, naming nothing internal, when the upstream refuses", async () => {
    const port = await freePort();
    const down = await startEdge({
      mode: "relay",
      env: {
        NBO_RELAY_TOKEN: TOKEN,
        NBO_RELAY_TLS_CERT: join(dir, "relay.crt"),
        NBO_RELAY_TLS_KEY: join(dir, "relay.key"),
        NBO_EDGE_RELAY_UPSTREAM_OVERRIDE: `127.0.0.1:${port}`,
      },
    });
    try {
      const r = await send(`${down.dataUrl}/x`, {
        ca: ca.cert,
        headers: { host: "relay.test", "x-nbo-relay-token": TOKEN, "x-nbo-upstream": UPSTREAM },
      });
      expect(r.status).toBe(502);
      expect(r.body).toBe("relay: upstream unreachable");
    } finally {
      await down.stop();
    }
  }, 30_000);

  it("answers 400 to an upstream outside the project-Service pattern", async () => {
    const port = new URL(decoy.url).port;
    for (const upstream of [
      "",
      `127.0.0.1:${port}`,
      "evil.example:8080",
      "web.nbo-p-abc123.svc.cluster.local:80",
      "web.nbo-p-abc123.svc.cluster.local",
      "web.kube-system.svc.cluster.local:8080",
      "Web.nbo-p-abc123.svc.cluster.local:8080",
      "web.nbo-p-abc123.svc.cluster.local:8080/x",
    ]) {
      const r = await relay({ "x-nbo-relay-token": TOKEN, "x-nbo-upstream": upstream });
      expect(r.status, upstream).toBe(400);
      expect(r.body).toBe("relay: bad upstream");
    }
    expect(decoy.seen).toHaveLength(0);
  });

  it("forwards a valid request to the upstream with its path and query, without the relay headers", async () => {
    const before = upstream.seen.length;
    const r = await send(`${edge.dataUrl}/p/q?x=1&y=2`, {
      ca: ca.cert,
      servername: "relay.test",
      method: "POST",
      body: "payload",
      headers: {
        host: "app.test",
        "x-nbo-relay-token": TOKEN,
        "x-nbo-upstream": UPSTREAM,
        "x-forwarded-host": "app.test",
        "x-forwarded-for": "203.0.113.7",
        "x-kept": "1",
      },
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe("upstream");
    expect(upstream.seen).toHaveLength(before + 1);
    const seen = upstream.seen.at(-1)!;
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/p/q?x=1&y=2");
    expect(seen.body).toBe("payload");
    expect(seen.headers["x-nbo-relay-token"]).toBeUndefined();
    expect(seen.headers["x-nbo-upstream"]).toBeUndefined();
    // The public edge's forwarding headers pass through as received.
    expect(seen.headers["x-forwarded-host"]).toBe("app.test");
    expect(seen.headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(seen.headers["x-kept"]).toBe("1");
  });

  it("uses only the path of an absolute-form request target, never its host", async () => {
    // The target names the decoy; a relay that followed it would reach it.
    const r = await relay({ "x-nbo-relay-token": TOKEN, "x-nbo-upstream": UPSTREAM }, `${decoy.url}/secret?q=1`);
    expect(r.status).toBe(200);
    expect(r.body).toBe("upstream");
    expect(upstream.seen.at(-1)!.url).toBe("/secret?q=1");
    const bad = await relay({ "x-nbo-relay-token": "wrong", "x-nbo-upstream": UPSTREAM }, `${decoy.url}/secret`);
    expect(bad.status).toBe(403);
    expect(decoy.seen).toHaveLength(0);
  });

  it("never reaches the upstream for a refused request", async () => {
    const before = upstream.seen.length;
    await relay({ "x-nbo-relay-token": "wrong", "x-nbo-upstream": UPSTREAM });
    await relay({ "x-nbo-relay-token": TOKEN, "x-nbo-upstream": "evil.example:8080" });
    expect(upstream.seen).toHaveLength(before);
  });
});
