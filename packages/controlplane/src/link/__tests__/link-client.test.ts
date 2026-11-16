// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, rotateBytes, sign, type LinkMessage, type SignedInstruction } from "@nbo/link-protocol";
import { createStore, type Store } from "../../store/store.js";
import { createDispatcher, type Dispatcher, type LinkReply } from "../dispatch.js";
import { sendReply, startLinkClient, type LinkClient } from "../client.js";
import { linkEndpoints, sameLinkHost, type Connection } from "../transport.js";
import { startHarness, staticSetup, type Harness } from "../../__tests__/v2-harness.js";
import {
  CORE_ID,
  makeEnvelope,
  makeLinkTestKeys,
  noSecrets,
  pinLink,
  signInstruction,
  type LinkTestKeys,
} from "../../__tests__/link-keys-fixture.js";
import {
  makeTestKey,
  startFakePlatform,
  type FakePlatform,
  type FakePlatformOptions,
} from "../../__tests__/link-fake-platform.js";

let keys: LinkTestKeys;
beforeAll(async () => {
  keys = await makeLinkTestKeys();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const NOW = new Date("2026-11-13T12:00:00.000Z");
const fixedNow = () => NOW;

async function platform(opts: FakePlatformOptions = {}): Promise<FakePlatform> {
  const p = await startFakePlatform(keys, opts);
  cleanups.push(() => p.close());
  return p;
}

async function harness(p: FakePlatform): Promise<Harness> {
  const h = await startHarness({ secretKey: true });
  cleanups.push(() => h.close());
  await pinLink(h.store, keys, { linkUrl: p.url, linkHost: p.host });
  p.trust(h.store.getLinkState()!.coreId, h.store.getLinkState()!.identityPublic);
  return h;
}

async function bareStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "nbo-link-client-"));
  const store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  cleanups.push(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return store;
}

function client(
  store: Store,
  h: Harness | null,
  over: { random?: () => number; now?: () => Date; dispatcher?: Dispatcher } = {},
): LinkClient {
  const ac = new AbortController();
  const dispatcher =
    over.dispatcher ??
    (h
      ? createDispatcher({ ...noSecrets, store: h.store, mux: h.mux })
      : {
          dispatch: async () => {
            throw new Error("no dispatch here");
          },
        });
  const c = startLinkClient({
    store,
    dispatcher,
    signal: ac.signal,
    now: over.now ?? fixedNow,
    random: over.random ?? (() => 0),
  });
  cleanups.push(() => c.stop());
  return c;
}

