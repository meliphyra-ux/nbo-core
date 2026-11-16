// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import WebSocket from "ws";
import { MAX_MESSAGE_BYTES, parseMessage, type LinkMessage } from "@nbo/link-protocol";

// The two ways core reaches the platform: one WebSocket it opens itself, or,
// for networks that break WebSockets, HTTPS long-poll. Both carry the same
// JSON messages. Nothing here follows a redirect, and plain ws:// or http://
// is used only for a loopback host.

// Connection: one open path to the platform. send resolves false once the
// path has closed; a reply for a closed path is dropped, never queued.
export interface Connection {
  readonly open: boolean;
  send(m: LinkMessage): Promise<boolean>;
  close(): void;
  // onClose runs f once the path closes (at once when it already has) and
  // returns a function that removes f, so a finished reply leaves nothing.
  onClose(f: () => void): () => void;
}

export interface LinkEndpoints {
  scheme: "https:" | "http:";
  websocket: string;
  healthz: string;
  base: string;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

const DEFAULT_PORT: Record<string, string> = { "https:": "443", "http:": "80" };

// normalHost: a host name lowercased, with the scheme's default port dropped
// (link.example:443 is link.example for https); null when it is not a bare
// host[:port].
function normalHost(h: string, scheme: "https:" | "http:"): string | null {
  let u: URL;
  try {
    u = new URL(`${scheme}//${h}`);
  } catch {
    return null;
  }
  const lower = h.toLowerCase();
  if (u.username !== "" || u.password !== "") return null;
  if (u.host !== lower && `${u.host}:${DEFAULT_PORT[scheme]}` !== lower) return null;
  return u.host;
}

// sameLinkHost: a and b name the same host for this scheme.
export function sameLinkHost(a: string, b: string, scheme: "https:" | "http:"): boolean {
  const x = normalHost(a, scheme);
  return x !== null && x === normalHost(b, scheme);
}

// linkEndpoints: the addresses on the pinned link host. The scheme comes from
// the URL saved at enrollment; http is refused unless the host is loopback.
export function linkEndpoints(linkUrl: string, linkHost: string): LinkEndpoints {
  let scheme: "https:" | "http:";
  try {
    const u = new URL(linkUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    scheme = u.protocol;
  } catch {
    throw new Error("the saved link address is not a valid https URL");
  }
  const normal = normalHost(linkHost, scheme);
  if (normal === null) throw new Error("the pinned link host is not a valid host name");
  const host = new URL(`${scheme}//${normal}`);
  if (scheme === "http:" && !isLoopbackHost(host.hostname)) {
    throw new Error("plain http is only allowed for a loopback link host");
  }
  const base = `${scheme}//${host.host}`;
  return {
    scheme,
    websocket: `${scheme === "https:" ? "wss:" : "ws:"}//${host.host}/v1/link`,
    healthz: `${base}/v1/healthz`,
    base,
  };
}

// ---- WebSocket ----

const rawText = (data: WebSocket.RawData): string => {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
};

export function defaultWebSocket(url: string): WebSocket {
  return new WebSocket(url, {
    maxPayload: MAX_MESSAGE_BYTES,
    followRedirects: false,
    handshakeTimeout: 15_000,
    perMessageDeflate: false,
  });
}

// openWebSocket wraps a socket as a Connection. onMessage gets each parsed
// text message; a frame that is binary, too large or not a link message is
// reported through onBadMessage and dropped.
export function wrapWebSocket(
  ws: WebSocket,
  handlers: {
    onMessage: (m: LinkMessage) => void;
    onBadMessage: (why: string) => void;
    onOpen: () => void;
    onClose: (why: string) => void;
  },
): Connection {
  let open = false;
  let closed = false;
  let closeReason = "the connection closed";
  const closers = new Set<() => void>();
  const finish = (): void => {
    if (closed) return;
    closed = true;
    open = false;
    const fs = [...closers];
    closers.clear();
    for (const f of fs) {
      try {
        f();
      } catch {
        // a closer never breaks the others
      }
    }
    handlers.onClose(closeReason);
  };
  ws.on("open", () => {
    if (closed) return;
    open = true;
    handlers.onOpen();
  });
  ws.on("unexpected-response", (_req, res) => {
    closeReason = `the platform refused the WebSocket (HTTP ${res.statusCode ?? 0})`;
    res.resume();
    try {
      ws.terminate();
    } catch {
      // already gone
    }
    finish();
  });
  ws.on("error", (err) => {
    closeReason = `WebSocket error: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`;
    finish();
  });
  ws.on("close", (code) => {
    if (closeReason === "the connection closed") closeReason = `the platform closed the connection (${code})`;
    finish();
  });
  ws.on("message", (data, isBinary) => {
    if (!open) return;
    if (isBinary) {
      handlers.onBadMessage("binary frame");
      return;
    }
    let m: LinkMessage;
    try {
      m = parseMessage(rawText(data));
    } catch (err) {
      handlers.onBadMessage(err instanceof Error ? err.message.slice(0, 200) : "unreadable message");
      return;
    }
    handlers.onMessage(m);
  });
  return {
    get open() {
      return open && !closed;
    },
    send(m) {
      if (!open || closed || ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        try {
          ws.send(JSON.stringify(m), (err) => resolve(!err));
        } catch {
          resolve(false);
        }
      });
    },
    close() {
      try {
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close(1000);
      } catch {
        // already gone
      }
      // Whatever the socket does next, this connection is over for core.
      finish();
    },
    onClose(f) {
      if (closed) {
        f();
        return () => undefined;
      }
      closers.add(f);
      return () => void closers.delete(f);
    },
  };
}

// ---- HTTPS (healthz and long-poll) ----

export type FetchFn = typeof fetch;

const MAX_POLL_BYTES = 4 * MAX_MESSAGE_BYTES;

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`${what} answered HTTP ${status}`);
  }
}

