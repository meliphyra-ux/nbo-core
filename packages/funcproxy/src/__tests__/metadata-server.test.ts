// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { metadataServerIdentityToken, metadataServerConfig, createCloudRunURLs } from "../cloudrun.js";

describe("metadataServerIdentityToken", () => {
  it("fails fast via its own client timeout when the metadata server hangs", async () => {
    // Real regression (per the Go source's own comment on this test):
    // a hung metadata-server call without its own bounded timeout
    // serialized every other concurrent caller behind it via the old
    // Go mutex. This plan's own in-flight-promise-sharing (Task 4)
    // must not recreate an equivalent trap — confirm concurrently.
    const server = http.createServer((_req, _res) => {
      /* never respond */
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const origBase = metadataServerConfig.baseURL;
    const origTimeout = metadataServerConfig.timeoutMs;
    metadataServerConfig.baseURL = `http://127.0.0.1:${port}`;
    metadataServerConfig.timeoutMs = 200;
    try {
      const start = Date.now();
      await expect(metadataServerIdentityToken("https://example.com")).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      metadataServerConfig.baseURL = origBase;
      metadataServerConfig.timeoutMs = origTimeout;
      server.close();
    }
  });

  it("bounds the whole exchange, not just the header phase, when the metadata server's body stalls", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.flushHeaders();
      // never call res.end() — the body never completes, only the
      // headers arrive. clearTimeout() running as soon as fetch()
      // resolves on headers (rather than once the body is fully
      // read) would leave this phase completely unbounded.
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const origBase = metadataServerConfig.baseURL;
    const origTimeout = metadataServerConfig.timeoutMs;
    metadataServerConfig.baseURL = `http://127.0.0.1:${port}`;
    metadataServerConfig.timeoutMs = 200;
    try {
      const start = Date.now();
      await expect(metadataServerIdentityToken("https://example.com")).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      metadataServerConfig.baseURL = origBase;
      metadataServerConfig.timeoutMs = origTimeout;
      server.close();
    }
  }, 3000);

  it("does not let concurrent resolve() callers share one hung in-flight fetch forever", async () => {
    // The real regression this guards: CachedToken's own in-flight
    // sharing (Task 4) is exactly the mechanism that could recreate
    // the old Go mutex's own trap — if the shared fetch never settles,
    // every concurrent caller waiting on it hangs too, permanently.
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.flushHeaders();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const origBase = metadataServerConfig.baseURL;
    const origTimeout = metadataServerConfig.timeoutMs;
    metadataServerConfig.baseURL = `http://127.0.0.1:${port}`;
    metadataServerConfig.timeoutMs = 200;
    try {
      const resolve = createCloudRunURLs({ ssr: `http://127.0.0.1:${port}` }, metadataServerIdentityToken);
      const handler = resolve("ssr");
      const start = Date.now();
      const [r1, r2] = await Promise.all([
        handler(new Request("http://example.com/a")),
        handler(new Request("http://example.com/b")),
      ]);
      expect(Date.now() - start).toBeLessThan(3000);
      expect(r1.status).toBeGreaterThanOrEqual(500);
      expect(r2.status).toBeGreaterThanOrEqual(500);
    } finally {
      metadataServerConfig.baseURL = origBase;
      metadataServerConfig.timeoutMs = origTimeout;
      server.close();
    }
  }, 5000);
});