const until = async (f: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function decodeStream(msgs: LinkMessage[]): string {
  return Buffer.concat(
    msgs
      .filter((m): m is Extract<LinkMessage, { type: "stream-chunk" }> => m.type === "stream-chunk")
      .sort((a, b) => a.index - b.index)
      .map((m) => b64u.decode(m.data)),
  ).toString("utf8");
}

describe("link client", () => {
  it("connects, answers the challenge and reports connected", async () => {
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    expect(c.status()).toEqual({
      connection: "connected",
      transport: "websocket",
      lastConnectedAt: NOW.toISOString(),
      lastError: null,
    });
    expect(p.received.some((r) => r.message.type === "challenge-answer")).toBe(true);
    expect(p.connects).toHaveLength(1);
  });

  it("refuses a challenge for another host and does not connect", async () => {
    const p = await platform({ linkHost: "evil.example.test" });
    const h = await harness(p);
    const c = client(h.store, h, { random: () => 0.999 });
    await until(() => (c.status().lastError ?? "").includes("another link host"));
    expect(c.status().connection).toBe("connecting");
    expect(p.received.filter((r) => r.message.type === "challenge-answer")).toHaveLength(0);
    expect(p.connects).toHaveLength(0);
  });

  it("runs an instruction and sends its response", async () => {
    const p = await platform();
    const h = await harness(p);
    await h.call("POST", "/projects", { name: "shop" });
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    const id = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    const res = (await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "response"))) as Extract<
      LinkMessage,
      { type: "response" }
    >;
    expect(res.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(b64u.decode(res.body)))).toEqual(
      (await h.call("GET", "/projects")).json,
    );
    expect(h.store.listJournal({ limit: 10 }).some((j) => j.id === id && j.accepted)).toBe(true);
  });

  it("streams a reply as chunks ending with stream-end", async () => {
    const p = await platform();
    const h = await harness(p);
    const project = h.store.createProject("shop");
    const build = h.store.createBuild(project.id, "a".repeat(40));
    const log = Array.from({ length: 50 }, (_, n) => `line ${n}\n`).join("");
    h.store.appendBuildLog(build.id, log);
    h.store.completeBuild(build.id, "succeeded");
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    const id = await p.sendInstruction({
      method: "GET",
      routePattern: "/builds/{buildID}/log",
      params: { buildID: build.id },
    });
    await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "stream-end"));
    const msgs = p.messagesFor(id);
    expect(msgs[0]).toMatchObject({ type: "stream-start", status: 200 });
    expect(msgs.at(-1)).toEqual({ type: "stream-end", linkVersion: 1, id });
    expect(decodeStream(msgs)).toBe(log);
  });

  it("reconnects with jitter after the platform closes the socket", async () => {
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h, { random: () => 0.5 });
    await until(() => c.status().connection === "connected");
    const closedAt = Date.now();
    p.closeSocket();
    await until(() => p.connects.length === 2);
    // attempt 1: 0.5 * min(60 s, 1 s * 2^1) = 1 s, inside [0, 2 s].
    const delay = p.connects[1]!.at - closedAt;
    expect(delay).toBeGreaterThanOrEqual(900);
    expect(delay).toBeLessThan(2000);
    await until(() => c.status().connection === "connected");
  });

  it("falls back to long-poll when the WebSocket upgrade is refused but /v1/healthz answers", async () => {
    const p = await platform({ refuseUpgrade: true, pollWaitMs: 100 });
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    expect(c.status().transport).toBe("long-poll");
    expect(p.upgrades).toBe(3);
    expect(p.connects).toEqual([expect.objectContaining({ transport: "long-poll" })]);
    const id = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    const res = await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "response"));
    expect(res).toMatchObject({ status: 200 });
    expect(p.received.find((r) => r.message.type === "response")?.transport).toBe("long-poll");
  });

  it("a 401 on poll starts a new long-poll session", async () => {
    const p = await platform({ refuseUpgrade: true, pollWaitMs: 100 });
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    p.dropSessions();
    await until(() => p.connects.length === 2 && c.status().connection === "connected");
    expect(p.connects.map((x) => x.transport)).toEqual(["long-poll", "long-poll"]);
    const id = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    expect(await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "response"))).toMatchObject({ status: 200 });
  });

  it("tries the WebSocket again after 15 minutes of long-poll", async () => {
    const p = await platform({ refuseUpgrade: true, pollWaitMs: 50 });
    const h = await harness(p);
    let t = NOW.getTime();
    const c = client(h.store, h, { now: () => new Date(t) });
    await until(() => c.status().transport === "long-poll");
    p.options.refuseUpgrade = false;
    t += 15 * 60_000 - 1000;
    await new Promise((r) => setTimeout(r, 200));
    expect(c.status().transport).toBe("long-poll");
    t += 1000;
    await until(() => c.status().transport === "websocket");
    expect(p.connects.map((x) => x.transport)).toEqual(["long-poll", "websocket"]);
  });

  it("does not fall back to long-poll while /v1/healthz fails", async () => {
    const p = await platform({ refuseUpgrade: true, healthzStatus: 503 });
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => p.upgrades >= 5);
    expect(c.status().connection).toBe("connecting");
    expect(p.connects).toHaveLength(0);
  });

  it("accepts a key rotation signed by the old key and acks it", async () => {
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    const next = await makeTestKey();
    await p.rotate(next, keys.platform);
    await p.waitFor(() => p.received.find((r) => r.message.type === "rotation-ack"));
    expect(p.received.find((r) => r.message.type === "rotation-ack")?.message).toEqual({
      type: "rotation-ack",
      linkVersion: 1,
      keyId: next.keyId,
    });
    expect(h.store.getLinkState()).toMatchObject({ platformKeyId: next.keyId, platformKey: next.publicKey });
    expect(h.store.listJournal({ limit: 10 }).some((j) => j.reason === `platform key rotated to ${next.keyId}`)).toBe(
      true,
    );
    // Instructions signed by the new key now run.
    p.platformKey = next;
    const id = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    expect(await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "response"))).toMatchObject({ status: 200 });
  });

  it("refuses a rotation signed by another key and keeps the old one", async () => {
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    const next = await makeTestKey();
    await p.rotate(next, keys.stranger);
    await until(() => h.store.listJournal({ limit: 10 }).some((j) => j.route === "rotate-key"));
    const row = h.store.listJournal({ limit: 10 }).find((j) => j.route === "rotate-key")!;
    expect(row.accepted).toBe(false);
    expect(row.reason).toMatch(/refused/);
    expect(h.store.getLinkState()).toMatchObject({
      platformKeyId: keys.platform.keyId,
      platformKey: keys.platform.publicKey,
    });
    expect(p.received.some((r) => r.message.type === "rotation-ack")).toBe(false);
  });

  it("a lost rotation-ack is recovered: the re-announced key is acknowledged again and its instructions run", async () => {
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    const v2 = await makeTestKey();
    await p.rotate(v2, keys.platform);
    await until(() => h.store.getLinkState()?.platformKeyId === v2.keyId);
    // The platform never saw that ack: the connection drops and it re-announces v2 signed by v1.
    p.closeSocket();
    await until(() => p.connects.length >= 2 && c.status().connection === "connected");
    const acks = () => p.received.filter((r) => r.message.type === "rotation-ack").length;
    const before = acks();
    // Re-announced until acknowledged (an announce that beats core's handling of the welcome is ignored).
    for (let i = 0; i < 25 && acks() === before; i++) {
      await p.rotate(v2, keys.platform);
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(acks()).toBeGreaterThan(before);
    expect(p.received.filter((r) => r.message.type === "rotation-ack").at(-1)?.message).toEqual({
      type: "rotation-ack",
      linkVersion: 1,
      keyId: v2.keyId,
    });
    expect(h.store.getLinkState()).toMatchObject({ platformKeyId: v2.keyId, platformKey: v2.publicKey });
    expect(h.store.listJournal({ limit: 20 }).some((j) => j.route === "rotate-key" && !j.accepted)).toBe(false);
    p.platformKey = v2;
    const id = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    expect(await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "response"))).toMatchObject({ status: 200 });
  });

  it("a rotation to another key signed by the previous, no longer pinned key is refused", async () => {
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    const v2 = await makeTestKey();
    await p.rotate(v2, keys.platform);
    await until(() => h.store.getLinkState()?.platformKeyId === v2.keyId);
    const other = await makeTestKey();
    await p.rotate(other, keys.platform);
    await until(() => h.store.listJournal({ limit: 20 }).some((j) => j.route === "rotate-key" && !j.accepted));
    expect(h.store.getLinkState()).toMatchObject({ platformKeyId: v2.keyId, platformKey: v2.publicKey });
    expect(p.received.filter((r) => r.message.type === "rotation-ack")).toHaveLength(1);
  });

  it("two rotations one version at a time are both accepted", async () => {
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    const v2 = await makeTestKey();
    const v3 = await makeTestKey();
    await p.rotate(v2, keys.platform);
    await p.rotate(v3, v2);
    await until(() => p.received.filter((r) => r.message.type === "rotation-ack").length === 2);
    expect(h.store.getLinkState()).toMatchObject({ platformKeyId: v3.keyId, platformKey: v3.publicKey });
    p.platformKey = v3;
    const id = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    expect(await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "response"))).toMatchObject({ status: 200 });
  });

  it("a revocation stops reconnecting until restart", async () => {
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    p.revoke();
    await until(() => c.status().connection === "off");
    await new Promise((r) => setTimeout(r, 300));
    expect(p.connects).toHaveLength(1);
    expect(h.store.listJournal({ limit: 10 }).some((j) => j.route === "revoked")).toBe(true);
    c.restart();
    await until(() => p.connects.length === 2 && c.status().connection === "connected");
  });

  it("a closed socket mid-stream does not stop the build", async () => {
    const p = await platform();
    const h = await harness(p);
    const res = await h.call(
      "POST",
      "/projects/setup",
      staticSetup({
        buildCommand: `node -e "console.log('building');setTimeout(()=>console.log('done'),1500)" && mkdir dist && echo hi > dist/index.html`,
      }),
    );
    expect(res.status).toBe(201);
    const projectId = res.json.project.id as string;
    await h.v2.setup.settled(projectId);
    const build = await p.waitFor(() => h.store.listBuilds(projectId).find((b) => b.status === "running"), 15000);
    const c = client(h.store, h, { random: () => 0 });
    await until(() => c.status().connection === "connected");
    const id = await p.sendInstruction({
      method: "GET",
      routePattern: "/builds/{buildID}/log",
      params: { buildID: build.id },
      query: { follow: "1" },
    });
    await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "stream-start"));
    p.closeSocket();
    await h.v2.queue.idle(projectId);
    expect(h.store.getBuild(build.id)?.status).toBe("succeeded");
    await until(() => p.connects.length === 2 && c.status().connection === "connected");
    // The reply of the closed socket was dropped, not sent on the new one.
    expect(p.messagesFor(id).some((m) => m.type === "stream-end")).toBe(false);
  }, 30000);

  it("stays off while unlinked", async () => {
    const p = await platform();
    const store = await bareStore();
    const c = client(store, null);
    await new Promise((r) => setTimeout(r, 300));
    expect(c.status()).toEqual({ connection: "off", transport: null, lastConnectedAt: null, lastError: null });
    expect(p.upgrades).toBe(0);
  });

  it("stop ends the loop and closes the connection", async () => {
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    await c.stop();
    expect(c.status().connection).toBe("off");
  });
});

