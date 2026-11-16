// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// What one link client shares across its parts: its status, state, logging, journal, sleeping and identity key.
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { importSigningPrivateKey } from "@nbo/link-protocol";
import type { Store } from "../store/store.js";
import type { Dispatcher } from "./dispatch.js";
import { defaultWebSocket, type Connection, type FetchFn } from "./transport.js";

export interface LinkClientStatus {
  connection: "off" | "connecting" | "connected";
  transport: "websocket" | "long-poll" | null;
  lastConnectedAt: string | null;
  lastError: string | null;
}

export interface LinkClient {
  status(): LinkClientStatus;
  // restart: forget a revocation and the backoff, drop the current
  // connection (its in-flight replies with it) and read the link state again.
  restart(): void;
  // disconnect: drop the current connection (its in-flight replies with
  // it) after an unlink; with no link state the client then stays off
  // until restart() follows a new enrollment.
  disconnect(): void;
  stop(): Promise<void>;
}

export interface LinkClientDeps {
  store: Store;
  dispatcher: Dispatcher;
  signal: AbortSignal;
  now?: () => Date;
  random?: () => number;
  wsFactory?: (url: string) => WebSocket;
  fetch?: FetchFn;
  // pruneEveryMs: how often journal rows older than 90 days are dropped
  // (once a day; first a moment after start).
  pruneEveryMs?: number;
}

/** What the loop, the live message handler and the sessions share; each client has its own. */
export interface ClientState {
  stopped: boolean;
  revoked: boolean;
  attempt: number;
  wsFailures: number;
  longPollUntil: number;
  skipDelay: boolean;
  current: Connection | null;
  wake: () => void;
}

export type Outcome = { connected: boolean; error: string | null };

export function createClientCtx(deps: LinkClientDeps) {
  const { store, dispatcher } = deps;
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const wsFactory = deps.wsFactory ?? defaultWebSocket;
  const fetchFn: FetchFn = deps.fetch ?? ((...a) => fetch(...a));

  const st: LinkClientStatus = { connection: "off", transport: null, lastConnectedAt: null, lastError: null };
  const cs: ClientState = {
    stopped: false,
    revoked: false,
    attempt: 0,
    wsFailures: 0,
    longPollUntil: 0,
    skipDelay: false,
    current: null,
    wake: () => undefined,
  };
  const stopCtl = new AbortController();
  // inFlightByConn: per connection, the instructions whose reply is not sent yet.
  const inFlightByConn = new WeakMap<Connection, Map<string, AbortController>>();

  const log = (line: string): void => console.error(`control-plane: link: ${line}`);
  const setError = (e: string | null): void => {
    st.lastError = e;
  };

  // sleep: until ms pass, restart() or stop() is called.
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (cs.stopped) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        cs.wake = () => undefined;
        resolve();
      }
      cs.wake = done;
    });

  const journal = (route: string, status: number, reason: string, accepted: boolean): void => {
    try {
      store.appendJournal({
        id: null,
        at: now().toISOString(),
        seq: -1,
        nonce: accepted ? `${route}:${randomUUID()}` : "",
        tier: -1,
        method: "LINK",
        route,
        signedBy: "platform",
        status,
        reason,
        accepted,
      });
    } catch {
      log("journal write failed");
    }
  };

  function linked(): boolean {
    try {
      return store.getLinkState() !== null;
    } catch {
      return false;
    }
  }

  async function identityKey(): Promise<CryptoKey> {
    const keys = store.openLinkKeys();
    if (!keys) throw new Error("this core is not linked");
    return importSigningPrivateKey(keys.identityPkcs8);
  }

  return {
    deps,
    store,
    dispatcher,
    now,
    random,
    wsFactory,
    fetchFn,
    st,
    cs,
    stopCtl,
    inFlightByConn,
    log,
    setError,
    sleep,
    journal,
    identityKey,
    linked,
  };
}

export type ClientCtx = ReturnType<typeof createClientCtx>;
