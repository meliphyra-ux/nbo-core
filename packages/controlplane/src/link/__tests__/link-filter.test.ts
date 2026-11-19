// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../../store/store.js";
import type { Mux } from "../../http/handlers.js";
import type { RouteHandler } from "../../http/router.js";
import { createDispatcher } from "../dispatch.js";
import { createSuppliedValues } from "../../variables/supplied-values.js";
import { filterJson, filterStream, knownSecrets, withheldKeys } from "../filter.js";
import { recordFor } from "../../domains/domain-routes.js";
import { parseMapping } from "../../domains/cloudrun-domains.js";
import {
  makeEnvelope,
  makeLinkTestKeys,
  noSecrets,
  pinLink,
  signInstruction,
} from "../../__tests__/link-keys-fixture.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

let lastKey: Buffer;
async function newStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "nbo-link-filter-"));
  lastKey = randomBytes(32);
  const store = createStore(join(dir, "test.db"), { secretKey: lastKey });
  cleanups.push(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return store;
}

function stubMux(handler: RouteHandler): Mux {
  const mux = async () => new Response(null, { status: 500 });
  return Object.assign(mux, {
    routes: () => ["GET /projects"],
    match: () => ({ method: "GET", pattern: "/projects", params: {}, handler }),
  });
}

