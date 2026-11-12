// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchHandler, Resolver } from "@nbo/funcproxy";
import { createHandler } from "../serve.js";

async function writeServeFixture(withFallback: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "serve-fixture-"));
  await mkdir(join(dir, "static"), { recursive: true });
  await writeFile(join(dir, "static", "index.html"), "home");
  await writeFile(join(dir, "static", "404.html"), "missing");

  const files: Record<string, unknown> = {
    "/": { file: "index.html", contentType: "text/html; charset=utf-8", cache: "revalidate" },
    "/404": { file: "404.html", contentType: "text/html; charset=utf-8", cache: "revalidate" },
  };
  await writeFile(join(dir, "static.index.json"), JSON.stringify({ files }));

  const routes: Record<string, unknown> = { version: 1, error: { "404": { file: "/404" } } };
  if (withFallback) {
    routes.fallback = [
      {
        id: "spa-fallback",
        match: { path: "^/", pathNot: "\\.[A-Za-z0-9]+$" },
        action: { type: "rewrite", path: "/" },
      },
    ];
  }
  await writeFile(join(dir, "routes.json"), JSON.stringify(routes));
  return dir;
}

async function writeFixtureWithRoutesJSON(routesJSON: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "serve-fixture-"));
  await writeFile(join(dir, "static.index.json"), `{"files":{}}`);
  await writeFile(join(dir, "routes.json"), routesJSON);
  return dir;
}

function stubResolver(handler: FetchHandler): Resolver {
  return (_name: string) => handler;
}