describe("linkEndpoints", () => {
  it("uses wss and https on the pinned host", () => {
    expect(linkEndpoints("https://link.example.test", "link.example.test")).toEqual({
      scheme: "https:",
      websocket: "wss://link.example.test/v1/link",
      healthz: "https://link.example.test/v1/healthz",
      base: "https://link.example.test",
    });
  });

  it("allows ws and http only for a loopback host", () => {
    expect(linkEndpoints("http://127.0.0.1:8080", "127.0.0.1:8080").websocket).toBe("ws://127.0.0.1:8080/v1/link");
    expect(linkEndpoints("http://localhost:9", "localhost:9").base).toBe("http://localhost:9");
    expect(() => linkEndpoints("http://link.example.test", "link.example.test")).toThrow(/loopback/);
    expect(() => linkEndpoints("ftp://link.example.test", "link.example.test")).toThrow();
    expect(() => linkEndpoints("https://link.example.test", "user@evil.test")).toThrow();
    expect(() => linkEndpoints("https://link.example.test", "evil.test/path")).toThrow();
  });
});

// A Connection that counts its close listeners.
function countingConnection(): Connection & { listeners(): number; sent: LinkMessage[] } {
  const closers = new Set<() => void>();
  let open = true;
  const sent: LinkMessage[] = [];
  return {
    get open() {
      return open;
    },
    sent,
    async send(m) {
      if (!open) return false;
      sent.push(m);
      return true;
    },
    close() {
      open = false;
      for (const f of [...closers]) f();
      closers.clear();
    },
    onClose(f) {
      closers.add(f);
      return () => void closers.delete(f);
    },
    listeners: () => closers.size,
  };
}

