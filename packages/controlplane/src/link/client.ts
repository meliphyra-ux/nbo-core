// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The link client keeps one outbound connection to the platform open in the
// background: a WebSocket, or HTTPS long-poll when WebSockets keep failing
// while the platform itself answers. It proves itself by signing the
// platform's challenge with core's identity key, runs each instruction
// through the dispatcher (which checks everything) and sends the reply back.
// Nothing core does for its sites waits on it: startLinkClient returns at
// once, never throws into its caller and does nothing while unlinked.

import type { LinkState } from "./link-store.js";
import { healthzOk, linkEndpoints } from "./transport.js";
import { createClientCtx, type LinkClient, type LinkClientDeps, type Outcome } from "./client-ctx.js";
import { createLive } from "./client-live.js";
import { createSessions } from "./client-sessions.js";

export { sendReply } from "./client-reply.js";
export type { LinkClient, LinkClientDeps, LinkClientStatus } from "./client-ctx.js";

const JOURNAL_KEEP_MS = 90 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
const WS_FAILURES_BEFORE_LONG_POLL = 3;
const LONG_POLL_FOR_MS = 15 * 60_000;

export function startLinkClient(deps: LinkClientDeps): LinkClient {
  const ctx = createClientCtx(deps);
  const { store, now, random, fetchFn, st, cs, stopCtl, log, setError, sleep, linked } = ctx;
  const { runWebSocket, runLongPoll } = createSessions(ctx, createLive(ctx));

  async function waitForRestart(): Promise<void> {
    while (!cs.stopped && (cs.revoked || !linked())) await sleep(60_000);
  }

  async function loop(): Promise<void> {
    while (!cs.stopped) {
      let state: LinkState | null;
      try {
        state = store.getLinkState();
      } catch {
        state = null;
      }
      if (!state || cs.revoked) {
        st.connection = "off";
        st.transport = null;
        await waitForRestart();
        continue;
      }
      st.connection = "connecting";
      st.transport = null;
      const useLongPoll = now().getTime() < cs.longPollUntil;
      let outcome: Outcome;
      let endpoints: ReturnType<typeof linkEndpoints> | null = null;
      try {
        endpoints = linkEndpoints(state.linkUrl, state.linkHost);
        outcome = useLongPoll
          ? await runLongPoll(state, endpoints.base, endpoints.scheme)
          : await runWebSocket(state, endpoints.websocket, endpoints.scheme);
      } catch (err) {
        outcome = { connected: false, error: err instanceof Error ? err.message.slice(0, 200) : "connecting failed" };
      }
      cs.current = null;
      if (cs.stopped) break;
      if (outcome.error !== null && !cs.revoked) setError(outcome.error);
      if (outcome.connected && !cs.revoked) log(`disconnected${outcome.error ? `: ${outcome.error}` : ""}`);
      if (cs.revoked) continue;
      st.connection = "connecting";
      st.transport = null;
      if (cs.skipDelay) {
        cs.skipDelay = false;
        continue;
      }
      if (!useLongPoll && !outcome.connected) {
        cs.wsFailures++;
        if (
          cs.wsFailures >= WS_FAILURES_BEFORE_LONG_POLL &&
          endpoints &&
          (await healthzOk(fetchFn, endpoints.healthz, stopCtl.signal))
        ) {
          cs.wsFailures = 0;
          cs.longPollUntil = now().getTime() + LONG_POLL_FOR_MS;
          log("WebSocket keeps failing while the platform answers; using long-poll for 15 minutes");
          continue;
        }
      }
      cs.attempt++;
      const delay = random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(cs.attempt, 30));
      await sleep(delay);
    }
    st.connection = "off";
    st.transport = null;
  }

  const stopNow = (): void => {
    if (cs.stopped) return;
    cs.stopped = true;
    clearTimeout(firstPrune);
    clearInterval(pruneTimer);
    stopCtl.abort();
    cs.current?.close();
    cs.wake();
  };
  if (deps.signal.aborted) cs.stopped = true;
  else deps.signal.addEventListener("abort", stopNow, { once: true });

  // The journal keeps 90 days. Pruning is one quick delete on its own
  // timer, so it never holds up the connection or anything else.
  const prune = (): void => {
    try {
      store.pruneJournal(new Date(now().getTime() - JOURNAL_KEEP_MS));
    } catch {
      log("pruning the journal failed");
    }
  };
  const firstPrune = cs.stopped ? undefined : setTimeout(prune, 0);
  firstPrune?.unref?.();
  const pruneTimer = cs.stopped ? undefined : setInterval(prune, deps.pruneEveryMs ?? PRUNE_EVERY_MS);
  pruneTimer?.unref?.();

  const running = cs.stopped
    ? Promise.resolve()
    : loop().catch((err: unknown) => {
        st.connection = "off";
        st.transport = null;
        setError(err instanceof Error ? err.message.slice(0, 200) : "the link client stopped");
        log("the link client stopped after an internal error");
      });

  return {
    status: () => ({ ...st }),
    restart() {
      if (cs.stopped) return;
      cs.revoked = false;
      cs.attempt = 0;
      cs.wsFailures = 0;
      cs.longPollUntil = 0;
      if (cs.current) {
        cs.skipDelay = true;
        cs.current.close();
      }
      cs.wake();
    },
    disconnect() {
      if (cs.stopped) return;
      cs.attempt = 0;
      cs.wsFailures = 0;
      cs.longPollUntil = 0;
      cs.current?.close();
      cs.wake();
    },
    async stop() {
      stopNow();
      deps.signal.removeEventListener("abort", stopNow);
      await running;
    },
  };
}