describe("createHandler", () => {
  it("serves a known static path", async () => {
    const dir = await writeServeFixture(false);
    const handler = await createHandler(dir);
    const res = await handler(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("home");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("returns 404 without a fallback", async () => {
    const dir = await writeServeFixture(false);
    const handler = await createHandler(dir);
    const res = await handler(new Request("http://x/nope"));
    expect(res.status).toBe(404);
  });

  it("applies the fallback rewrite for deep links", async () => {
    const dir = await writeServeFixture(true);
    const handler = await createHandler(dir);
    const res = await handler(new Request("http://x/settings/profile"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("home");
  });

  it("a missing asset still 404s even with a fallback", async () => {
    const dir = await writeServeFixture(true);
    const handler = await createHandler(dir);
    const res = await handler(new Request("http://x/assets/missing.js"));
    expect(res.status).toBe(404);
  });

  it("rejects a static.index.json entry whose file climbs out of static/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "serve-fixture-"));
    await mkdir(join(dir, "static"), { recursive: true });
    await writeFile(join(dir, "static", "index.html"), "home");
    await writeFile(join(dir, "secret.txt"), "top-secret");

    const files = {
      "/": { file: "index.html", contentType: "text/html; charset=utf-8", cache: "revalidate" },
      "/evil": { file: "../secret.txt", contentType: "text/plain", cache: "revalidate" },
    };
    await writeFile(join(dir, "static.index.json"), JSON.stringify({ files }));
    await writeFile(join(dir, "routes.json"), JSON.stringify({ version: 1, error: {} }));

    const handler = await createHandler(dir);
    const res = await handler(new Request("http://x/evil"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toBe("top-secret");
  });

  it("a beforeFiles redirect takes priority over a matching static file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "serve-fixture-"));
    await mkdir(join(dir, "static"), { recursive: true });
    await writeFile(join(dir, "static", "old.html"), "old");
    const files = { "/docs/v1/intro": { file: "old.html", contentType: "text/html; charset=utf-8", cache: "revalidate" } };
    await writeFile(join(dir, "static.index.json"), JSON.stringify({ files }));
    const routes = {
      version: 1,
      beforeFiles: [
        {
          id: "old-docs",
          match: { path: "^/docs/v1/(?P<rest>.*)$" },
          action: { type: "redirect", location: "/docs/$rest", status: 308 },
        },
      ],
    };
    await writeFile(join(dir, "routes.json"), JSON.stringify(routes));

    const handler = await createHandler(dir);
    const res = await handler(new Request("http://x/docs/v1/intro"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/docs/intro");
  });

  it("an onMatch headers rule applies even to a plain static hit", async () => {
    const dir = await writeServeFixture(false);
    const routesPath = join(dir, "routes.json");
    const routes = JSON.parse(await readFile(routesPath, "utf8")) as Record<string, unknown>;
    routes.onMatch = [
      {
        id: "root-cache",
        match: { path: "^/$" },
        action: { type: "headers", set: { "x-test-header": "yes" } },
        continue: true,
      },
    ];
    await writeFile(routesPath, JSON.stringify(routes));

    const handler = await createHandler(dir);
    const res = await handler(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-test-header")).toBe("yes");
  });

  it("a beforeFiles header op survives a redirect in the same phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "serve-fixture-"));
    await mkdir(join(dir, "static"), { recursive: true });
    await writeFile(join(dir, "static", "old.html"), "old");
    const files = { "/old": { file: "old.html", contentType: "text/html; charset=utf-8", cache: "revalidate" } };
    await writeFile(join(dir, "static.index.json"), JSON.stringify({ files }));
    const routes = {
      version: 1,
      beforeFiles: [
        { id: "security-headers", match: { path: "^/" }, action: { type: "headers", set: { "x-frame-options": "DENY" } }, continue: true },
        { id: "old-redirect", match: { path: "^/old$" }, action: { type: "redirect", location: "/new", status: 301 } },
      ],
    };
    await writeFile(join(dir, "routes.json"), JSON.stringify(routes));

    const handler = await createHandler(dir);
    const res = await handler(new Request("http://x/old"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/new");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("a rewrite to a function dispatches to the resolver by name", async () => {
    const dir = await writeFixtureWithRoutesJSON(
      JSON.stringify({ version: 1, afterFiles: [{ id: "ssr", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } }] }),
    );
    const resolve = stubResolver(async () => new Response("ssr-response"));
    const handler = await createHandler(dir, resolve);
    const res = await handler(new Request("http://x/"));
    expect(await res.text()).toBe("ssr-response");
  });

  // Real security gap found reviewing Slice 5's PPR work: once
  // minimalMode is on for the ssr function (needed so Next's compiled
  // handler honors a PPR resume at all), the SAME handler trusts
  // "next-resume"/"x-matched-path" from whatever request reaches it —
  // there's nothing route-specific about that trust, so an untrusted
  // caller sending those headers directly at ANY function-backed route
  // (prerender or not) could make Next's handler try to resume an
  // attacker-chosen path with an attacker-chosen "postponed state"
  // blob. createHandler strips both before any routing decision, so
  // the function must never see values a client supplied.
  it("strips next-resume and x-matched-path from an incoming client request before it ever reaches a function", async () => {
    const dir = await writeFixtureWithRoutesJSON(
      JSON.stringify({ version: 1, afterFiles: [{ id: "ssr", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } }] }),
    );
    let gotHeaders: Headers | undefined;
    const resolve = stubResolver(async (request) => {
      gotHeaders = request.headers;
      return new Response("ssr-response");
    });
    const handler = await createHandler(dir, resolve);
    await handler(
      new Request("http://x/", {
        method: "POST",
        headers: { "next-resume": "1", "x-matched-path": "/some-other-route", "x-next-resume-state-length": "999" },
        body: "attacker-controlled-postponed-state",
      }),
    );
    expect(gotHeaders!.has("next-resume")).toBe(false);
    expect(gotHeaders!.has("x-matched-path")).toBe(false);
    expect(gotHeaders!.has("x-next-resume-state-length")).toBe(false);
  });

  it("strips every header Next treats as internal, matching its INTERNAL_HEADERS", async () => {
    const dir = await writeFixtureWithRoutesJSON(
      JSON.stringify({ version: 1, afterFiles: [{ id: "ssr", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } }] }),
    );
    let gotHeaders: Headers | undefined;
    const resolve = stubResolver(async (request) => {
      gotHeaders = request.headers;
      return new Response("ssr-response");
    });
    const handler = await createHandler(dir, resolve);
    const internal = [
      "x-middleware-rewrite",
      "x-middleware-redirect",
      "x-middleware-set-cookie",
      "x-middleware-skip",
      "x-middleware-override-headers",
      "x-middleware-next",
      "x-now-route-matches",
      "x-matched-path",
      "x-nextjs-data",
      "x-next-resume-state-length",
      "next-resume",
    ];
    await handler(new Request("http://x/", { headers: Object.fromEntries(internal.map((h) => [h, "1"])) }));
    for (const h of internal) expect(gotHeaders!.has(h), h).toBe(false);
  });

  it("keeps the client's disconnect signal on a request it had to strip", async () => {
    const dir = await writeFixtureWithRoutesJSON(
      JSON.stringify({ version: 1, afterFiles: [{ id: "ssr", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } }] }),
    );
    let gotSignal: AbortSignal | undefined;
    const resolve = stubResolver(async (request) => {
      gotSignal = request.signal;
      return new Response("ssr-response");
    });
    const handler = await createHandler(dir, resolve);
    const client = new AbortController();
    await handler(new Request("http://x/", { headers: { "next-resume": "1" }, signal: client.signal }));
    expect(gotSignal!.aborted).toBe(false);
    client.abort();
    expect(gotSignal!.aborted).toBe(true);
  });

  describe("x-forwarded-host", () => {
    const ssrRoutes = JSON.stringify({ version: 1, afterFiles: [{ id: "ssr", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } }] });

    async function capture(request: Request): Promise<{ headers: Headers; body: string }> {
      const dir = await writeFixtureWithRoutesJSON(ssrRoutes);
      let got: { headers: Headers; body: string } | undefined;
      const resolve = stubResolver(async (req) => {
        got = { headers: req.headers, body: await req.text() };
        return new Response("ssr-response");
      });
      const handler = await createHandler(dir, resolve);
      await handler(request);
      return got!;
    }

    // funcproxy drops Host, so a function otherwise sees its own loopback
    // address as the host, and Next refuses every server action.
    it("is set from the incoming Host when a request has none", async () => {
      const got = await capture(new Request("http://x/", { headers: { host: "site.test:4109" } }));
      expect(got.headers.get("x-forwarded-host")).toBe("site.test:4109");
    });

    it("keeps a POST's body when it has to be added", async () => {
      const got = await capture(new Request("http://x/", { method: "POST", headers: { host: "site.test" }, body: "form-data" }));
      expect(got.headers.get("x-forwarded-host")).toBe("site.test");
      expect(got.body).toBe("form-data");
    });

    it("is never overwritten when the edge sent one", async () => {
      const got = await capture(new Request("http://x/", { headers: { host: "internal.svc", "x-forwarded-host": "public.test" } }));
      expect(got.headers.get("x-forwarded-host")).toBe("public.test");
    });

    it("comes from the URL when a request has no Host header", async () => {
      const got = await capture(new Request("http://site.test:8080/"));
      expect(got.headers.get("x-forwarded-host")).toBe("site.test:8080");
    });
  });

  it("a rewrite to a function carries the rewritten path", async () => {
    const dir = await writeFixtureWithRoutesJSON(
      JSON.stringify({
        version: 1,
        beforeFiles: [{ id: "to-new", match: { path: "^/old$" }, action: { type: "rewrite", path: "/new" } }],
        afterFiles: [{ id: "ssr", match: { path: "^/new$" }, action: { type: "rewrite", function: "ssr" } }],
      }),
    );
    let gotPath = "";
    const resolve = stubResolver(async (request) => {
      gotPath = new URL(request.url).pathname;
      return new Response("ok");
    });
    const handler = await createHandler(dir, resolve);
    await handler(new Request("http://x/old"));
    expect(gotPath).toBe("/new");
  });

  it("a Function decision with no resolve configured is a clean 500", async () => {
    const dir = await writeFixtureWithRoutesJSON(
      JSON.stringify({ version: 1, afterFiles: [{ id: "ssr", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } }] }),
    );
    const handler = await createHandler(dir);
    const res = await handler(new Request("http://x/"));
    expect(res.status).toBe(500);
  });

  // Final-review finding C1: Fetch's Headers iterator yields one
  // entry per Set-Cookie value rather than folding them — copying
  // every header via .set() loses every value but the last.
  it("a function response setting two Set-Cookie values keeps both", async () => {
    const dir = await writeFixtureWithRoutesJSON(
      JSON.stringify({ version: 1, afterFiles: [{ id: "ssr", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } }] }),
    );
    const resolve = stubResolver(async () => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response("ok", { headers });
    });
    const handler = await createHandler(dir, resolve);
    const res = await handler(new Request("http://x/"));
    expect(res.headers.getSetCookie().sort()).toEqual(["a=1", "b=2"]);
  });

  // Final-review finding I2: a function whose FetchHandler call
  // rejects must still produce a clean response — the FetchHandler
  // contract every other resolver in this rewrite already follows.
  it("a function that rejects is a clean 502, not a propagated rejection", async () => {
    const dir = await writeFixtureWithRoutesJSON(
      JSON.stringify({ version: 1, afterFiles: [{ id: "ssr", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } }] }),
    );
    const resolve = stubResolver(async () => {
      throw new Error("boom");
    });
    const handler = await createHandler(dir, resolve);
    const res = await handler(new Request("http://x/"));
    expect(res.status).toBe(502);
  });

  // Final-review finding I4: hop-by-hop headers (RFC 7230 §6.1)
  // describe the upstream connection only and must never reach the
  // client as-is.
  it("strips hop-by-hop headers from a function's own response", async () => {
    const dir = await writeFixtureWithRoutesJSON(
      JSON.stringify({ version: 1, afterFiles: [{ id: "ssr", match: { path: "^/$" }, action: { type: "rewrite", function: "ssr" } }] }),
    );
    const resolve = stubResolver(
      async () =>
        new Response("ok", { headers: { connection: "keep-alive", "transfer-encoding": "chunked", "x-real-header": "yes" } }),
    );
    const handler = await createHandler(dir, resolve);
    const res = await handler(new Request("http://x/"));
    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(res.headers.get("x-real-header")).toBe("yes");
  });

  // Final-review finding I1: @nbo/writer keys static.index.json by
  // the fully-decoded path, but a request's URL.pathname stays
  // percent-encoded for non-ASCII characters and spaces.
  it("serves a static file whose path has a non-ASCII character", async () => {
    const dir = await mkdtemp(join(tmpdir(), "serve-fixture-"));
    await mkdir(join(dir, "static"), { recursive: true });
    await writeFile(join(dir, "static", "cafe.html"), "café content");
    const files = { "/café.html": { file: "cafe.html", contentType: "text/html; charset=utf-8", cache: "revalidate" } };
    await writeFile(join(dir, "static.index.json"), JSON.stringify({ files }));
    await writeFile(join(dir, "routes.json"), JSON.stringify({ version: 1, error: {} }));

    const handler = await createHandler(dir);
    const res = await handler(new Request("http://x/café.html"));
    expect(res.status).toBe(200);
  });
});