async function* chunksOf(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield new TextEncoder().encode(p);
}
async function* failing(): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode("x");
  throw new Error("boom");
}
const streamReply = (chunks: AsyncIterable<Uint8Array>): LinkReply => ({
  kind: "stream",
  status: 200,
  headers: {},
  chunks,
});

describe("sendReply", () => {
  it("leaves no close listener behind once each stream has ended", async () => {
    const conn = countingConnection();
    const baseline = conn.listeners();
    for (let n = 0; n < 5; n++) await sendReply(conn, `s${n}`, streamReply(chunksOf("a", "b")));
    await sendReply(conn, "big", { kind: "response", status: 200, headers: {}, body: new Uint8Array(2 * 1024 * 1024) });
    await sendReply(conn, "err", streamReply(failing()));
    expect(conn.listeners()).toBe(baseline);
    expect(conn.sent.filter((m) => m.type === "stream-end")).toHaveLength(7);
    expect(conn.sent.at(-1)).toEqual({ type: "stream-end", linkVersion: 1, id: "err", error: "stream failed" });
  });

  it("keeps one abort listener through a long stream and none after it", async () => {
    const conn = countingConnection();
    const ctl = new AbortController();
    const seen: number[] = [];
    const parts = Array.from({ length: 500 }, () => "x");
    async function* counted(): AsyncIterable<Uint8Array> {
      for (const p of parts) {
        seen.push(getEventListeners(ctl.signal, "abort").length);
        yield new TextEncoder().encode(p);
      }
    }
    await sendReply(conn, "long", streamReply(counted()), ctl.signal);
    expect(Math.max(...seen)).toBe(1);
    expect(getEventListeners(ctl.signal, "abort")).toHaveLength(0);
    expect(conn.sent.filter((m) => m.type === "stream-chunk")).toHaveLength(500);
    expect(conn.sent.at(-1)).toEqual({ type: "stream-end", linkVersion: 1, id: "long" });
  });
});

