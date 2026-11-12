// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createStaticURLs } from "../static-urls.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function startBackend(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("createStaticURLs", () => {
  it("rewrites the outgoing request's Host header to match the target", async () => {
    let gotHost: string | undefined;
    const backendURL = await startBackend((req, res) => {
      gotHost = req.headers.host;
      res.end();
    });

    const resolve = createStaticURLs({ ssr: backendURL });
    const handler = resolve("ssr");
    await handler(new Request("http://example.com/x"));

    expect(gotHost).toBe(backendURL.replace("http://", ""));
  });

  it("proxies to the given URL, returning the backend's own response body", async () => {
    const backendURL = await startBackend((req, res) => {
      res.end("backend:" + req.url);
    });

    const resolve = createStaticURLs({ ssr: backendURL });
    const handler = resolve("ssr");
    const response = await handler(new Request("http://example.com/x"));

    expect(await response.text()).toBe("backend:/x");
  });

  it("returns a failure Response instead of rejecting when the backend is unreachable", async () => {
    const resolve = createStaticURLs({ ssr: "http://127.0.0.1:1" }); // nothing listens on port 1
    const handler = resolve("ssr");

    const response = await handler(new Request("http://example.com/x"));

    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});
