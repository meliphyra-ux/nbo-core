// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import { serveFetch, type FetchHandler } from "../serve-fetch.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function listen(handler: FetchHandler, host?: string): Promise<{ port: number; url: string }> {
  return new Promise((resolve) => {
    server = serveFetch(handler, host ? { port: 0, host } : { port: 0 }, (port) => resolve({ port, url: `http://127.0.0.1:${port}` }));
  });
}

describe("serveFetch", () => {
  it("delivers a GET request to the handler as a Request with the right method/url, and no body", async () => {
    let received: Request | undefined;
    const { url } = await listen(async (request) => {
      received = request;
      return new Response("ok");
    });

    await fetch(`${url}/hello`);

    expect(received?.method).toBe("GET");
    expect(new URL(received!.url).pathname).toBe("/hello");
    expect(received?.body).toBeNull();
  });

  it("delivers a POST request's body to the handler intact", async () => {
    const { url } = await listen(async (request) => new Response(await request.text()));

    const res = await fetch(url, { method: "POST", body: "hello world" });

    expect(await res.text()).toBe("hello world");
  });

  it("round-trips the handler's status, headers, and body to a real client", async () => {
    const { url } = await listen(async () => new Response("body-content", { status: 201, headers: { "x-custom": "value" } }));

    const res = await fetch(url);

    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("value");
    expect(await res.text()).toBe("body-content");
  });

  it("returns a 500 instead of crashing the process when the handler throws", async () => {
    const { url } = await listen(async () => {
      throw new Error("boom");
    });

    const res = await fetch(url);

    expect(res.status).toBe(500);
  });

  // Final-review finding I1: Object.fromEntries(response.headers)
  // collapses every repeated header to its last value, and Fetch's
  // own Headers iterator yields one entry per Set-Cookie value (never
  // comma-folded) — so a response setting more than one cookie
  // reached the client missing all but the last one. This sits in
  // front of every nbo serve response and every edge-proxied
  // response, so an app setting multiple cookies (an auth flow) would
  // silently lose all but one.
  it("delivers every Set-Cookie value, not just the last one", async () => {
    const { url } = await listen(async () => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response("ok", { headers });
    });

    const res = await fetch(url);

    expect(res.headers.getSetCookie().sort()).toEqual(["a=1", "b=2"]);
  });

  // Final-review finding C3: an upstream dying mid-stream (a backend
  // that resets the connection after sending part of its body — the
  // exact scenario @nbo/edge's own proxying and internal/loadtest's
  // own generator.go comment anticipate during a real cloud switch)
  // must not crash the whole serving process. Confirmed directly
  // before this fix: a response.body whose async iterator throws
  // *after* res.writeHead has already run (headers already
  // committed) was an unhandled rejection outside the handler's own
  // try/catch, killing the process — not just failing the one
  // request.
  it("does not crash the process when the response body errors after headers are already sent", async () => {
    const { url } = await listen(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first chunk"));
        },
        pull() {
          throw new Error("upstream connection reset mid-body");
        },
      });
      return new Response(stream, { status: 200 });
    });

    await expect(fetch(url, { keepalive: false }).then((res) => res.text())).rejects.toThrow();

    // The server object itself must still be listening — proof the
    // process (and this one server) survived the error, not just
    // that the first request's own promise rejected.
    expect(server!.listening).toBe(true);
  });

  it("binds loopback only when host is given, and all interfaces when it isn't", async () => {
    await listen(async () => new Response("ok"), "127.0.0.1");
    const loopbackAddr = server!.address();
    expect(typeof loopbackAddr === "object" ? loopbackAddr?.address : loopbackAddr).toBe("127.0.0.1");

    await listen(async () => new Response("ok"));
    const anyAddr = server!.address();
    expect(typeof anyAddr === "object" ? anyAddr?.address : anyAddr).not.toBe("127.0.0.1");
  });
});