describe("link client protocol order", () => {
  it("closes the connection on a welcome that came before any challenge-answer", async () => {
    const p = await platform({
      onUpgrade: (ws) =>
        ws.send(
          JSON.stringify({ type: "welcome", linkVersion: 1, coreId: CORE_ID, platformKeyId: keys.platform.keyId }),
        ),
    });
    const h = await harness(p);
    const c = client(h.store, h, { random: () => 0.999 });
    await until(() => (c.status().lastError ?? "").includes("protocol"));
    expect(c.status().connection).toBe("connecting");
    expect(c.status().lastConnectedAt).toBeNull();
  });

  it("ignores an instruction and a rotate-key that arrive before the welcome", async () => {
    const calls: string[] = [];
    let realDispatcher: Dispatcher | null = null;
    const dispatcher: Dispatcher = {
      dispatch: async (i: SignedInstruction) => {
        calls.push(i.envelope.id);
        return realDispatcher!.dispatch(i);
      },
    };
    const early = await makeTestKey();
    let earlyId = "";
    let lateId = "";
    const box: { p?: FakePlatform } = {};
    const p = await platform({
      onUpgrade: (ws) => {
        void (async () => {
          const fp = box.p!;
          ws.send(JSON.stringify({ type: "challenge", linkVersion: 1, challenge: "c1", linkHost: fp.host }));
          const env = makeEnvelope(keys, new Date(), { method: "GET", routePattern: "/projects" });
          earlyId = env.id;
          ws.send(
            JSON.stringify({ type: "instruction", linkVersion: 1, instruction: await signInstruction(keys, env) }),
          );
          const signature = await sign(
            keys.platform.privateKey,
            rotateBytes({ coreId: CORE_ID, newKeyId: early.keyId, newPublicKey: early.publicKey }),
          );
          ws.send(
            JSON.stringify({
              type: "rotate-key",
              linkVersion: 1,
              newKeyId: early.keyId,
              newPublicKey: early.publicKey,
              signature,
            }),
          );
          await fp.waitFor(() => fp.received.find((r) => r.message.type === "challenge-answer"));
          ws.send(
            JSON.stringify({ type: "welcome", linkVersion: 1, coreId: CORE_ID, platformKeyId: keys.platform.keyId }),
          );
          const late = makeEnvelope(keys, new Date(), { method: "GET", routePattern: "/projects" });
          lateId = late.id;
          ws.send(
            JSON.stringify({ type: "instruction", linkVersion: 1, instruction: await signInstruction(keys, late) }),
          );
        })();
      },
    });
    box.p = p;
    const h = await harness(p);
    realDispatcher = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const c = client(h.store, h, { dispatcher });
    await until(() => lateId !== "" && p.messagesFor(lateId).some((m) => m.type === "response"));
    expect(c.status().connection).toBe("connected");
    expect(calls).toEqual([lateId]);
    expect(calls).not.toContain(earlyId);
    expect(h.store.getLinkState()?.platformKeyId).toBe(keys.platform.keyId);
    expect(p.received.some((r) => r.message.type === "rotation-ack")).toBe(false);
  });

  it("refuses a rotation to a small-order key and journals it", async () => {
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => c.status().connection === "connected");
    const smallOrder = b64u.encode(Uint8Array.from([1, ...new Array<number>(31).fill(0)]));
    const signature = await sign(
      keys.platform.privateKey,
      rotateBytes({ coreId: CORE_ID, newKeyId: "small", newPublicKey: smallOrder }),
    );
    p.send({ type: "rotate-key", linkVersion: 1, newKeyId: "small", newPublicKey: smallOrder, signature });
    await until(() => h.store.listJournal({ limit: 10 }).some((j) => j.route === "rotate-key"));
    expect(h.store.listJournal({ limit: 10 }).find((j) => j.route === "rotate-key")).toMatchObject({ accepted: false });
    expect(h.store.getLinkState()?.platformKeyId).toBe(keys.platform.keyId);
    expect(p.received.some((r) => r.message.type === "rotation-ack")).toBe(false);
  });

  it("cancels the source stream when the socket closes mid-stream", async () => {
    let cancelled = false;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          async next() {
            if (!sent) {
              sent = true;
              return { done: false, value: new TextEncoder().encode("first") };
            }
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
          async return() {
            cancelled = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const dispatcher: Dispatcher = { dispatch: async () => streamReply(source) };
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h, { dispatcher, random: () => 0.999 });
    await until(() => c.status().connection === "connected");
    const id = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "stream-chunk"));
    expect(cancelled).toBe(false);
    p.closeSocket();
    await until(() => cancelled);
  });

  it("restart drops a pending long-poll at once", async () => {
    const p = await platform({ refuseUpgrade: true });
    const h = await harness(p);
    const c = client(h.store, h);
    await until(() => c.status().transport === "long-poll");
    // The platform holds the poll for 25 s; a restart must not wait for it.
    await new Promise((r) => setTimeout(r, 100));
    c.restart();
    await until(() => p.connects.length === 2, 3000);
  });
});

