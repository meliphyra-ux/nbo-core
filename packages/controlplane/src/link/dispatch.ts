// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import {
  MAX_MESSAGE_BYTES,
  importEncryptionPrivateKey,
  isSealedBox,
  LinkProtocolError,
  requestPath,
  sealedFormatProblem,
  openSealed,
  type SignedInstruction,
} from "@nbo/link-protocol";
import type { Store } from "../store/store.js";
import type { Mux } from "../http/handlers.js";
import { markLinkRequest } from "../http/api-tokens.js";
import { verifyInstruction } from "./verify.js";
import { linkForbiddenField, sealedFields } from "./tiers.js";
import { filterJson, filterStream, knownSecrets, type SecretSources } from "./filter.js";

// The dispatcher runs an instruction from the platform through the same
// route handlers the HTTP API uses. The platform may be compromised, so core
// checks everything itself: the verifier (signature, replay, tier, member
// signature), then the route the path really reaches, the body fields the
// link may send, and the sealed fields, which it opens before the handler
// runs. Every reply passes the outbound filter (filter.ts).

export type LinkReply =
  | { kind: "response"; status: number; headers: Record<string, string>; body: Uint8Array }
  | { kind: "stream"; status: number; headers: Record<string, string>; chunks: AsyncIterable<Uint8Array> };

export interface Dispatcher {
  dispatch(i: SignedInstruction): Promise<LinkReply>;
}

const MAX_JSON_BYTES = 256 * 1024;
const CHUNK_BYTES = 64 * 1024;
// The Host of every request the link runs: not a name anything resolves.
const LINK_HOST = "link.invalid";
// Response headers that cross the link; everything else stays in core.
const PASSED_HEADERS = ["content-type", "content-disposition", "location"];

const signers = new WeakMap<Request, string>();

// linkSignerOf: who signed the instruction a request came from ("platform",
// "<memberId>/<keyId>" or "reset-code"); undefined for any other request.
export function linkSignerOf(request: Request): string | undefined {
  return signers.get(request);
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

const isPlainRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const isStringMap = (v: unknown): v is Record<string, string> =>
  isPlainRecord(v) && Object.values(v).every((x) => typeof x === "string");
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// wellFormed: the fields the dispatcher reads have the types it expects.
// The verifier checks signatures and numbers; this keeps a malformed
// message from reaching code that would throw on it.
function wellFormed(i: unknown): i is SignedInstruction {
  if (!isPlainRecord(i) || !isPlainRecord(i.envelope)) return false;
  const e = i.envelope;
  return (
    typeof e.method === "string" &&
    typeof e.routePattern === "string" &&
    e.routePattern.startsWith("/") &&
    typeof e.id === "string" &&
    typeof e.nonce === "string" &&
    isStringMap(e.params) &&
    isStringMap(e.query) &&
    typeof i.platformSignature === "string"
  );
}

const encoder = new TextEncoder();

function jsonReply(status: number, value: unknown): LinkReply {
  // Refusals carry core's own text and the platform's own route names; the
  // filter still runs so a withheld key can never ride along.
  return {
    kind: "response",
    status,
    headers: { "content-type": "application/json" },
    body: encoder.encode(JSON.stringify(filterJson(value, []))),
  };
}
const refusalReply = (status: number, reason: string): LinkReply => jsonReply(status, { error: `link: ${reason}` });

// pathFor: the request path from the route pattern and the params, each
// param percent-encoded so it fills exactly one segment (link-protocol's
// requestPath, which the signer also binds sealed boxes to).
function pathFor(pattern: string, params: Record<string, string>): string {
  try {
    return requestPath(pattern, params);
  } catch (err) {
    if (err instanceof LinkProtocolError) throw new Refusal(400, err.message);
    throw err;
  }
}

function sameParams(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => own(b, k) && a[k] === b[k]);
}

// sealedPaths: the dotted path of every object in body that has a "$sealed" key.
function sealedPaths(body: unknown, prefix = ""): string[] {
  if (typeof body !== "object" || body === null) return [];
  if (!Array.isArray(body) && own(body, "$sealed")) return [prefix === "" ? "(body)" : prefix];
  const out: string[] = [];
  const entries = Array.isArray(body)
    ? body.map((v, n) => [String(n), v] as const)
    : Object.keys(body).map((k) => [k, (body as Record<string, unknown>)[k]] as const);
  for (const [k, v] of entries) out.push(...sealedPaths(v, prefix === "" ? k : `${prefix}.${k}`));
  return out;
}

