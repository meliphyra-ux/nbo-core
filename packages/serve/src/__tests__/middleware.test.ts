// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createStaticURLs, type FetchHandler, type Resolver } from "@nbo/funcproxy";
import { createMiddlewareInvoker, middlewareRequestBodyCap } from "../middleware.js";

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function stubResolver(handler: FetchHandler): Resolver {
  return (_name: string) => handler;
}

describe("createMiddlewareInvoker", () => {
  it("does not exhaust the original request's body for the later real dispatch", async () => {
    const resolve = stubResolver(async (request) => {
      await request.text(); // simulate a buffer-then-close resolver, same real bug class
      return new Response(null, { headers: { "X-Nbo-Next": "1" } });
    });
    const request = new Request("http://x/page", { method: "POST", body: "original body content" });
    await createMiddlewareInvoker(resolve, request)("middleware", "/page", "POST");

    const got = await request.text();
    expect(got).toBe("original body content");
  });

  it("next does not carry framing headers forward", async () => {
    const resolve = stubResolver(
      async () =>
        new Response(null, {
          headers: { "X-Nbo-Next": "1", "Content-Length": "0", "Transfer-Encoding": "chunked" },
        }),
    );
    const request = new Request("http://x/page");
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/page", "GET");
    expect(outcome.continue).toBe(true);
    for (const op of outcome.mergeHeaders ?? []) {
      expect(op.set?.["content-length"]).toBeUndefined();
      expect(op.append?.["content-length"]).toBeUndefined();
      expect(op.set?.["transfer-encoding"]).toBeUndefined();
      expect(op.append?.["transfer-encoding"]).toBeUndefined();
    }
  });

  it("merges every value of a multi-valued header", async () => {
    const resolve = stubResolver(async () => {
      const headers = new Headers();
      headers.set("X-Nbo-Next", "1");
      headers.append("Set-Cookie", "a=1");
      headers.append("Set-Cookie", "b=2");
      return new Response(null, { headers });
    });
    const request = new Request("http://x/page");
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/page", "GET");
    expect(outcome.continue).toBe(true);
    const cookies = (outcome.mergeHeaders ?? []).map((op) => op.append?.["set-cookie"]).filter((v) => v !== undefined);
    expect(cookies.sort()).toEqual(["a=1", "b=2"]);
  });

  it("a plain next continues without a rewrite", async () => {
    const resolve = stubResolver(async () => new Response(null, { headers: { "X-Nbo-Next": "1" } }));
    const request = new Request("http://x/page");
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/page", "GET");
    expect(outcome.continue).toBe(true);
    expect(outcome.rewritePath).toBeUndefined();
  });

  it("next continues regardless of status code", async () => {
    const resolve = stubResolver(async () => new Response(null, { status: 201, headers: { "X-Nbo-Next": "1" } }));
    const request = new Request("http://x/page");
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/page", "GET");
    expect(outcome.continue).toBe(true);
  });

  it("a rewrite continues with the new path", async () => {
    const resolve = stubResolver(async () => new Response(null, { headers: { "X-Nbo-Rewrite": "/new" } }));
    const request = new Request("http://x/old");
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/old", "GET");
    expect(outcome.continue).toBe(true);
    expect(outcome.rewritePath).toBe("/new");
  });

  it("a rewrite keeps the query string on the real request", async () => {
    const resolve = stubResolver(async () => new Response(null, { headers: { "X-Nbo-Rewrite": "/new?a=1" } }));
    const request = new Request("http://x/old");
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/old", "GET");
    expect(outcome.continue).toBe(true);
    expect(outcome.rewritePath).toBe("/new");
    expect(new URL(request.url).search).toBe("?a=1");
  });

  it("rejects an absolute-url rewrite", async () => {
    const resolve = stubResolver(async () => new Response(null, { headers: { "X-Nbo-Rewrite": "https://example.com/elsewhere" } }));
    const request = new Request("http://x/old");
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/old", "GET");
    expect(outcome.continue).toBe(false);
    expect(outcome.response?.middlewareStatus).toBe(502);
  });

  it("a request-header override replaces the real request's own value", async () => {
    const resolve = stubResolver(
      async () =>
        new Response(null, {
          headers: {
            "X-Nbo-Next": "1",
            "X-Nbo-Request-Headers": "x-mw-echo",
            "X-Nbo-Request-Header-X-Mw-Echo": "from-middleware",
          },
        }),
    );
    const request = new Request("http://x/page", { headers: { "X-Mw-Echo": "from-client" } });
    await createMiddlewareInvoker(resolve, request)("middleware", "/page", "GET");
    expect(request.headers.get("x-mw-echo")).toBe("from-middleware");
  });

  it("a request-header override removes whatever is not listed", async () => {
    const resolve = stubResolver(
      async () =>
        new Response(null, {
          headers: {
            "X-Nbo-Next": "1",
            "X-Nbo-Request-Headers": "x-mw-echo",
            "X-Nbo-Request-Header-X-Mw-Echo": "from-middleware",
          },
        }),
    );
    const request = new Request("http://x/page", { headers: { "X-Mw-Echo": "from-client", Authorization: "secret-token" } });
    await createMiddlewareInvoker(resolve, request)("middleware", "/page", "GET");
    expect(request.headers.get("x-mw-echo")).toBe("from-middleware");
    expect(request.headers.get("authorization")).toBeNull();
  });

  it("runs a function only once even with overlapping matchers", async () => {
    let calls = 0;
    const resolve = stubResolver(async () => {
      calls++;
      return new Response(null, { headers: { "X-Nbo-Next": "1" } });
    });
    const request = new Request("http://x/page");
    const invoke = createMiddlewareInvoker(resolve, request);
    const first = await invoke("middleware", "/page", "GET");
    const second = await invoke("middleware", "/page", "GET");
    expect(first.continue).toBe(true);
    expect(second.continue).toBe(true);
    expect(calls).toBe(1);
  });

  it("rejects an oversized request body", async () => {
    const resolve = stubResolver(async () => new Response(null, { headers: { "X-Nbo-Next": "1" } }));
    const oversized = "x".repeat(middlewareRequestBodyCap + 1);
    const request = new Request("http://x/page", { method: "POST", body: oversized, duplex: "half" } as RequestInit);
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/page", "POST");
    expect(outcome.continue).toBe(false);
    expect(outcome.response?.middlewareStatus).toBe(502);
  });

  it("any other response ends routing and strips reserved headers", async () => {
    const resolve = stubResolver(async () => new Response(null, { status: 302, headers: { Location: "/elsewhere" } }));
    const request = new Request("http://x/blocked");
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/blocked", "GET");
    expect(outcome.continue).toBe(false);
    expect(outcome.response?.middlewareStatus).toBe(302);
    expect(outcome.response?.middlewareHeaders?.["location"]?.[0]).toBe("/elsewhere");
    expect(outcome.response?.middlewareHeaders?.["x-nbo-next"]).toBeUndefined();
  });

  // Final-review finding C2: a middleware response that ends routing
  // (a deny, a JSON error, a custom page) must carry its own body
  // through to middlewareBody — the decision this outcome produces
  // never read response.body at all, so every such response arrived
  // at the real client with an empty body.
  it("any other response carries its own body through", async () => {
    const resolve = stubResolver(async () => new Response(JSON.stringify({ error: "denied" }), { status: 403 }));
    const request = new Request("http://x/blocked");
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/blocked", "GET");
    expect(outcome.continue).toBe(false);
    expect(outcome.response?.middlewareStatus).toBe(403);
    expect(outcome.response?.middlewareBody?.toString()).toBe('{"error":"denied"}');
  });

  // The body length changes once it's re-read and re-wrapped here —
  // a stale Content-Length copied from the middleware's own response
  // would describe bytes that no longer match what's actually sent.
  it("any other response does not carry a stale Content-Length forward", async () => {
    const resolve = stubResolver(async () => new Response("short", { status: 403, headers: { "content-length": "99999" } }));
    const request = new Request("http://x/blocked");
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/blocked", "GET");
    expect(outcome.response?.middlewareHeaders?.["content-length"]).toBeUndefined();
  });

  it("a resolver error is a clean bad gateway", async () => {
    const resolve: Resolver = () => {
      throw new Error("no such function");
    };
    const request = new Request("http://x/page");
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/page", "GET");
    expect(outcome.continue).toBe(false);
    expect(outcome.response?.middlewareStatus).toBe(502);
  });

  it("a handler that rejects is a clean bad gateway, not an unhandled rejection", async () => {
    const resolve = stubResolver(async () => {
      throw new Error("boom");
    });
    const request = new Request("http://x/page");
    const outcome = await createMiddlewareInvoker(resolve, request)("middleware", "/page", "GET");
    expect(outcome.continue).toBe(false);
    expect(outcome.response?.middlewareStatus).toBe(502);
  });

  it("fails closed on timeout", async () => {
    const resolve = stubResolver(() => new Promise<Response>(() => {})); // never resolves
    const request = new Request("http://x/slow");
    const start = Date.now();
    const outcome = await createMiddlewareInvoker(resolve, request, 50)("middleware", "/slow", "GET");
    expect(outcome.continue).toBe(false);
    expect(outcome.response?.middlewareStatus).toBe(504);
    expect(Date.now() - start).toBeLessThan(500);
  });

  // Final-review finding I3: a timed-out middleware call must cancel
  // its own outbound request, not just stop waiting for it — a real
  // resolver (@nbo/funcproxy's own createStaticURLs) proxying to a
  // real, slow backend, observed server-side for whether the
  // connection actually closed at the budget rather than running for
  // however long the backend itself takes.
  it("a timeout cancels the real outbound request through a real resolver", async () => {
    let aborted = false;
    await new Promise<void>((resolveListen) => {
      server = createServer((req, _res) => {
        req.on("aborted", () => {
          aborted = true;
        });
        // deliberately never responds
      });
      server.listen(0, resolveListen);
    });
    const { port } = server!.address() as AddressInfo;
    const resolve = createStaticURLs({ middleware: `http://127.0.0.1:${port}` });
    const request = new Request("http://x/slow");

    await createMiddlewareInvoker(resolve, request, 50)("middleware", "/slow", "GET");

    const deadline = Date.now() + 2000;
    while (!aborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(aborted).toBe(true);
  });
});
