// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CLIENT_IP_HEADER, nodeToFetch } from "../node-to-fetch.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  }
});

// seenBy listens on every interface (so an IPv4 visitor arrives as
// ::ffff:127.0.0.1) and returns the client-ip header the handler got.
async function seenBy(opts: { clientIp?: boolean }, headers: Record<string, string> = {}): Promise<string | null> {
  let seen: string | null = null;
  server = createServer(
    nodeToFetch(async (req) => {
      seen = req.headers.get(CLIENT_IP_HEADER);
      return new Response("ok");
    }, opts),
  );
  await new Promise<void>((r) => server!.listen(0, () => r()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", reject);
    req.end();
  });
  return seen;
}

describe("nodeToFetch clientIp", () => {
  it("hands the handler the socket's address, without the IPv4-mapped prefix", async () => {
    expect(await seenBy({ clientIp: true })).toBe("127.0.0.1");
  });

  it("overwrites a value the visitor sent in that header", async () => {
    expect(await seenBy({ clientIp: true }, { [CLIENT_IP_HEADER]: "6.6.6.6" })).toBe("127.0.0.1");
  });

  it("leaves the headers alone when the option is off", async () => {
    expect(await seenBy({})).toBeNull();
    expect(await seenBy({}, { [CLIENT_IP_HEADER]: "6.6.6.6" })).toBe("6.6.6.6");
  });
});
