// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Messages on an authenticated link connection: instructions, key rotation, revocation and cancel.
import { importVerifyKey, rotateBytes, verify, type LinkMessage, type SignedInstruction } from "@nbo/link-protocol";
import type { Connection } from "./transport.js";
import type { LinkReply } from "./dispatch.js";
import type { ClientCtx } from "./client-ctx.js";
import { sendReply } from "./client-reply.js";

// Handlers for an authenticated connection; shared by the WebSocket and long-poll sessions.
export function createLive(ctx: ClientCtx) {
  const { store, dispatcher, cs, inFlightByConn, log, setError, journal } = ctx;
  function runInstruction(conn: Connection, i: SignedInstruction): void {
    const id = i.envelope.id;
    // In flight until its reply is sent, so a cancel can find it. The first
    // instruction with an id keeps the entry: a replay of a live id (refused
    // by the dispatcher) cannot take the cancel away from the real one.
    let inFlight = inFlightByConn.get(conn);
    if (!inFlight) inFlightByConn.set(conn, (inFlight = new Map()));
    const ctl = new AbortController();
    if (!inFlight.has(id)) inFlight.set(id, ctl);
    void (async () => {
      let reply: LinkReply;
      try {
        reply = await dispatcher.dispatch(i);
      } catch {
        reply = {
          kind: "response",
          status: 500,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode('{"error":"link: internal error"}'),
        };
      }
      try {
        await sendReply(conn, id, reply, ctl.signal);
      } finally {
        if (inFlight.get(id) === ctl) inFlight.delete(id);
      }
    })().catch(() => log("sending a reply failed"));
  }

  // ---- messages shared by both transports ----

  async function rotateKey(conn: Connection, m: Extract<LinkMessage, { type: "rotate-key" }>): Promise<void> {
    const state = store.getLinkState();
    if (!state) return;
    // The key core already pins: the earlier ack was lost. Nothing changes,
    // so nothing is verified; core only acknowledges it again.
    if (m.newKeyId === state.platformKeyId && m.newPublicKey === state.platformKey) {
      log(`platform key ${m.newKeyId} is already in use; acknowledged again`);
      await conn.send({ type: "rotation-ack", linkVersion: 1, keyId: m.newKeyId });
      return;
    }
    let ok =
      m.newKeyId !== "" &&
      (await verify(
        state.platformKey,
        m.signature,
        rotateBytes({ coreId: state.coreId, newKeyId: m.newKeyId, newPublicKey: m.newPublicKey }),
      ));
    if (ok) {
      try {
        await importVerifyKey(m.newPublicKey);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      journal("rotate-key", 401, "platform key rotation refused: not signed by the pinned key", false);
      log("refused a platform key rotation not signed by the pinned key");
      return;
    }
    try {
      store.setPlatformKey(m.newKeyId, m.newPublicKey);
    } catch {
      journal("rotate-key", 500, "platform key rotation could not be saved", false);
      return;
    }
    journal("rotate-key", 200, `platform key rotated to ${m.newKeyId}`, true);
    log(`platform key rotated to ${m.newKeyId}`);
    await conn.send({ type: "rotation-ack", linkVersion: 1, keyId: m.newKeyId });
  }

  function onRevoked(conn: Connection): void {
    cs.revoked = true;
    journal("revoked", 403, "the platform revoked this core", false);
    log("the platform revoked this core; not reconnecting until the link is restarted");
    setError("the platform revoked this core");
    conn.close();
  }

  // handleLive: a message after the connection is authenticated.
  async function handleLive(conn: Connection, m: LinkMessage): Promise<void> {
    switch (m.type) {
      case "instruction":
        runInstruction(conn, m.instruction);
        return;
      case "rotate-key":
        await rotateKey(conn, m);
        return;
      case "revoked":
        onRevoked(conn);
        return;
      case "cancel":
        // Only stops sending this connection's answer; an unknown id is ignored.
        inFlightByConn.get(conn)?.get(m.id)?.abort();
        return;
      default:
        // challenge and welcome after the start, or core's own message types: ignored.
        return;
    }
  }

  return { handleLive, onRevoked };
}

export type Live = ReturnType<typeof createLive>;
