// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Mirrors entry-shim.test.ts's own established pattern exactly: fixture
// files written next to the real shim (middleware-entry-shim.mjs
// resolves middleware-dispatch.json/the compiled module relative to its
// OWN location), one real compiled-module fixture per case, imported
// fresh with a cache-busting query string per entry-shim.test.ts's own
// documented reason for doing so.
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");

// Each call writes its compiled module under a uniquely-named file:
// Node's ESM import() cache is keyed by resolved file:// URL, so if
// every test reused the same "mw/middleware.js" path, a later test
// would get an earlier test's cached module back despite the file's
// content having since changed on disk.
let fixtureCounter = 0;

function writeFixtureMiddleware(handlerBody: string) {
  mkdirSync(join(here, "mw"), { recursive: true });
  const relPath = `mw/middleware-${fixtureCounter++}.js`;
  writeFileSync(join(here, relPath), `exports.handler = ${handlerBody};`);
  writeFileSync(join(here, "middleware-dispatch.json"), JSON.stringify({ compiledPath: relPath }));
}

afterEach(() => {
  rmSync(join(here, "mw"), { recursive: true, force: true });
  rmSync(join(here, "middleware-dispatch.json"), { force: true });
});

describe("middleware-entry-shim", () => {
  it("renames x-middleware-next to x-nbo-next", async () => {
    writeFixtureMiddleware(`async () => new Response(null, { headers: { "x-middleware-next": "1" } })`);
    const { default: shim } = await import("../middleware-entry-shim.mjs?next");
    const res = await shim.fetch(new Request("http://x/"));
    expect(res.headers.get("x-nbo-next")).toBe("1");
    expect(res.headers.has("x-middleware-next")).toBe(false);
  });

  it("renames x-middleware-rewrite to x-nbo-rewrite", async () => {
    writeFixtureMiddleware(`async () => new Response(null, { headers: { "x-middleware-rewrite": "/new" } })`);
    const { default: shim } = await import("../middleware-entry-shim.mjs?rewrite");
    const res = await shim.fetch(new Request("http://x/"));
    expect(res.headers.get("x-nbo-rewrite")).toBe("/new");
  });

  // NextResponse.rewrite(new URL(path, request.url)) — the documented,
  // canonical way to write a same-origin rewrite — always produces a
  // fully-qualified URL in x-middleware-rewrite, never a bare path.
  // Without narrowing it back to a path, every ordinary same-origin
  // rewrite would look identical to an out-of-scope cross-origin one to
  // the router-side consumer.
  it("narrows a same-origin absolute x-middleware-rewrite down to a path", async () => {
    writeFixtureMiddleware(`async () => new Response(null, { headers: { "x-middleware-rewrite": "http://x/new" } })`);
    const { default: shim } = await import("../middleware-entry-shim.mjs?rewrite-same-origin");
    const res = await shim.fetch(new Request("http://x/"));
    expect(res.headers.get("x-nbo-rewrite")).toBe("/new");
  });

  // Real bug found running Slice 4's middleware verify script for real:
  // Next's own middleware runtime normalizes a loopback hostname to
  // "localhost" when it builds the rewrite URL via
  // NextResponse.rewrite(new URL(path, request.url)) — confirmed
  // directly (a real compiled middleware handler, called with a
  // request.url of "http://127.0.0.1:<port>/...", returned an
  // x-middleware-rewrite of "http://localhost:<port>/..." — same port,
  // renamed host). Without accounting for that, this same-origin
  // rewrite looked cross-origin to toPathIfSameOrigin's strict string
  // comparison and got rejected by the router-side consumer with a
  // clean 502, even though @nbo/serve and the function it's forwarding
  // to are the exact same loopback server.
  it("narrows a same-origin absolute x-middleware-rewrite even when Next renamed 127.0.0.1 to localhost", async () => {
    writeFixtureMiddleware(`async () => new Response(null, { headers: { "x-middleware-rewrite": "http://localhost:4100/new" } })`);
    const { default: shim } = await import("../middleware-entry-shim.mjs?rewrite-loopback-rename");
    const res = await shim.fetch(new Request("http://127.0.0.1:4100/"));
    expect(res.headers.get("x-nbo-rewrite")).toBe("/new");
  });

  it("leaves a genuinely cross-origin x-middleware-rewrite absolute", async () => {
    writeFixtureMiddleware(`async () => new Response(null, { headers: { "x-middleware-rewrite": "https://elsewhere.example/new" } })`);
    const { default: shim } = await import("../middleware-entry-shim.mjs?rewrite-cross-origin");
    const res = await shim.fetch(new Request("http://x/"));
    expect(res.headers.get("x-nbo-rewrite")).toBe("https://elsewhere.example/new");
  });

  it("renames x-middleware-override-headers and x-middleware-request-* to their x-nbo- equivalents", async () => {
    writeFixtureMiddleware(
      `async () => new Response(null, { headers: { "x-middleware-next": "1", "x-middleware-override-headers": "x-mw-echo", "x-middleware-request-x-mw-echo": "v" } })`,
    );
    const { default: shim } = await import("../middleware-entry-shim.mjs?override");
    const res = await shim.fetch(new Request("http://x/"));
    expect(res.headers.get("x-nbo-request-headers")).toBe("x-mw-echo");
    expect(res.headers.get("x-nbo-request-header-x-mw-echo")).toBe("v");
  });

  // x-middleware-set-cookie is dropped, not translated — confirmed
  // empirically (calling response.cookies.set() against a real
  // NextResponse from next/server) that it's a redundant re-encoding
  // of cookies the response *also* sets as native set-cookie headers.
  // Translating both produced duplicate Set-Cookie entries for the
  // same cookie; this fixture reproduces the real shape (both headers
  // present, as a real multi-cookie response.cookies.set() call
  // produces) rather than x-middleware-set-cookie in isolation, which
  // never happens in practice.
  it("does not duplicate cookies already present as native set-cookie headers", async () => {
    writeFixtureMiddleware(
      `async () => new Response(null, { headers: [["x-middleware-next", "1"], ["set-cookie", "a=1"], ["set-cookie", "b=2"], ["x-middleware-set-cookie", "a=1,b=2"]] })`,
    );
    const { default: shim } = await import("../middleware-entry-shim.mjs?cookie");
    const res = await shim.fetch(new Request("http://x/"));
    const setCookies = [...res.headers.entries()].filter(([k]) => k === "set-cookie").map(([, v]) => v);
    expect(setCookies).toEqual(["a=1", "b=2"]);
    expect(res.headers.has("x-middleware-set-cookie")).toBe(false);
  });
});
