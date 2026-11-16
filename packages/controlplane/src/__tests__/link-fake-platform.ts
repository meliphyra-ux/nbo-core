// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import {
  authBytes,
  b64u,
  enrollBytes,
  exportPublicKey,
  generateSigningKeyPair,
  keyFingerprint,
  parseEnrollRequest,
  parseMessage,
  rotateBytes,
  sign,
  verify,
  type EnrollRequest,
  type Envelope,
  type LinkMessage,
} from "@nbo/link-protocol";
import {
  CORE_ID,
  TEAM_ID,
  makeEnvelope,
  signInstruction,
  type LinkTestKeys,
  type TestKey,
  type TestMemberKey,
} from "./link-keys-fixture.js";

// A fake platform for link tests, on 127.0.0.1: the WebSocket /v1/link,
// the long-poll endpoints (/v1/session, /v1/session/answer, /v1/poll,
// /v1/send), /v1/healthz and /v1/enroll. It signs instructions with the
// fixture's platform key (or a rotated one) and records every message core
// sends. Tests close it in afterEach.

export interface FakePlatformOptions {
  // linkHost: what the challenge names (default: the server's own host:port).
  linkHost?: string;
  // refuseUpgrade: answer every WebSocket upgrade with 503.
  refuseUpgrade?: boolean;
  // healthzStatus: what GET /v1/healthz answers (default 200).
  healthzStatus?: number;
  // pollWaitMs: how long /v1/poll holds an empty poll (default 25 s).
  pollWaitMs?: number;
  // enroll: answers POST /v1/enroll; the default accepts any code in
  // `codes` once and trusts the core's identity key.
  enroll?: (req: EnrollRequest, raw: string) => { status: number; body: unknown } | undefined;
  codes?: string[];
  // onUpgrade: takes over an accepted WebSocket (the default challenge,
  // answer check and welcome do not run); for protocol-order tests.
  onUpgrade?: (ws: WebSocket) => void;
}

export interface Received {
  transport: "websocket" | "long-poll";
  message: LinkMessage;
}

export interface FakePlatform {
  url: string;
  host: string;
  keys: LinkTestKeys;
  // platformKey: the key instructions are signed with now.
  platformKey: TestKey;
  options: FakePlatformOptions;
  received: Received[];
  // upgrades: WebSocket upgrade attempts seen; connects: authenticated connections (both transports).
  upgrades: number;
  connects: { at: number; transport: "websocket" | "long-poll" }[];
  enrollRequests: string[];
  trust(coreId: string, identityPublic: string): void;
  // send: a raw message to the live connection (WebSocket or long-poll queue).
  send(m: unknown): void;
  sendInstruction(over?: Partial<Envelope>, opts?: { member?: TestMemberKey }): Promise<string>;
  rotate(next: TestKey, signWith: TestKey): Promise<void>;
  revoke(): void;
  closeSocket(): void;
  // dropSessions: forget every long-poll session (their next poll or send is a 401).
  dropSessions(): void;
  waitFor<T>(f: () => T | undefined | false, timeoutMs?: number): Promise<T>;
  messagesFor(id: string): LinkMessage[];
  close(): Promise<void>;
}