async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    total += r.value.length;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error("the platform's answer is too large");
    }
    parts.push(r.value);
  }
  return Buffer.concat(parts).toString("utf8");
}

// postJson: one POST, no redirects, a timeout, a size cap. A status other
// than 200 throws HttpStatusError (its body is never read into a message).
export async function postJson(
  f: FetchFn,
  url: string,
  body: unknown,
  opts: { signal: AbortSignal; timeoutMs: number; bearer?: string; what: string },
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await f(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]),
  });
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpStatusError(res.status, opts.what);
  }
  const text = await readCapped(res, MAX_POLL_BYTES);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${opts.what} answered something that is not JSON`);
  }
}

// healthzOk: GET <base>/v1/healthz answers 200 within 5 s.
export async function healthzOk(f: FetchFn, url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await f(url, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
    await res.body?.cancel().catch(() => undefined);
    return res.status === 200;
  } catch {
    return false;
  }
}

// parseMessages: the messages array of a poll answer, each checked like a
// WebSocket frame. A bad entry is reported and skipped.
export function parseMessages(v: unknown, onBad: (why: string) => void): LinkMessage[] {
  if (typeof v !== "object" || v === null || !Array.isArray((v as { messages?: unknown }).messages)) {
    throw new Error("the poll answer has no messages array");
  }
  const out: LinkMessage[] = [];
  for (const m of (v as { messages: unknown[] }).messages) {
    try {
      out.push(parseMessage(JSON.stringify(m)));
    } catch (err) {
      onBad(err instanceof Error ? err.message.slice(0, 200) : "unreadable message");
    }
  }
  return out;
}

// longPollConnection: a Connection whose sends go to POST /v1/send with the
// session token, one at a time in order. A 401 or any failure closes it.
export function longPollConnection(
  f: FetchFn,
  base: string,
  session: string,
  signal: AbortSignal,
  onClose: (why: string) => void,
): Connection & { fail(why: string): void } {
  let closed = false;
  const closers = new Set<() => void>();
  let chain: Promise<unknown> = Promise.resolve();
  const fail = (why: string): void => {
    if (closed) return;
    closed = true;
    const fns = [...closers];
    closers.clear();
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // a closer never breaks the others
      }
    }
    onClose(why);
  };
  return {
    get open() {
      return !closed;
    },
    send(m) {
      if (closed) return Promise.resolve(false);
      const p = chain.then(async () => {
        if (closed) return false;
        try {
          await postJson(
            f,
            `${base}/v1/send`,
            { messages: [m] },
            { signal, timeoutMs: 30_000, bearer: session, what: "the platform's send endpoint" },
          );
          return true;
        } catch (err) {
          fail(
            err instanceof HttpStatusError && err.status === 401
              ? "the long-poll session ended"
              : "sending to the platform failed",
          );
          return false;
        }
      });
      chain = p;
      return p;
    },
    close() {
      fail("the connection closed");
    },
    onClose(fn) {
      if (closed) {
        fn();
        return () => undefined;
      }
      closers.add(fn);
      return () => void closers.delete(fn);
    },
    fail,
  };
}
