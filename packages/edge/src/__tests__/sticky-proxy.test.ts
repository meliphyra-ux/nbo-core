// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRegistry } from "../registry.js";
import { createProxyHandler } from "../proxy.js";
import { pickSticky, VISITOR_COOKIE } from "../sticky.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function backend(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
  });
}

interface Seen {
  name: string;
  cookie: string | undefined;
  body: string;
}

async function twoBackends(seen: Seen[], respond?: (name: string, res: ServerResponse) => void) {
  const make = (name: string) =>
    backend((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ name, cookie: req.headers.cookie, body });
        if (respond) return respond(name, res);
        res.end(name);
      });
    });
  const [a, b] = await Promise.all([make("k8s"), make("cloudrun")]);
  const registry = createRegistry();
  registry.set("app.test", [
    { id: "env_k8s", url: a, weight: 50, insecureSkipVerify: false },
    { id: "env_cr", url: b, weight: 50, insecureSkipVerify: false },
  ]);
  return { registry, handler: createProxyHandler(registry) };
}

function cookieValue(setCookie: string[]): string | undefined {
  for (const c of setCookie) {
    const m = c.match(new RegExp(`^${VISITOR_COOKIE}=([0-9a-f]{32});`));
    if (m) return m[1];
  }
  return undefined;
}

describe("edge keeps a visitor on one cloud", () => {
  it("a first visit gets a visitor cookie and is served by the backend that cookie maps to", async () => {
    const seen: Seen[] = [];
    const { registry, handler } = await twoBackends(seen);

    const res = await handler(new Request("http://edge/", { headers: { host: "app.test", "sec-fetch-dest": "document" } }));

    const id = cookieValue(res.headers.getSetCookie());
    expect(id).toBeDefined();
    const expected = pickSticky(registry.get("app.test")!, id!);
    expect(res.headers.get("x-nbo-edge-backend")).toBe(expected.url);
  });

  it("a returning visitor always reaches the same backend, gets no new cookie, and the app never sees the edge cookie", async () => {
    const seen: Seen[] = [];
    const { handler } = await twoBackends(seen);
    const first = await handler(new Request("http://edge/", { headers: { host: "app.test", "sec-fetch-dest": "document" } }));
    const id = cookieValue(first.headers.getSetCookie())!;
    const firstBackend = first.headers.get("x-nbo-edge-backend");

    for (let i = 0; i < 30; i++) {
      const res = await handler(new Request("http://edge/page", { headers: { host: "app.test", cookie: `theme=dark; ${VISITOR_COOKIE}=${id}` } }));
      expect(res.headers.get("x-nbo-edge-backend")).toBe(firstBackend);
      expect(cookieValue(res.headers.getSetCookie())).toBeUndefined();
      await res.arrayBuffer();
    }
    for (const s of seen.slice(1)) expect(s.cookie).toBe("theme=dark");
  });

  it("forwards a POST body when the edge cookie is stripped", async () => {
    const seen: Seen[] = [];
    const { handler } = await twoBackends(seen);
    const id = "0123456789abcdef0123456789abcdef";
    const res = await handler(new Request("http://edge/api", { method: "POST", body: "hello", headers: { host: "app.test", cookie: `${VISITOR_COOKIE}=${id}` } }));
    await res.arrayBuffer();
    expect(seen[0]?.body).toBe("hello");
    expect(seen[0]?.cookie).toBeUndefined();
  });

  it("keeps the app's own Set-Cookie next to the edge's", async () => {
    const seen: Seen[] = [];
    const { handler } = await twoBackends(seen, (_name, res) => {
      res.setHeader("set-cookie", ["session=abc; Path=/"]);
      res.end("ok");
    });
    const res = await handler(new Request("http://edge/", { headers: { host: "app.test", "sec-fetch-dest": "document" } }));
    const cookies = res.headers.getSetCookie();
    expect(cookies).toContain("session=abc; Path=/");
    expect(cookieValue(cookies)).toBeDefined();
  });

  it("relays a 304 from the app", async () => {
    const seen: Seen[] = [];
    const { handler } = await twoBackends(seen, (_name, res) => {
      res.statusCode = 304;
      res.end();
    });
    const res = await handler(new Request("http://edge/", { headers: { host: "app.test", "if-none-match": '"x"' } }));
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
  });

  it("marks the cookie Secure when the visitor came over https", async () => {
    const seen: Seen[] = [];
    const { handler } = await twoBackends(seen);
    const res = await handler(new Request("http://edge/", { headers: { host: "app.test", "sec-fetch-dest": "document", "x-forwarded-proto": "https" } }));
    expect(res.headers.getSetCookie().find((c) => c.startsWith(`${VISITOR_COOKIE}=`))).toContain("Secure");
  });

  it("sets the visitor cookie only on document navigations", async () => {
    const seen: Seen[] = [];
    const { handler } = await twoBackends(seen);
    const asset = await handler(new Request("http://edge/app.js", { headers: { host: "app.test", "sec-fetch-dest": "script", accept: "*/*" } }));
    expect(asset.status).toBe(200);
    expect(asset.headers.getSetCookie()).toEqual([]);
    const fetched = await handler(new Request("http://edge/page", { headers: { host: "app.test", "sec-fetch-dest": "empty", accept: "text/html" } }));
    expect(fetched.headers.getSetCookie()).toEqual([]);
    const noFetchMeta = await handler(new Request("http://edge/logo.png", { headers: { host: "app.test", accept: "image/*" } }));
    expect(noFetchMeta.headers.getSetCookie()).toEqual([]);
    const legacyNav = await handler(new Request("http://edge/", { headers: { host: "app.test", accept: "text/html,application/xhtml+xml,*/*;q=0.8" } }));
    expect(cookieValue(legacyNav.headers.getSetCookie())).toBeDefined();
  });

  it.each([
    ["nothing", {}, "http"],
    ["x-forwarded-proto: https", { "x-forwarded-proto": "https" }, "https"],
    ["Forwarded: proto=https", { forwarded: 'for=1.2.3.4;proto="https";host=app.test' }, "https"],
    ["Forwarded: proto=http", { forwarded: "proto=http" }, "http"],
  ])("tells the backend the visitor's scheme (%s)", async (_name, extra, want) => {
    let got: string | undefined;
    const url = await backend((req, res) => {
      got = req.headers["x-forwarded-proto"] as string | undefined;
      res.end();
    });
    const registry = createRegistry();
    registry.set("app.test", [{ url, weight: 1, insecureSkipVerify: false }]);
    await (await createProxyHandler(registry)(new Request("http://edge/", { headers: { host: "app.test", ...extra } }))).arrayBuffer();
    expect(got).toBe(want);
  });
});