async function* chunksOf(...parts: (string | Uint8Array)[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield typeof p === "string" ? new TextEncoder().encode(p) : p;
}

async function collect(it: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const out: Uint8Array[] = [];
  for await (const c of it) out.push(c);
  return Buffer.concat(out);
}

describe("filterJson", () => {
  it("withholds every listed key at any depth", () => {
    const body = {
      name: "a",
      nested: [{ Token: "t", deep: { KUBECONFIG: "k", ok: 1 } }],
      ...Object.fromEntries(withheldKeys.map((k) => [k, { anything: true }])),
    };
    const out = filterJson(body, []) as any;
    for (const k of withheldKeys) expect(out[k], k).toBe("[withheld over the link]");
    expect(out.nested[0].Token).toBe("[withheld over the link]");
    expect(out.nested[0].deep).toEqual({ KUBECONFIG: "[withheld over the link]", ok: 1 });
    expect(out.name).toBe("a");
  });

  it("lets a domain's DNS records reach the dashboard: their target is in data, which is not withheld", () => {
    const edge = filterJson(recordFor("www.example.com", "203.0.113.7"), []) as any;
    expect(edge.data).toBe("203.0.113.7");
    const mapped = parseMapping(
      JSON.stringify({
        status: { resourceRecords: [{ type: "CNAME", name: "www", rrdata: "ghs.googlehosted.com." }] },
      }),
    );
    expect((filterJson(mapped.records, []) as any)[0].data).toBe("ghs.googlehosted.com.");
  });

  it("keeps a __proto__ key a plain key", () => {
    const out = filterJson(JSON.parse('{"__proto__":{"token":"t"}}'), []) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
  });

  it("redacts secrets inside strings, base64 form included", () => {
    const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----";
    const out = filterJson({ a: `x${pem}y`, b: ["zz-s3cret-zz", Buffer.from("s3cret").toString("base64")] }, [
      pem,
      "s3cret",
    ]);
    expect(JSON.stringify(out)).not.toContain("s3cret");
    expect(JSON.stringify(out)).not.toContain(Buffer.from("s3cret").toString("base64"));
    expect(JSON.stringify(out)).not.toContain("abc");
  });
});

describe("knownSecrets", () => {
  it("finds variable values, webhook secrets and the link's private keys", async () => {
    const store = await newStore();
    const keys = await makeLinkTestKeys();
    await pinLink(store, keys);
    const p = store.createProject("shop");
    store.setEnv({ projectId: p.id }, "API_KEY", "k", true);
    store.setEnv({ projectId: null }, "PLAIN_LONG", "plain-value", false);
    store.setEnv({ projectId: null }, "PLAIN_SHORT", "abc", false);
    const hook = store.ensureWebhookSecret(p.id);
    const own = store.openLinkKeys()!;
    const found = knownSecrets(store);
    expect(found).toEqual(expect.arrayContaining(["k", "plain-value", hook, own.encryptionPkcs8, own.identityPkcs8]));
    expect(found).not.toContain("abc");
  });
});

describe("the filter on replies", () => {
  it("redacts a seeded secret inside any string", async () => {
    const store = await newStore();
    const keys = await makeLinkTestKeys();
    await pinLink(store, keys);
    const secret = "seeded-secret-value-42";
    store.setEnv({ projectId: null }, "SEEDED", secret, true);
    const d = createDispatcher({
      ...noSecrets,
      store,
      mux: stubMux(
        async () =>
          new Response(JSON.stringify({ note: `x${secret}y` }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    const reply = await d.dispatch(await signInstruction(keys, makeEnvelope(keys, new Date())));
    expect(reply.kind).toBe("response");
    if (reply.kind !== "response") return;
    const text = new TextDecoder().decode(reply.body);
    expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toEqual({ note: "x[redacted]y" });
  });

  it("redacts a seeded secret in a streamed reply", async () => {
    const store = await newStore();
    const keys = await makeLinkTestKeys();
    await pinLink(store, keys);
    const secret = "seeded-secret-value-42";
    store.setEnv({ projectId: null }, "SEEDED", secret, true);
    const d = createDispatcher({
      ...noSecrets,
      store,
      mux: stubMux(
        async () =>
          new Response(`line\n${"x".repeat(65_530)}${secret}\n`, {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      ),
    });
    const reply = await d.dispatch(await signInstruction(keys, makeEnvelope(keys, new Date())));
    expect(reply.kind).toBe("stream");
    if (reply.kind !== "stream") return;
    const text = (await collect(reply.chunks)).toString("utf8");
    expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]");
  });
});

describe("each secret source reaches a reply redacted", () => {
  const echo = (note: unknown) =>
    stubMux(
      async () =>
        new Response(JSON.stringify({ note }), { status: 200, headers: { "content-type": "application/json" } }),
    );
  async function replyText(
    store: Store,
    mux: Mux,
    extra: Partial<Omit<Parameters<typeof createDispatcher>[0], "store" | "mux">> = {},
  ): Promise<string> {
    const keys = await makeLinkTestKeys();
    await pinLink(store, keys);
    const d = createDispatcher({ ...noSecrets, store, mux, ...extra });
    const reply = await d.dispatch(await signInstruction(keys, makeEnvelope(keys, new Date())));
    if (reply.kind !== "response") throw new Error("expected a response");
    return new TextDecoder().decode(reply.body);
  }

  it("the master secret key, hex and base64", async () => {
    const store = await newStore();
    const forms = [lastKey.toString("hex"), lastKey.toString("base64"), lastKey.toString("base64url")];
    const text = await replyText(store, echo(forms.map((f) => `<${f}>`)));
    for (const f of forms) expect(text).not.toContain(f);
    expect(JSON.parse(text).note).toEqual(["<[redacted]>", "<[redacted]>", "<[redacted]>"]);
  });

  it("in-memory supplied values", async () => {
    const store = await newStore();
    const supplied = createSuppliedValues();
    supplied.put("build_1", { API_KEY: "supplied-value-77" });
    const text = await replyText(store, echo("x supplied-value-77 y"), { supplied });
    expect(JSON.parse(text).note).toBe("x [redacted] y");
  });

  it("cached GitHub installation tokens", async () => {
    const store = await newStore();
    const text = await replyText(store, echo("ghs_cachedtoken123"), {
      github: { cachedTokens: () => ["ghs_cachedtoken123"] },
    });
    expect(JSON.parse(text).note).toBe("[redacted]");
  });

  it("server secrets from server-settings' own list", async () => {
    const store = await newStore();
    store.setServerSecret("edge_drain_token", "drain-token-abcdef");
    const text = await replyText(store, echo("drain-token-abcdef"));
    expect(JSON.parse(text).note).toBe("[redacted]");
  });

  it("a short secret equal to a common word does not mangle a reply; its key stays withheld", async () => {
    const store = await newStore();
    store.setEnv({ projectId: null }, "SHORT", "the", true);
    const mux = stubMux(
      async () =>
        new Response(JSON.stringify({ note: "the cat", the: 1, value: "the" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(JSON.parse(await replyText(store, mux))).toEqual({
      note: "the cat",
      the: 1,
      value: "[withheld over the link]",
    });
  });
});

describe("filterJson keys", () => {
  it("never touches object keys", () => {
    expect(filterJson({ "s3cret-key-name": 1 }, ["s3cret-key-name"])).toEqual({ "s3cret-key-name": 1 });
  });
  it("redacts only secrets of 6+ characters", () => {
    expect(filterJson({ a: "the abcde abcdef" }, ["the", "abcde", "abcdef"])).toEqual({ a: "the abcde [redacted]" });
  });
});

describe("filterStream", () => {
  it("two secrets of different lengths, each cut across chunks", async () => {
    const out = (
      await collect(
        filterStream(chunksOf("a short1", "23456 and a much-longer-", "secret-value-xyz end"), [
          "short123456",
          "much-longer-secret-value-xyz",
        ]),
      )
    ).toString("utf8");
    expect(out).toBe("a [redacted] and a [redacted] end");
  });

  it("a multibyte character cut at a chunk boundary", async () => {
    const all = Buffer.from("h\u00e9llo p\u00e4ssw\u00f6rd-123 w\u00f6rld", "utf8");
    const at = all.indexOf(Buffer.from("\u00e4", "utf8")) + 1; // inside the two bytes of the a-umlaut
    const first = all.indexOf(Buffer.from("\u00e9", "utf8")) + 1; // inside the e-acute, no secret there
    const out = await collect(
      filterStream(chunksOf(all.subarray(0, first), all.subarray(first, at), all.subarray(at)), [
        "p\u00e4ssw\u00f6rd-123",
      ]),
    );
    expect(out.toString("utf8")).toBe("h\u00e9llo [redacted] w\u00f6rld");
    const plain = await collect(filterStream(chunksOf(all.subarray(0, first), all.subarray(first)), ["not-in-there"]));
    expect(plain.equals(all)).toBe(true);
  });

  it("a secret cut across two chunks is redacted", async () => {
    const out = (await collect(filterStream(chunksOf("hello ab", "cdef world"), ["abcdef"]))).toString("utf8");
    expect(out).toBe("hello [redacted] world");
  });

  it("a secret cut across many small chunks is redacted", async () => {
    const out = (await collect(filterStream(chunksOf(..."--abcdef--abcdef".split("")), ["abcdef"]))).toString("utf8");
    expect(out).toBe("--[redacted]--[redacted]");
  });

  it("a stream with no secrets passes byte for byte", async () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80, 0x41]);
    const input = [binary, new TextEncoder().encode("plain text"), binary];
    expect((await collect(filterStream(chunksOf(...input), ["abcdef"]))).equals(Buffer.concat(input))).toBe(true);
    expect((await collect(filterStream(chunksOf(...input), []))).equals(Buffer.concat(input))).toBe(true);
  });
});
