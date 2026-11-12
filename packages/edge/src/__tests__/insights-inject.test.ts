// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { createInsertionStream, insightsTag, shouldInsert } from "../insights/inject.js";

const TAG = "<script data-x></script>";

async function run(chunks: string[], tag = TAG): Promise<string> {
  const enc = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(source.pipeThrough(createInsertionStream(tag))).text();
}

function bytewise(s: string): string[] {
  return [...s];
}

describe("createInsertionStream", () => {
  it("inserts before </head>", async () => {
    expect(await run(["<html><head><title>x</title></head><body>hi</body></html>"])).toBe(`<html><head><title>x</title>${TAG}</head><body>hi</body></html>`);
  });

  it("matches </HEAD> case-insensitively", async () => {
    expect(await run(["<HEAD></HEAD><BODY></BODY>"])).toBe(`<HEAD>${TAG}</HEAD><BODY></BODY>`);
  });

  it("finds a tag split across chunks, at every split point", async () => {
    const html = "<html><head><meta charset=utf-8></head><body>ok</body></html>";
    const want = html.replace("</head>", `${TAG}</head>`);
    for (let i = 1; i < html.length; i++) {
      expect(await run([html.slice(0, i), html.slice(i)])).toBe(want);
    }
    expect(await run(bytewise(html))).toBe(want);
  });

  it("finds a tag split across large chunks, at every split point around it", async () => {
    const html = "<html><head>" + "x".repeat(300) + "</head><body>" + "y".repeat(300) + "</body></html>";
    const want = html.replace("</head>", `${TAG}</head>`);
    const at = html.indexOf("</head>");
    for (let i = at - 8; i <= at + 8; i++) {
      expect(await run([html.slice(0, i), html.slice(i)])).toBe(want);
    }
  });

  it("falls back to before </body>", async () => {
    expect(await run(["<p>no head</p>", "</bo", "dy></html>"])).toBe(`<p>no head</p>${TAG}</body></html>`);
  });

  it("inserts only once", async () => {
    expect(await run(["<head></head><body></body><head></head>"])).toBe(`<head>${TAG}</head><body></body><head></head>`);
  });

  it("leaves a document with neither tag unchanged", async () => {
    expect(await run(["<p>fragment", "</p>"])).toBe("<p>fragment</p>");
  });

  it("keeps multi-byte UTF-8 intact", async () => {
    expect(await run(["<head>héllo — ✓", "</head>"])).toBe(`<head>héllo — ✓${TAG}</head>`);
  });

  it("streams: emits the first chunk before the source ends", async () => {
    const enc = new TextEncoder();
    let push!: (s: string | null) => void;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        push = (s) => (s === null ? c.close() : c.enqueue(enc.encode(s)));
      },
    });
    const reader = source.pipeThrough(createInsertionStream(TAG)).getReader();
    push("<html><head><title>a long enough title</title>");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("<html><head>");
    push("</head></html>");
    push(null);
  });
});

describe("insightsTag", () => {
  it("escapes attribute values", () => {
    expect(insightsTag({ environmentId: 'a"b<', contentId: "sha256:1", sampleRate: 50 })).toBe(
      '<script defer src="/_nbo/insights/v1/script.js" data-e="a&quot;b&lt;" data-d="sha256:1" data-s="50"></script>',
    );
  });
});

describe("shouldInsert", () => {
  const html = (init: ResponseInit = {}) => new Response("<head></head>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });
  const nav = (method = "GET", headers: Record<string, string> = { "sec-fetch-dest": "document" }) => new Request("http://app.test/", { method, headers });

  it("is true only for a GET document navigation answered 200 with text/html", () => {
    expect(shouldInsert(nav(), html())).toBe(true);
    expect(shouldInsert(nav("HEAD"), html())).toBe(false);
    expect(shouldInsert(nav("POST"), html())).toBe(false);
    expect(shouldInsert(nav(), html({ status: 404 }))).toBe(false);
    expect(shouldInsert(nav(), new Response("{}", { headers: { "content-type": "application/json" } }))).toBe(false);
    expect(shouldInsert(nav(), new Response("x"))).toBe(false);
  });

  it("leaves HTML fetched by scripts alone", () => {
    expect(shouldInsert(nav("GET", { "sec-fetch-dest": "empty", accept: "text/html" }), html())).toBe(false);
    expect(shouldInsert(nav("GET", { accept: "*/*" }), html())).toBe(false);
    expect(shouldInsert(nav("GET", {}), html())).toBe(false);
    expect(shouldInsert(nav("GET", { accept: "text/html,application/xhtml+xml" }), html())).toBe(true);
  });

  it("respects cache-control: no-transform and a still-encoded body", () => {
    expect(shouldInsert(nav(), html({ headers: { "content-type": "text/html", "cache-control": "public, no-transform" } }))).toBe(false);
    expect(shouldInsert(nav(), html({ headers: { "content-type": "text/html", "content-encoding": "zstd" } }))).toBe(false);
  });

  it("inserts only into ASCII-compatible charsets (or none named)", () => {
    const typed = (t: string) => html({ headers: { "content-type": t } });
    for (const ok of [
      "text/html",
      "text/html; charset=utf-8",
      "text/html;charset=UTF-8",
      'text/html; charset="utf-8"',
      "text/html; charset=us-ascii",
      "text/html; charset=ISO-8859-1",
      "text/html; charset=windows-1252",
      "text/html; charset=latin1",
    ]) {
      expect(shouldInsert(nav(), typed(ok)), ok).toBe(true);
    }
    for (const no of ["text/html; charset=utf-16", "text/html; charset=UTF-16LE", "text/html; charset=utf-32", "text/html; charset=shift_jis", "text/html; charset=x-unknown"]) {
      expect(shouldInsert(nav(), typed(no)), no).toBe(false);
    }
  });
});

describe("createInsertionStream carry", () => {
  async function chunksOf(input: string[]): Promise<string[]> {
    const enc = new TextEncoder();
    const out: string[] = [];
    const ts = createInsertionStream(TAG);
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    for (const ch of input) {
      void writer.write(enc.encode(ch));
      const { value } = await reader.read();
      out.push(new TextDecoder().decode(value));
    }
    return out;
  }

  it("passes a chunk with no possible tag start straight through", async () => {
    expect(await chunksOf(["<p>hello</p> world"])).toEqual(["<p>hello</p> world"]);
  });

  it("holds back only a suffix that could start </head> or </body>", async () => {
    expect(await chunksOf(["<p>abc</He"])).toEqual(["<p>abc"]);
    expect(await chunksOf(["text </b"])).toEqual(["text "]);
  });
});
