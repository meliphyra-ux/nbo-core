// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// One connection to the platform: over a WebSocket, or by long-poll when WebSockets keep failing.
import { authBytes, sign, type LinkMessage } from "@nbo/link-protocol";
import type WebSocket from "ws";
import type { LinkState } from "./link-store.js";
import {
  HttpStatusError,
  longPollConnection,
  sameLinkHost,
  parseMessages,
  postJson,
  wrapWebSocket,
} from "./transport.js";
import type { ClientCtx, Outcome } from "./client-ctx.js";
import type { Live } from "./client-live.js";

// The platform holds a poll up to 25 s; give it room before giving up.
const POLL_TIMEOUT_MS = 35_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

// The two transports (WebSocket, long poll) behind one handshake; each ends when the connection drops.
export function createSessions(ctx: ClientCtx, live: Live) {
  const { now, wsFactory, fetchFn, st, cs, stopCtl, log, setError, identityKey, linked } = ctx;
  const { handleLive, onRevoked } = live;
  // ---- WebSocket ----

  async function runWebSocket(state: LinkState, url: string, scheme: "https:" | "http:"): Promise<Outcome> {
    const key = await identityKey();
    return new Promise<Outcome>((resolve) => {
      let connected = false;
      // answered: this client sent a challenge-answer on this connection.
      let answered = false;
      let error: string | null = null;
      let chain: Promise<void> = Promise.resolve();
      let ws: WebSocket;
      const handshake = setTimeout(() => {
        error = "the platform did not finish the handshake in time";
        conn.close();
      }, HANDSHAKE_TIMEOUT_MS);
      handshake.unref?.();
      const fail = (why: string): void => {
        error = why;
        conn.close();
      };
      const handle = async (m: LinkMessage): Promise<void> => {
        if (connected) return handleLive(conn, m);
        if (m.type === "challenge") {
          if (!sameLinkHost(m.linkHost, state.linkHost, scheme))
            return fail("the platform named another link host in its challenge");
          const signature = await sign(
            key,
            authBytes({ coreId: state.coreId, challenge: m.challenge, linkHost: m.linkHost }),
          );
          answered = await conn.send({
            type: "challenge-answer",
            linkVersion: 1,
            coreId: state.coreId,
            challenge: m.challenge,
            signature,
          });
          return;
        }
        if (m.type === "welcome") {
          if (!answered) return fail("protocol error: the platform sent welcome before core answered a challenge");
          if (m.coreId !== state.coreId) return fail("the platform welcomed another core id");
          // Unlinked while the handshake ran: this connection is not used.
          if (!linked()) return fail("this core is not linked");
          clearTimeout(handshake);
          connected = true;
          cs.attempt = 0;
          cs.wsFailures = 0;
          st.connection = "connected";
          st.transport = "websocket";
          st.lastConnectedAt = now().toISOString();
          setError(null);
          log("connected (websocket)");
          return;
        }
        // revoked is honoured before the welcome: the WebSocket runs over TLS
        // to the pinned host (plain ws:// is allowed only for loopback, which
        // only tests use), and the worst a forged one does is stop the link
        // until restart(), which refusing to connect would do anyway.
        if (m.type === "revoked") return onRevoked(conn);
        // Anything else before the welcome (instructions, rotate-key) is ignored.
      };
      try {
        ws = wsFactory(url);
      } catch (err) {
        clearTimeout(handshake);
        resolve({
          connected: false,
          error: `WebSocket error: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`,
        });
        return;
      }
      const conn = wrapWebSocket(ws, {
        onOpen: () => undefined,
        onMessage: (m) => {
          chain = chain.then(() => handle(m)).catch(() => fail("a message from the platform could not be handled"));
        },
        onBadMessage: (why) => log(`dropped a message from the platform: ${why}`),
        onClose: (why) => {
          clearTimeout(handshake);
          if (cs.current === conn) cs.current = null;
          resolve({ connected, error: error ?? why });
        },
      });
      cs.current = conn;
      if (cs.stopped) conn.close();
    });
  }

  // ---- long-poll ----

  async function runLongPoll(state: LinkState, base: string, scheme: "https:" | "http:"): Promise<Outcome> {
    const key = await identityKey();
    // Closing the session (restart(), a 401, stop) aborts its pending poll at once.
    const sessionCtl = new AbortController();
    const signal = AbortSignal.any([stopCtl.signal, sessionCtl.signal]);
    const opts = (what: string) => ({ signal, timeoutMs: 30_000, what });
    const s = (await postJson(
      fetchFn,
      `${base}/v1/session`,
      { coreId: state.coreId },
      opts("the platform's session endpoint"),
    )) as { challenge?: unknown; linkHost?: unknown };
    if (typeof s?.challenge !== "string" || typeof s.linkHost !== "string")
      throw new Error("the platform's session answer is malformed");
    if (!sameLinkHost(s.linkHost, state.linkHost, scheme))
      return { connected: false, error: "the platform named another link host in its challenge" };
    const signature = await sign(
      key,
      authBytes({ coreId: state.coreId, challenge: s.challenge, linkHost: s.linkHost }),
    );
    const a = (await postJson(
      fetchFn,
      `${base}/v1/session/answer`,
      { coreId: state.coreId, challenge: s.challenge, signature },
      opts("the platform's session endpoint"),
    )) as {
      session?: unknown;
    };
    if (typeof a?.session !== "string" || a.session === "")
      throw new Error("the platform's session answer is malformed");
    // The session lasts until the platform answers 401 (its expiresAt is on
    // the platform's clock, so core does not compare it with its own).
    const session = a.session;
    if (!linked()) return { connected: false, error: "this core is not linked" };

    let closedWhy: string | null = null;
    const conn = longPollConnection(fetchFn, base, session, signal, (why) => {
      closedWhy = why;
      sessionCtl.abort();
    });
    cs.current = conn;
    cs.attempt = 0;
    st.connection = "connected";
    st.transport = "long-poll";
    st.lastConnectedAt = now().toISOString();
    setError(null);
    log("connected (long-poll)");
    let chain: Promise<void> = Promise.resolve();
    try {
      while (conn.open && !cs.stopped && !cs.revoked) {
        const t = now().getTime();
        if (t >= cs.longPollUntil) {
          conn.close();
          return { connected: true, error: null };
        }
        let answer: unknown;
        try {
          answer = await postJson(
            fetchFn,
            `${base}/v1/poll`,
            {},
            { signal, timeoutMs: POLL_TIMEOUT_MS, bearer: session, what: "the platform's poll endpoint" },
          );
        } catch (err) {
          conn.fail(
            err instanceof HttpStatusError && err.status === 401
              ? "the long-poll session ended"
              : err instanceof HttpStatusError
                ? err.message
                : "polling the platform failed",
          );
          break;
        }
        if (!conn.open) break;
        for (const m of parseMessages(answer, (why) => log(`dropped a message from the platform: ${why}`))) {
          chain = chain
            .then(() => handleLive(conn, m))
            .catch(() => log("a message from the platform could not be handled"));
        }
        await chain;
      }
    } finally {
      conn.close();
      if (cs.current === conn) cs.current = null;
    }
    return { connected: true, error: closedWhy };
  }

  // ---- the loop ----

  return { runWebSocket, runLongPoll };
}
