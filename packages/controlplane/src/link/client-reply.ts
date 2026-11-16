// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Sending a reply on a link connection: one message, or a stream in chunks that honours the platform's cancel.
import type { Connection } from "./transport.js";
import { LinkStreamError, type LinkReply } from "./dispatch.js";
import { b64u } from "@nbo/link-protocol";

// Raw bytes per stream-chunk: base64url inside JSON stays far under the
// 5 MiB message cap.
const MAX_CHUNK_BYTES = 1024 * 1024;

// sendReply: one reply on the connection its instruction came on. A reply
// for a closed connection is dropped (a stream's source is cancelled).
// signal: the platform's cancel. Only a stream honours it: aborted before
// the reply, the source is returned and nothing is sent; aborted mid-stream,
// the source is returned and the stream ends with error "cancelled". A plain
// response is sent whole. Cancelling never stops the work that made the reply.
export async function sendReply(conn: Connection, id: string, reply: LinkReply, signal?: AbortSignal): Promise<void> {
  if (!conn.open || (reply.kind === "stream" && signal?.aborted)) {
    if (reply.kind === "stream")
      await Promise.resolve(reply.chunks[Symbol.asyncIterator]().return?.()).catch(() => undefined);
    return;
  }
  if (reply.kind === "response" && reply.body.length <= MAX_CHUNK_BYTES) {
    await conn.send({
      type: "response",
      linkVersion: 1,
      id,
      status: reply.status,
      headers: reply.headers,
      body: b64u.encode(reply.body),
    });
    return;
  }
  let chunks: AsyncIterable<Uint8Array>;
  if (reply.kind === "stream") chunks = reply.chunks;
  else {
    const body = reply.body;
    chunks = (async function* () {
      yield body;
    })();
  }
  const cancellable = reply.kind === "stream" ? signal : undefined;
  const it = chunks[Symbol.asyncIterator]();
  let ended = false;
  const stopSource = (): void => {
    if (!ended) void Promise.resolve(it.return?.()).catch(() => undefined);
  };
  // A closed connection stops the stream at once (a follower waiting for
  // new log lines included), so its source is cancelled, not left running.
  const unsubscribe = conn.onClose(stopSource);
  // A cancel returns the source at once (freeing its stream slot and idle
  // timer) and wakes a read still waiting on it. Each read gets its own
  // wake-up, dropped when the read settles, so a long stream does not pile
  // reactions onto one promise that never settles.
  let wakeRead: (() => void) | null = null;
  const onAbort = (): void => {
    stopSource();
    wakeRead?.();
  };
  cancellable?.addEventListener("abort", onAbort, { once: true });
  const finish = (): void => {
    ended = true;
    unsubscribe();
    cancellable?.removeEventListener("abort", onAbort);
  };
  if (!(await conn.send({ type: "stream-start", linkVersion: 1, id, status: reply.status, headers: reply.headers }))) {
    finish();
    await Promise.resolve(it.return?.()).catch(() => undefined);
    return;
  }
  let index = 0;
  let error: string | undefined;
  try {
    for (;;) {
      if (cancellable?.aborted) {
        error = "cancelled";
        break;
      }
      const r = cancellable
        ? await new Promise<IteratorResult<Uint8Array> | "cancelled">((resolve, reject) => {
            wakeRead = () => resolve("cancelled");
            it.next().then(resolve, reject);
          }).finally(() => (wakeRead = null))
        : await it.next();
      if (r === "cancelled") {
        error = "cancelled";
        break;
      }
      if (r.done) break;
      for (let off = 0; off < r.value.length; off += MAX_CHUNK_BYTES) {
        const piece = r.value.subarray(off, off + MAX_CHUNK_BYTES);
        if (
          !(await conn.send({ type: "stream-chunk", linkVersion: 1, id, index: index++, data: b64u.encode(piece) }))
        ) {
          finish();
          await Promise.resolve(it.return?.()).catch(() => undefined);
          return;
        }
      }
    }
  } catch (err) {
    error = err instanceof LinkStreamError ? err.message : "stream failed";
  }
  if (error === "cancelled") await Promise.resolve(it.return?.()).catch(() => undefined);
  finish();
  if (!conn.open) return;
  await conn.send(
    error === undefined
      ? { type: "stream-end", linkVersion: 1, id }
      : { type: "stream-end", linkVersion: 1, id, error },
  );
}