function getPath(body: unknown, path: string): unknown {
  let cur: unknown = body;
  for (const seg of path.split(".")) {
    if (!isPlainRecord(cur) || !own(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setPath(body: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let cur = body;
  for (const seg of segs.slice(0, -1)) cur = cur[seg] as Record<string, unknown>;
  Object.defineProperty(cur, segs[segs.length - 1]!, { value, enumerable: true, writable: true, configurable: true });
}

function stringLeaves(v: unknown, out: string[]): void {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringLeaves(x, out));
  else if (typeof v === "object" && v !== null) Object.values(v).forEach((x) => stringLeaves(x, out));
}

// openBody: the body the handler gets, with every declared sealed field
// opened; opened lists the plaintexts (the reply filter redacts them too).
async function openBody(
  store: Store,
  routeKey: string,
  path: string,
  body: unknown,
  opened: string[],
): Promise<unknown> {
  const declared = own(sealedFields, routeKey) ? sealedFields[routeKey]! : [];
  const declaredPaths = new Set(declared.map((f) => f.path));
  for (const p of sealedPaths(body)) {
    if (!declaredPaths.has(p)) throw new Refusal(400, `${p} is sealed where this route takes no sealed value`);
  }
  const toOpen = declared.filter((f) => {
    const v = getPath(body, f.path);
    if (v === undefined || v === null) return false;
    const problem = sealedFormatProblem(v);
    if (problem !== null) throw new Refusal(400, `${f.path} is in ${problem}; seal it again`);
    if (!isSealedBox(v)) throw new Refusal(400, `${f.path} must be sealed to this core's key`);
    return true;
  });
  if (toOpen.length === 0) return body;
  const keys = store.openLinkKeys();
  const state = store.getLinkState();
  if (!keys || !state) throw new Refusal(403, "this core is not linked");
  const privateKey = await importEncryptionPrivateKey(keys.encryptionPkcs8);
  const out = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  for (const f of toOpen) {
    let text: string;
    try {
      text = await openSealed(
        privateKey,
        state.encryptionPublic,
        getPath(body, f.path) as Parameters<typeof openSealed>[2],
        // Where the box is used comes from where it was found, never from the box.
        { coreId: state.coreId, route: routeKey, path, field: f.path },
      );
    } catch {
      throw new Refusal(400, `${f.path} does not open with this core's key`);
    }
    opened.push(text);
    let value: unknown = text;
    if (f.json) {
      try {
        value = JSON.parse(text);
      } catch {
        throw new Refusal(400, `${f.path} is not JSON`);
      }
      stringLeaves(value, opened);
    }
    setPath(out, f.path, value);
  }
  return out;
}

async function* rechunk(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  for await (const c of chunks) {
    for (let at = 0; at < c.length; at += CHUNK_BYTES) yield c.subarray(at, Math.min(c.length, at + CHUNK_BYTES));
  }
}

async function* readerChunks(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterable<Uint8Array> {
  let done = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        return;
      }
      yield r.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
  }
}

async function* bytesOf(b: Uint8Array): AsyncIterable<Uint8Array> {
  yield b;
}

// LinkStreamError ends a stream early; message is what the stream-end
// message carries ("idle").
export class LinkStreamError extends Error {}

// guardStream: a stream that holds one of the open-stream slots until it
// ends, fails, is returned, or sends nothing for idleMs (then its next read
// fails with "idle" and cancel stops the source). The idle timer runs
// whether or not anyone reads, so an abandoned stream frees its slot too.
function guardStream(
  source: AsyncIterable<Uint8Array>,
  opts: { idleMs: number; release: () => void; cancel: () => void },
): AsyncIterable<Uint8Array> {
  const it = source[Symbol.asyncIterator]();
  let closed = false;
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // rejectRead: the read in progress, failed with "idle" when the timer
  // fires. Each read has its own, dropped when it settles, so a long stream
  // does not pile reactions onto one promise that never settles.
  let rejectRead: ((e: Error) => void) | null = null;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    opts.release();
    opts.cancel();
  };
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      rejectRead?.(new LinkStreamError("idle"));
      close();
    }, opts.idleMs);
    timer.unref?.();
  };
  arm();
  const iterator: AsyncIterator<Uint8Array> = {
    async next() {
      if (idle) throw new LinkStreamError("idle");
      if (closed) return { done: true, value: undefined };
      try {
        const r = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
          rejectRead = reject;
          it.next().then(resolve, reject);
        }).finally(() => (rejectRead = null));
        if (r.done) close();
        else arm();
        return r;
      } catch (err) {
        close();
        throw err;
      }
    },
    async return() {
      close();
      return { done: true, value: undefined };
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

interface StreamSlots {
  open(): boolean;
  release(): void;
  idleMs: number;
}

// toReply: a JSON answer is read whole (up to the link's 5 MiB message
// cap; more is a 502) and passed through filterJson, then sent as one
// response under 256 KiB or as a stream of its filtered bytes. Anything else
// (logs, files) is a stream through the stream filter. Streams are at most
// 64 KiB a chunk and hold an open-stream slot (429 when none is free).
async function toReply(res: Response, secrets: string[], slots: StreamSlots): Promise<LinkReply> {
  const headers: Record<string, string> = {};
  for (const name of PASSED_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) headers[name] = filterJson(v, secrets) as string;
  }
  if (!res.body) return { kind: "response", status: res.status, headers, body: new Uint8Array() };
  const reader = res.body.getReader();
  const cancel = (): void => void reader.cancel().catch(() => undefined);
  let source: AsyncIterable<Uint8Array>;
  if (/^application\/json\s*(;|$)/i.test(res.headers.get("content-type") ?? "")) {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      parts.push(r.value);
      total += r.value.length;
      if (total > MAX_MESSAGE_BYTES) {
        cancel();
        throw new Refusal(502, "answer too large");
      }
    }
    const text = Buffer.concat(parts).toString("utf8");
    let out: string;
    try {
      out = JSON.stringify(filterJson(JSON.parse(text), secrets));
    } catch {
      out = filterJson(text, secrets) as string;
    }
    const body = encoder.encode(out);
    if (body.length < MAX_JSON_BYTES) return { kind: "response", status: res.status, headers, body };
    source = bytesOf(body);
  } else {
    source = filterStream(readerChunks(reader), secrets);
  }
  if (!slots.open()) {
    cancel();
    throw new Refusal(429, "too many open streams");
  }
  return {
    kind: "stream",
    status: res.status,
    headers,
    chunks: guardStream(rechunk(source), { idleMs: slots.idleMs, release: slots.release, cancel }),
  };
}