export async function makeTestKey(): Promise<TestKey> {
  const pair = await generateSigningKeyPair(false);
  const publicKey = await exportPublicKey(pair.publicKey);
  return { keyId: await keyFingerprint(publicKey), publicKey, privateKey: pair.privateKey };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startFakePlatform(keys: LinkTestKeys, options: FakePlatformOptions = {}): Promise<FakePlatform> {
  const trusted = new Map<string, string>();
  const codes = new Set(options.codes ?? []);
  const wss = new WebSocketServer({ noServer: true });
  let live: WebSocket | null = null;
  // Long-poll: challenges handed out, live sessions and their queues.
  const challenges = new Map<string, string>();
  const sessions = new Map<string, { coreId: string; queue: unknown[]; wake: (() => void) | null }>();
  let liveSession: string | null = null;

  const p: FakePlatform = {
    url: "",
    host: "",
    keys,
    platformKey: keys.platform,
    options,
    received: [],
    upgrades: 0,
    connects: [],
    enrollRequests: [],
    trust(coreId, identityPublic) {
      trusted.set(coreId, identityPublic);
    },
    send(m) {
      if (live && live.readyState === WebSocket.OPEN) {
        live.send(JSON.stringify(m));
        return;
      }
      const s = liveSession ? sessions.get(liveSession) : undefined;
      if (!s) throw new Error("fake platform: no live connection");
      s.queue.push(m);
      s.wake?.();
    },
    async sendInstruction(over = {}, opts = {}) {
      const env = makeEnvelope(keys, new Date(), { platformKeyId: p.platformKey.keyId, ...over });
      const instruction = await signInstruction(keys, env, {
        platformKey: p.platformKey,
        ...(opts.member ? { member: opts.member } : {}),
      });
      p.send({ type: "instruction", linkVersion: 1, instruction });
      return env.id;
    },
    async rotate(next, signWith) {
      const signature = await sign(
        signWith.privateKey,
        rotateBytes({ coreId: CORE_ID, newKeyId: next.keyId, newPublicKey: next.publicKey }),
      );
      p.send({ type: "rotate-key", linkVersion: 1, newKeyId: next.keyId, newPublicKey: next.publicKey, signature });
    },
    revoke() {
      p.send({ type: "revoked", linkVersion: 1 });
    },
    closeSocket() {
      live?.close(1001);
      live = null;
    },
    dropSessions() {
      const old = [...sessions.values()];
      sessions.clear();
      liveSession = null;
      for (const s of old) s.wake?.();
    },
    async waitFor(f, timeoutMs = 5000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const v = f();
        if (v !== undefined && v !== false) return v as never;
        if (Date.now() > until) throw new Error("fake platform: timed out waiting");
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    messagesFor(id) {
      return p.received.map((r) => r.message).filter((m) => "id" in m && m.id === id);
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      for (const s of sessions.values()) s.wake?.();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  const record = (transport: Received["transport"], raw: string): LinkMessage | null => {
    try {
      const m = parseMessage(raw);
      p.received.push({ transport, message: m });
      return m;
    } catch {
      return null;
    }
  };

  const answerOk = async (coreId: string, challenge: string, signature: string): Promise<boolean> => {
    const key = trusted.get(coreId);
    if (!key) return false;
    return verify(key, signature, authBytes({ coreId, challenge, linkHost: options.linkHost ?? p.host }));
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/v1/healthz") {
      res.writeHead(options.healthzStatus ?? 200).end("ok");
      return;
    }
    if (req.method !== "POST") return void res.writeHead(404).end();
    const raw = await readBody(req);
    if (path === "/v1/enroll") {
      p.enrollRequests.push(raw);
      let er: EnrollRequest;
      try {
        er = parseEnrollRequest(raw);
      } catch {
        return json(res, 400, { error: "bad enroll request" });
      }
      const custom = options.enroll?.(er, raw);
      if (custom) return json(res, custom.status, custom.body);
      const proofOk = await verify(
        er.identityKey,
        er.proof,
        enrollBytes({ code: er.code, identityKey: er.identityKey, encryptionKey: er.encryptionKey }),
      );
      if (!proofOk || !codes.delete(er.code))
        return json(res, 410, { error: "enrollment code is used, expired or unknown" });
      p.trust(CORE_ID, er.identityKey);
      return json(res, 200, {
        coreId: CORE_ID,
        teamId: TEAM_ID,
        platformKey: { keyId: p.platformKey.keyId, publicKey: p.platformKey.publicKey },
        linkHost: options.linkHost ?? p.host,
        ownerKey: { memberId: keys.owner.memberId, publicKey: keys.owner.publicKey },
      });
    }
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "not JSON" });
    }
    if (path === "/v1/session") {
      if (typeof body?.coreId !== "string" || !trusted.has(body.coreId))
        return json(res, 401, { error: "unknown core" });
      const challenge = b64u.encode(randomBytes(32));
      challenges.set(challenge, body.coreId);
      return json(res, 200, { challenge, linkHost: options.linkHost ?? p.host });
    }
    if (path === "/v1/session/answer") {
      const coreId = challenges.get(body?.challenge);
      challenges.delete(body?.challenge);
      if (!coreId || coreId !== body.coreId || !(await answerOk(coreId, body.challenge, body.signature)))
        return json(res, 401, { error: "refused" });
      const session = randomUUID();
      sessions.set(session, { coreId, queue: [], wake: null });
      liveSession = session;
      p.connects.push({ at: Date.now(), transport: "long-poll" });
      return json(res, 200, { session, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    }
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const s = auth ? sessions.get(auth) : undefined;
    if (path === "/v1/poll" || path === "/v1/send") {
      if (!s) return json(res, 401, { error: "no session" });
      if (path === "/v1/send") {
        for (const m of Array.isArray(body?.messages) ? body.messages : []) record("long-poll", JSON.stringify(m));
        return json(res, 200, {});
      }
      if (s.queue.length === 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, options.pollWaitMs ?? 25_000);
          function done(): void {
            clearTimeout(t);
            s!.wake = null;
            resolve();
          }
          s.wake = done;
        });
      }
      return json(res, 200, { messages: s.queue.splice(0) });
    }
    res.writeHead(404).end();
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    p.upgrades++;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (options.refuseUpgrade || path !== "/v1/link") {
      socket.end("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (options.onUpgrade) {
        ws.on("message", (data) => void record("websocket", data.toString()));
        options.onUpgrade(ws);
        return;
      }
      const challenge = b64u.encode(randomBytes(32));
      let authed = false;
      ws.on("message", async (data) => {
        const m = record("websocket", data.toString());
        if (!m) return;
        if (!authed && m.type === "challenge-answer") {
          if (m.challenge === challenge && (await answerOk(m.coreId, m.challenge, m.signature))) {
            authed = true;
            live = ws;
            p.connects.push({ at: Date.now(), transport: "websocket" });
            ws.send(
              JSON.stringify({ type: "welcome", linkVersion: 1, coreId: m.coreId, platformKeyId: p.platformKey.keyId }),
            );
          } else {
            ws.close(4001);
          }
        }
      });
      ws.on("close", () => {
        if (live === ws) live = null;
      });
      ws.send(JSON.stringify({ type: "challenge", linkVersion: 1, challenge, linkHost: options.linkHost ?? p.host }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  p.host = `127.0.0.1:${port}`;
  p.url = `http://127.0.0.1:${port}`;
  return p;
}
