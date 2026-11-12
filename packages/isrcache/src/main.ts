// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { serveFetch } from "@nbo/nodehost";
import { createStore, DEFAULT_MAX_BYTES } from "./store.js";
import { createMux, maxBodyBytesFor } from "./mux.js";

function splitHostPort(addr: string): { host?: string; port: number } {
  const idx = addr.lastIndexOf(":");
  if (idx === -1) return { port: Number(addr) };
  const host = addr.slice(0, idx);
  return host ? { host, port: Number(addr.slice(idx + 1)) } : { port: Number(addr.slice(idx + 1)) };
}

// resolveIsrcacheAddr picks the listen address: NBO_ISRCACHE_ADDR is an
// explicit override; otherwise PORT (Cloud Run's own convention — the
// port a deployed container must listen on is only known at deploy
// time, the same reason @nbo/funcproxy's own host.mjs already respects
// it for functions); otherwise a fixed local-dev default that won't
// collide with other local services on 8080. A structured { host?,
// port } return, not Go's own raw address string, since serveFetch
// takes { port, host? } directly — port of addr() (main.go lines
// 96-104).
export function resolveIsrcacheAddr(env: Record<string, string | undefined>): { host?: string; port: number } {
  if (env.NBO_ISRCACHE_ADDR) return splitHostPort(env.NBO_ISRCACHE_ADDR);
  if (env.PORT) return { port: Number(env.PORT) };
  return { port: 9445 };
}

// resolveIsrcacheMaxBytes reads NBO_ISRCACHE_MAX_BYTES; a value that is
// not a positive integer falls back to the default (96 MiB).
export function resolveIsrcacheMaxBytes(env: Record<string, string | undefined>): number {
  const raw = env.NBO_ISRCACHE_MAX_BYTES;
  if (raw === undefined || !/^[0-9]+$/.test(raw.trim())) return DEFAULT_MAX_BYTES;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

// IsrcacheProcess is the part of process runIsrcache uses (a test passes a fake).
export interface IsrcacheProcess {
  once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exit(code: number): void;
}

// stopGraceMs bounds the wait for requests in flight once a stop signal came.
const stopGraceMs = 5_000;

// runIsrcache starts the cache service and keeps the process alive. On
// SIGTERM or SIGINT it stops taking connections, drops idle kept-alive ones,
// lets requests in flight finish (at most stopGraceMs) and exits 0: it runs
// as PID 1 in its container, where no default handler ends the process, so
// without this every rollout or removal waited the whole grace period.
// The cache is in memory only: there is nothing to save.
export function runIsrcache(env: Record<string, string | undefined>, proc: IsrcacheProcess = process): Server {
  const maxBytes = resolveIsrcacheMaxBytes(env);
  const store = createStore({ maxBytes });
  const mux = createMux(store, { maxBodyBytes: maxBodyBytesFor(maxBytes) });
  const addr = resolveIsrcacheAddr(env);
  const server = serveFetch(mux, addr, (p) => {
    console.log(`isrcache: listening on :${p}`);
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    console.log("isrcache: stopping");
    setTimeout(() => proc.exit(0), stopGraceMs).unref();
    server.close(() => proc.exit(0));
    server.closeIdleConnections();
  };
  proc.once("SIGTERM", stop);
  proc.once("SIGINT", stop);
  return server;
}

function main(): void {
  runIsrcache(process.env);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main();
}
