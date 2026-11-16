// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { createRouter } from "@nbo/router";
import type { ServeState, ImagesConfig } from "../serve.js";
import { handleImage } from "../image.js";
import { isBlockedAddress, type RemoteImageDeps } from "../remote-image.js";

// A fake origin on loopback stands in for public hosts: the resolver maps
// each test hostname to an address, the check runs on that address, and only
// then does the test's dial send the connection to the fake server.
const PUBLIC = "203.0.113.10";

let server: Server;
let port = 0;
const seenHosts: string[] = [];
let png: Buffer;

beforeAll(async () => {
  png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#3366cc" } })
    .png()
    .toBuffer();
  server = createServer((req, res) => {
    seenHosts.push(String(req.headers.host));
    const path = req.url ?? "/";
    const redirect = /^\/img\/hop(\d+)$/.exec(path);
    if (redirect) {
      const n = Number(redirect[1]);
      res.writeHead(302, { location: n > 1 ? `/img/hop${n - 1}` : "/img/ok.png" }).end();
      return;
    }
    switch (path) {
      case "/img/ok.png":
        res.writeHead(200, { "content-type": "image/png" }).end(png);
        return;
      case "/img/html.png":
        res.writeHead(200, { "content-type": "text/html" }).end(png);
        return;
      case "/img/to-metadata":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
        return;
      case "/img/to-other-host":
        res.writeHead(301, { location: `http://other.example:${port}/img/ok.png` }).end();
        return;
      case "/img/to-private-name":
        res.writeHead(307, { location: `http://private.cdn.test:${port}/img/ok.png` }).end();
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function deps(table: Record<string, string[]>): RemoteImageDeps {
  return {
    resolve: async (hostname) => {
      const addresses = table[hostname];
      if (!addresses) throw new Error(`no such host ${hostname}`);
      return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    dial: () => ({ address: "127.0.0.1", port }),
  };
}

function cfg(): ImagesConfig {
  return {
    widths: [20],
    qualities: [75],
    remotePatterns: [
      { protocol: "http", hostname: "^(cdn|private)\\.cdn\\.test$", pathname: "^/img/.*$" },
      { protocol: "http", hostname: "^169\\.254\\.169\\.254$" },
    ],
  };
}

function state(table: Record<string, string[]>): ServeState {
  return {
    nboDir: "",
    index: new Map(),
    router: createRouter({ version: 1 }, "never"),
    prerenders: [],
    images: cfg(),
    remoteImage: deps(table),
    regenInFlight: new Set(),
  };
}

const publicCdn = { "cdn.cdn.test": [PUBLIC], "private.cdn.test": ["10.1.2.3"], "other.example": [PUBLIC] };

async function get(s: ServeState, source: string) {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await handleImage(s, new Request(`http://x/_nbo/image?url=${encodeURIComponent(source)}&w=20&q=75`));
    return {
      status: res.status,
      body: Buffer.from(await res.arrayBuffer()),
      logged: errors.mock.calls.flat().join(" "),
    };
  } finally {
    errors.mockRestore();
  }
}

describe("remote image sources", () => {
  it("fetches an allowed source from a public address, keeping the hostname as Host", async () => {
    seenHosts.length = 0;
    const res = await get(state(publicCdn), `http://cdn.cdn.test:${port}/img/ok.png`);
    expect(res.status).toBe(200);
    expect((await sharp(res.body).metadata()).width).toBe(20);
    expect(seenHosts).toEqual([`cdn.cdn.test:${port}`]);
  });

  it("follows up to three allowed redirects", async () => {
    const res = await get(state(publicCdn), `http://cdn.cdn.test:${port}/img/hop3`);
    expect(res.status).toBe(200);
  });

  it("refuses a fourth redirect", async () => {
    const res = await get(state(publicCdn), `http://cdn.cdn.test:${port}/img/hop4`);
    expect(res.status).toBe(502);
    expect(res.logged).toMatch(/more than 3 redirects/);
  });

  it("refuses a redirect to the cloud metadata address, even when a pattern names it", async () => {
    const res = await get(state(publicCdn), `http://cdn.cdn.test:${port}/img/to-metadata`);
    expect(res.status).toBe(502);
    expect(res.logged).toMatch(/169\.254\.169\.254/);
  });

  it("refuses a redirect to a host outside remotePatterns", async () => {
    const res = await get(state(publicCdn), `http://cdn.cdn.test:${port}/img/to-other-host`);
    expect(res.status).toBe(502);
    expect(res.logged).toMatch(/matches no remote pattern/);
  });

  it("refuses a redirect to an allowed name that resolves to a private address", async () => {
    const res = await get(state(publicCdn), `http://cdn.cdn.test:${port}/img/to-private-name`);
    expect(res.status).toBe(502);
  });

  for (const address of [
    "10.0.0.5",
    "127.0.0.1",
    "::1",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "100.64.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "0.0.0.0",
  ]) {
    it(`refuses a host resolving to ${address}`, async () => {
      seenHosts.length = 0;
      const res = await get(state({ "cdn.cdn.test": [address] }), `http://cdn.cdn.test:${port}/img/ok.png`);
      expect(res.status).toBe(502);
      expect(seenHosts).toEqual([]);
    });
  }

  it("refuses when any one of a host's addresses is private", async () => {
    const res = await get(state({ "cdn.cdn.test": [PUBLIC, "192.168.1.1"] }), `http://cdn.cdn.test:${port}/img/ok.png`);
    expect(res.status).toBe(502);
  });

  it("refuses an answer that isn't image/*", async () => {
    const res = await get(state(publicCdn), `http://cdn.cdn.test:${port}/img/html.png`);
    expect(res.status).toBe(502);
    expect(res.logged).toMatch(/not image/);
  });

  it("keeps internal detail out of the answer", async () => {
    const res = await get(state(publicCdn), `http://cdn.cdn.test:${port}/img/to-metadata`);
    expect(res.body.toString()).toBe("serve: image source rejected or unreadable");
  });

  it("with real DNS, refuses localhost and a loopback literal", async () => {
    seenHosts.length = 0;
    const s = state({});
    s.remoteImage = undefined;
    s.images = { ...cfg(), remotePatterns: [{ protocol: "http", hostname: "^(localhost|127\\.0\\.0\\.1)$" }] };
    expect((await get(s, `http://localhost:${port}/img/ok.png`)).status).toBe(502);
    expect((await get(s, `http://127.0.0.1:${port}/img/ok.png`)).status).toBe(502);
    expect(seenHosts).toEqual([]);
  });

  it("still answers 400 for a source outside remotePatterns", async () => {
    const res = await get(state(publicCdn), `http://other.example:${port}/img/ok.png`);
    expect(res.status).toBe(400);
  });
});

describe("isBlockedAddress", () => {
  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fdff::1",
    "fe80::1%eth0",
    "ff02::1",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe",
    "::ffff:127.0.0.1",
    "::127.0.0.1",
    "64:ff9b::a00:1",
    "198.18.0.1",
    "198.19.255.255",
    "192.0.0.8",
    "64:ff9b:1::1",
    "64:ff9b:1:ffff::1",
    "2002:a00:1::1",
    "2002:7f00:1::",
    "2002:a9fe:a9fe:1:2:3:4:5",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "203.0.113.10",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "198.20.0.1",
    "192.0.1.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "2002:808:808::1",
  ])("allows %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});