describe("x-nbo-deployment-id", () => {
  const ID = "sha256:" + "a".repeat(64);

  async function fixture(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "serve-depid-"));
    await mkdir(join(dir, "static"), { recursive: true });
    await writeFile(join(dir, "static", "index.html"), "home");
    await writeFile(
      join(dir, "static.index.json"),
      JSON.stringify({ files: { "/": { file: "index.html", contentType: "text/html; charset=utf-8", cache: "revalidate" } } }),
    );
    await writeFile(
      join(dir, "routes.json"),
      JSON.stringify({
        version: 1,
        beforeFiles: [
          { id: "fn", match: { path: "^/fn$" }, action: { type: "rewrite", function: "app" } },
          { id: "go", match: { path: "^/go$" }, action: { type: "redirect", location: "/", status: 302 } },
        ],
      }),
    );
    return dir;
  }

  it("sets the header on static, function, redirect, 404 and revalidate answers", async () => {
    const dir = await fixture();
    const resolve = stubResolver(async () => new Response("fn", { headers: { "x-nbo-deployment-id": "evil" } }));
    const handler = await createHandler(dir, resolve, undefined, { deploymentId: ID });
    for (const [url, init] of [
      ["http://x/", undefined],
      ["http://x/fn", undefined],
      ["http://x/go", undefined],
      ["http://x/missing", undefined],
      ["http://x/_nbo/revalidate", { method: "POST" }],
    ] as const) {
      const res = await handler(new Request(url, init));
      expect(res.headers.get("x-nbo-deployment-id"), url).toBe(ID);
    }
  });

  it("replaces a client-sent copy before the function sees it", async () => {
    const dir = await fixture();
    let seen: string | null = null;
    const resolve = stubResolver(async (req) => {
      seen = req.headers.get("x-nbo-deployment-id");
      return new Response("fn");
    });
    const handler = await createHandler(dir, resolve, undefined, { deploymentId: ID });
    await handler(new Request("http://x/fn", { headers: { "x-nbo-deployment-id": "evil" } }));
    expect(seen).toBe(ID);
  });

  it("sets nothing without a deploymentId", async () => {
    const dir = await fixture();
    const handler = await createHandler(dir);
    const res = await handler(new Request("http://x/"));
    expect(res.headers.has("x-nbo-deployment-id")).toBe(false);
  });
});
