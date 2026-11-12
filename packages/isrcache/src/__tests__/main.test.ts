// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { resolveIsrcacheAddr, resolveIsrcacheMaxBytes, runIsrcache } from "../main.js";

describe("runIsrcache shutdown", () => {
  it("on SIGTERM closes the server and exits 0, without waiting for the grace period", async () => {
    const signals = new EventEmitter();
    const exits: number[] = [];
    const exited = new Promise<void>((resolve) => {
      signals.on("exit-called", resolve);
    });
    const proc = {
      once: (event: string, fn: () => void) => signals.once(event, fn),
      exit: (code: number) => {
        exits.push(code);
        signals.emit("exit-called");
      },
    };
    const server = runIsrcache({ NBO_ISRCACHE_ADDR: "127.0.0.1:0" }, proc);
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
    const { port } = server.address() as AddressInfo;
    // A kept-alive connection (as the app's pool holds one) must not hold the exit up.
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    const started = Date.now();
    signals.emit("SIGTERM");
    await exited;
    expect(exits).toEqual([0]);
    expect(server.listening).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("resolveIsrcacheAddr", () => {
  it("explicit NBO_ISRCACHE_ADDR override wins over PORT", () => {
    expect(resolveIsrcacheAddr({ NBO_ISRCACHE_ADDR: ":1111", PORT: "2222" })).toEqual({ port: 1111 });
  });

  it("falls back to Cloud Run's own PORT convention", () => {
    expect(resolveIsrcacheAddr({ PORT: "8080" })).toEqual({ port: 8080 });
  });

  it("defaults when neither is set", () => {
    expect(resolveIsrcacheAddr({})).toEqual({ port: 9445 });
  });

  it("NBO_ISRCACHE_ADDR with a host segment carries both through", () => {
    expect(resolveIsrcacheAddr({ NBO_ISRCACHE_ADDR: "127.0.0.1:1111" })).toEqual({ host: "127.0.0.1", port: 1111 });
  });
});

describe("resolveIsrcacheMaxBytes", () => {
  it("defaults to 96 MiB", () => {
    expect(resolveIsrcacheMaxBytes({})).toBe(100663296);
  });
  it("reads NBO_ISRCACHE_MAX_BYTES", () => {
    expect(resolveIsrcacheMaxBytes({ NBO_ISRCACHE_MAX_BYTES: "2048" })).toBe(2048);
  });
  it("falls back on bad values", () => {
    expect(resolveIsrcacheMaxBytes({ NBO_ISRCACHE_MAX_BYTES: "-1" })).toBe(100663296);
    expect(resolveIsrcacheMaxBytes({ NBO_ISRCACHE_MAX_BYTES: "x" })).toBe(100663296);
    expect(resolveIsrcacheMaxBytes({ NBO_ISRCACHE_MAX_BYTES: "1.5" })).toBe(100663296);
  });
});