// A stream that yields a chunk every 20 ms until returned, and records the return.
function tickingStream(): { source: AsyncIterable<Uint8Array>; returned: () => boolean } {
  let returned = false;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (returned) return { done: true, value: undefined };
          await new Promise((r) => setTimeout(r, 20));
          return { done: false, value: new TextEncoder().encode("tick\n") };
        },
        async return() {
          returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { source, returned: () => returned };
}

const okReply = (): LinkReply => ({ kind: "response", status: 200, headers: {}, body: new TextEncoder().encode("{}") });

describe("cancel", () => {
  it("a cancel stops the stream's source and ends it with stream-end cancelled", async () => {
    const s = tickingStream();
    const dispatcher: Dispatcher = { dispatch: async () => streamReply(s.source) };
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h, { dispatcher });
    await until(() => c.status().connection === "connected");
    const id = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    await p.waitFor(() => p.messagesFor(id).filter((m) => m.type === "stream-chunk").length >= 2);
    p.send({ type: "cancel", linkVersion: 1, id });
    await until(() => s.returned(), 1000);
    await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "stream-end"));
    expect(p.messagesFor(id).at(-1)).toEqual({ type: "stream-end", linkVersion: 1, id, error: "cancelled" });
    expect(c.status().connection).toBe("connected");
  });

  it("a cancel that comes before the reply sends no stream and still lets the work finish", async () => {
    const s = tickingStream();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let workDone = false;
    let slowId = "";
    const dispatcher: Dispatcher = {
      dispatch: async (i) => {
        if (i.envelope.id !== slowId) return okReply();
        await gate;
        workDone = true;
        return streamReply(s.source);
      },
    };
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h, { dispatcher });
    await until(() => c.status().connection === "connected");
    slowId = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    p.send({ type: "cancel", linkVersion: 1, id: slowId });
    // Messages are handled in order: once a later instruction is answered, the cancel was seen.
    const later = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    await p.waitFor(() => p.messagesFor(later).find((m) => m.type === "response"));
    release();
    await until(() => workDone && s.returned(), 1000);
    await new Promise((r) => setTimeout(r, 100));
    expect(p.messagesFor(slowId)).toEqual([]);
  });

  it("an instruction reusing a live stream's id does not take over its cancel", async () => {
    const s = tickingStream();
    let calls = 0;
    // The second instruction with the same id stands for a replay the dispatcher refuses.
    const dispatcher: Dispatcher = {
      dispatch: async () =>
        ++calls === 1
          ? streamReply(s.source)
          : { kind: "response", status: 409, headers: {}, body: new TextEncoder().encode("{}") },
    };
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h, { dispatcher });
    await until(() => c.status().connection === "connected");
    const id = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "stream-chunk"));
    await p.sendInstruction({ method: "GET", routePattern: "/projects", id });
    await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "response"));
    p.send({ type: "cancel", linkVersion: 1, id });
    await until(() => s.returned(), 1000);
    await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "stream-end"));
    expect(p.messagesFor(id).find((m) => m.type === "stream-end")).toEqual({
      type: "stream-end",
      linkVersion: 1,
      id,
      error: "cancelled",
    });
  });

  it("a cancel against a plain response still delivers it whole", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let slowId = "";
    const body = new TextEncoder().encode('{"whole":true}');
    const dispatcher: Dispatcher = {
      dispatch: async (i) => {
        if (i.envelope.id !== slowId) return okReply();
        await gate;
        return { kind: "response", status: 200, headers: { "content-type": "application/json" }, body };
      },
    };
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h, { dispatcher });
    await until(() => c.status().connection === "connected");
    slowId = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    p.send({ type: "cancel", linkVersion: 1, id: slowId });
    const later = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    await p.waitFor(() => p.messagesFor(later).find((m) => m.type === "response"));
    release();
    const res = (await p.waitFor(() => p.messagesFor(slowId).find((m) => m.type === "response"))) as Extract<
      LinkMessage,
      { type: "response" }
    >;
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(b64u.decode(res.body))).toBe('{"whole":true}');
    expect(p.messagesFor(slowId)).toHaveLength(1);
  });

  it("a cancel for an unknown id is ignored and the connection keeps working", async () => {
    const dispatcher: Dispatcher = { dispatch: async () => okReply() };
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h, { dispatcher });
    await until(() => c.status().connection === "connected");
    p.send({ type: "cancel", linkVersion: 1, id: "ins_nobody" });
    const id = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    const res = await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "response"));
    expect(res).toMatchObject({ type: "response", status: 200 });
    expect(c.status().connection).toBe("connected");
    expect(p.connects).toHaveLength(1);
  });

  it("a cancel for an already-answered id sends no stream-end and does not throw", async () => {
    const dispatcher: Dispatcher = { dispatch: async () => streamReply(chunksOf("a", "b")) };
    const p = await platform();
    const h = await harness(p);
    const c = client(h.store, h, { dispatcher });
    await until(() => c.status().connection === "connected");
    const id = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    await p.waitFor(() => p.messagesFor(id).find((m) => m.type === "stream-end"));
    const before = p.messagesFor(id).length;
    p.send({ type: "cancel", linkVersion: 1, id });
    const next = await p.sendInstruction({ method: "GET", routePattern: "/projects" });
    await p.waitFor(() => p.messagesFor(next).find((m) => m.type === "stream-end"));
    expect(p.messagesFor(id)).toHaveLength(before);
    expect(p.messagesFor(id).filter((m) => m.type === "stream-end")).toEqual([
      { type: "stream-end", linkVersion: 1, id },
    ]);
    expect(c.status()).toMatchObject({ connection: "connected", lastError: null });
    expect(p.connects).toHaveLength(1);
  });
});

describe("sameLinkHost", () => {
  it("treats an explicit default port as the bare host", () => {
    expect(sameLinkHost("link.example.test:443", "link.example.test", "https:")).toBe(true);
    expect(sameLinkHost("Link.Example.Test", "link.example.test:443", "https:")).toBe(true);
    expect(sameLinkHost("127.0.0.1:80", "127.0.0.1", "http:")).toBe(true);
    expect(sameLinkHost("link.example.test:8443", "link.example.test", "https:")).toBe(false);
    expect(sameLinkHost("link.example.test:80", "link.example.test", "https:")).toBe(false);
    expect(sameLinkHost("other.test", "link.example.test", "https:")).toBe(false);
  });

  it("linkEndpoints accepts a pinned host with :443", () => {
    expect(linkEndpoints("https://link.example.test", "link.example.test:443").websocket).toBe(
      "wss://link.example.test/v1/link",
    );
  });
});