// supplied and github (required, so a caller cannot forget one): secrets
// held in memory that replies must not carry.
// maxStreams (32) caps streams open at once; a stream that sends nothing for
// streamIdleMs (10 minutes) is ended with "idle".
export function createDispatcher(
  deps: {
    store: Store;
    mux: Mux;
    now?: () => Date;
    maxConcurrent?: number;
    maxStreams?: number;
    streamIdleMs?: number;
  } & Required<SecretSources>,
): Dispatcher {
  const { store, mux } = deps;
  const now = deps.now ?? (() => new Date());
  const maxConcurrent = deps.maxConcurrent ?? 16;
  const maxStreams = deps.maxStreams ?? 32;
  let running = 0;
  let streams = 0;
  const slots: StreamSlots = {
    idleMs: deps.streamIdleMs ?? 10 * 60_000,
    open: () => (streams < maxStreams ? (streams++, true) : false),
    release: () => void streams--,
  };
  const sources: SecretSources = { supplied: deps.supplied, github: deps.github };

  // A journal write never turns a reply into a crash.
  const safely = (f: () => void): void => {
    try {
      f();
    } catch (err) {
      console.error(`control-plane: link journal write failed: ${err instanceof Error ? err.name : "error"}`);
    }
  };

  // journalRefused: a refused row. tier -1 and signedBy "" when the
  // verifier never accepted the instruction.
  const journalRefused = (i: unknown, at: Date, status: number, reason: string, tier = -1, signedBy = ""): void => {
    const e = isPlainRecord(i) && isPlainRecord(i.envelope) ? i.envelope : {};
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    safely(() =>
      store.appendJournal({
        id: typeof e.id === "string" && e.id !== "" ? e.id : null,
        at: at.toISOString(),
        seq: Number.isSafeInteger(e.seq) ? (e.seq as number) : -1,
        nonce: str(e.nonce),
        tier,
        method: str(e.method),
        route: str(e.routePattern),
        signedBy,
        status,
        reason,
        accepted: false,
      }),
    );
  };

  // run: verify, journal the instruction accepted (before anything runs, so
  // the same instruction sent twice at once runs once), check, then run the
  // handler. An accepted row gets the outcome (setJournalOutcome): status 0
  // and reason "running" until the handler has answered.
  async function run(i: SignedInstruction, at: Date, state: { accepted: boolean }): Promise<LinkReply> {
    const e = i.envelope;
    const verdict = await verifyInstruction(i, { store, now: at });
    if (!verdict.ok) {
      journalRefused(i, at, verdict.status, verdict.reason);
      return refusalReply(verdict.status, verdict.reason);
    }
    try {
      store.appendJournal({
        id: e.id,
        at: at.toISOString(),
        seq: e.seq,
        nonce: e.nonce,
        tier: verdict.tier,
        method: e.method,
        route: e.routePattern,
        signedBy: verdict.signedBy,
        status: 0,
        reason: "running",
        accepted: true,
      });
    } catch (err) {
      // The partial unique index on accepted nonces: another dispatch of
      // the same instruction got there first.
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        const reason = "instruction was already received";
        journalRefused(i, at, 409, reason, verdict.tier, verdict.signedBy);
        return refusalReply(409, reason);
      }
      throw err;
    }
    state.accepted = true;

    const routeKey = `${e.method} ${e.routePattern}`;
    const opened: string[] = [];
    let res: Response;
    try {
      const query = new URLSearchParams(e.query).toString();
      const path = pathFor(e.routePattern, e.params);
      const url = `http://${LINK_HOST}${path}${query === "" ? "" : `?${query}`}`;
      // The route the path really reaches must be the one that was signed
      // and tiered, with exactly the signed params.
      const match = mux.match(new Request(url, { method: e.method }));
      if (
        !match ||
        match.method !== e.method ||
        match.pattern !== e.routePattern ||
        !sameParams(match.params, e.params)
      ) {
        throw new Refusal(403, `route is not allowed over the link: ${routeKey}`);
      }
      const hasBody = e.body !== null && e.body !== undefined;
      if (hasBody && (e.method === "GET" || (e.method as string) === "HEAD"))
        throw new Refusal(400, `a ${e.method} instruction takes no body`);
      const forbidden = linkForbiddenField(routeKey, e.body);
      if (forbidden !== null) throw new Refusal(400, `${forbidden} can't be sent over the link`);
      const body = hasBody ? await openBody(store, routeKey, path, e.body, opened) : undefined;

      const request = new Request(url, {
        method: e.method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      markLinkRequest(request);
      signers.set(request, verdict.signedBy);
      // The link is its own gate: guardRequest is not called.
      try {
        res = await match.handler(request, match.params);
      } catch {
        throw new Refusal(500, "internal error");
      }
      const reply = await toReply(res, [...knownSecrets(store, sources), ...opened], slots);
      safely(() => store.setJournalOutcome(e.nonce, res.status, ""));
      return reply;
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      safely(() => store.setJournalOutcome(e.nonce, err.status, err.reason));
      return refusalReply(err.status, err.reason);
    }
  }

  return {
    async dispatch(i: SignedInstruction): Promise<LinkReply> {
      const at = now();
      // A stream keeps flowing after dispatch returns; only the work up to
      // the reply counts toward the limit.
      if (running >= maxConcurrent) {
        journalRefused(i, at, 429, "core is busy");
        return refusalReply(429, "core is busy");
      }
      running++;
      const state = { accepted: false };
      try {
        if (!wellFormed(i)) {
          journalRefused(i, at, 400, "instruction is malformed");
          return refusalReply(400, "instruction is malformed");
        }
        return await run(i, at, state);
      } catch (err) {
        // Never the exception's text: it may hold body data.
        console.error(`control-plane: link instruction failed: ${err instanceof Error ? err.name : "error"}`);
        if (state.accepted && isPlainRecord(i) && isPlainRecord(i.envelope) && typeof i.envelope.nonce === "string") {
          const nonce = i.envelope.nonce;
          safely(() => store.setJournalOutcome(nonce, 500, "internal error"));
        } else {
          journalRefused(i, at, 500, "internal error");
        }
        return refusalReply(500, "internal error");
      } finally {
        running--;
      }
    },
  };
}
