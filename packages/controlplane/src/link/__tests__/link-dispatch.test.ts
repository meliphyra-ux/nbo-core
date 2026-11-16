// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealTo, type Envelope } from "@nbo/link-protocol";
import { createStore, type Store } from "../../store/store.js";
import type { Mux } from "../../http/handlers.js";
import type { RouteHandler } from "../../http/router.js";
import { isLinkRequest, isTokenRequest } from "../../http/api-tokens.js";
import { createLinkKeys } from "../keys.js";
import { createDispatcher, linkSignerOf, type LinkReply } from "../dispatch.js";
import { startHarness, type Harness } from "../../__tests__/v2-harness.js";
import {
  makeEnvelope,
  makeLinkTestKeys,
  noSecrets,
  pinLink,
  signInstruction,
  type LinkTestKeys,
  type TestMemberKey,
} from "../../__tests__/link-keys-fixture.js";

let keys: LinkTestKeys;
beforeAll(async () => {
  keys = await makeLinkTestKeys();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function harness(): Promise<Harness> {
  const h = await startHarness({ secretKey: true });
  cleanups.push(() => h.close());
  await pinLink(h.store, keys);
  return h;
}

// A store of its own for tests that use a stub mux.
async function bareStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "nbo-link-dispatch-"));
  const store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  cleanups.push(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await pinLink(store, keys);
  return store;
}

// stubMux: every request matches one route (GET /projects unless told
// otherwise) and runs handler.
function stubMux(
  handler: RouteHandler,
  route: { method?: string; pattern?: string; params?: Record<string, string> } = {},
): Mux {
  const { method = "GET", pattern = "/projects", params = {} } = route;
  const mux = async () => new Response(null, { status: 500 });
  return Object.assign(mux, {
    routes: () => [`${method} ${pattern}`],
    match: () => ({ method, pattern, params, handler }),
  });
}

const signed = async (over: Partial<Envelope>, member?: TestMemberKey) =>
  signInstruction(keys, makeEnvelope(keys, new Date(), over), member ? { member } : {});

async function bodyOf(reply: LinkReply): Promise<string> {
  if (reply.kind === "response") return new TextDecoder().decode(reply.body);
  const parts: Uint8Array[] = [];
  for await (const c of reply.chunks) parts.push(c);
  return Buffer.concat(parts).toString("utf8");
}
const jsonOf = async (reply: LinkReply): Promise<any> => JSON.parse(await bodyOf(reply));

describe("dispatch", () => {
  it("runs a Tier 0 GET /projects through the same handler as HTTP", async () => {
    const h = await harness();
    await h.call("POST", "/projects", { name: "shop" });
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const reply = await d.dispatch(await signed({ method: "GET", routePattern: "/projects" }));
    expect(reply.status).toBe(200);
    expect(reply.kind).toBe("response");
    expect(await jsonOf(reply)).toEqual((await h.call("GET", "/projects")).json);
  });

  it("refuses a param that would reach another route", async () => {
    const h = await harness();
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const reply = await d.dispatch(
      await signed({ method: "GET", routePattern: "/projects/{projectID}", params: { projectID: "summary" } }),
    );
    expect(reply.status).toBe(403);
    expect((await jsonOf(reply)).error).toMatch(/^link: route is not allowed over the link/);
  });

  it("refuses a missing or extra param", async () => {
    const h = await harness();
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const missing = await d.dispatch(
      await signed({ method: "GET", routePattern: "/projects/{projectID}", params: {} }),
    );
    expect(missing.status).toBe(400);
    expect((await jsonOf(missing)).error).toBe("link: param projectID is missing");
    const extra = await d.dispatch(
      await signed({ method: "GET", routePattern: "/projects", params: { projectID: "x" } }),
    );
    expect(extra.status).toBe(400);
    expect((await jsonOf(extra)).error).toBe("link: param projectID is not in the route");
  });

  it("refuses a dot segment or a slash in a param", async () => {
    const h = await harness();
    const p = (await h.call("POST", "/projects", { name: "shop" })).json;
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    for (const projectID of ["..", ".", `${p.id}/summary`]) {
      const reply = await d.dispatch(
        await signed({ method: "GET", routePattern: "/projects/{projectID}/summary", params: { projectID } }),
      );
      expect(reply.status, projectID).not.toBe(200);
    }
  });

  it("refuses a clear-text kubeconfig", async () => {
    const h = await harness();
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const reply = await d.dispatch(
      await signed(
        {
          method: "POST",
          routePattern: "/system/connections/kubernetes",
          body: { name: "a", source: { kubeconfig: "apiVersion: v1" } },
        },
        keys.owner,
      ),
    );
    expect(reply.status).toBe(400);
    expect((await jsonOf(reply)).error).toBe("link: source.kubeconfig must be sealed to this core's key");
    expect(h.store.listKubernetesConnections()).toEqual([]);
  });

  it("opens a sealed variable value and stores it", async () => {
    const h = await harness();
    const p = (await h.call("POST", "/projects", { name: "shop" })).json;
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const value = await sealTo(h.store.getLinkState()!.encryptionPublic, "s3cret-api-key", {
      coreId: h.store.getLinkState()!.coreId,
      route: "PUT /projects/{projectID}/env/{name}",
      path: `/projects/${p.id}/env/API_KEY`,
      field: "value",
    });
    const reply = await d.dispatch(
      await signed(
        {
          method: "PUT",
          routePattern: "/projects/{projectID}/env/{name}",
          params: { projectID: p.id, name: "API_KEY" },
          body: { value, secret: true },
        },
        keys.owner,
      ),
    );
    expect(reply.status).toBe(200);
    expect(await bodyOf(reply)).not.toContain("s3cret-api-key");
    expect(h.store.resolveEnv(p.id).vars.API_KEY).toBe("s3cret-api-key");
  });

  it("opens a sealed JSON field as JSON", async () => {
    const store = await bareStore();
    let seen: unknown;
    const route = { method: "POST", pattern: "/projects/{projectID}/builds", params: { projectID: "p1" } };
    const mux = stubMux(async (request) => {
      seen = await request.json();
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }, route);
    const box = await sealTo(store.getLinkState()!.encryptionPublic, JSON.stringify({ API_KEY: "abc-123-xyz" }), {
      coreId: store.getLinkState()!.coreId,
      route: "POST /projects/{projectID}/builds",
      path: "/projects/p1/builds",
      field: "values",
    });
    const d = createDispatcher({ ...noSecrets, store, mux });
    const reply = await d.dispatch(
      await signed(
        { method: "POST", routePattern: route.pattern, params: route.params, body: { values: box } },
        keys.admin,
      ),
    );
    expect(reply.status).toBe(202);
    expect(seen).toEqual({ values: { API_KEY: "abc-123-xyz" } });
  });

  it("a deploy with supplied values needs an Admin's signature (Tier 2)", async () => {
    const store = await bareStore();
    let calls = 0;
    let seen: unknown;
    const route = { method: "POST", pattern: "/builds/{buildID}/deploy", params: { buildID: "b1" } };
    const mux = stubMux(async (request) => {
      calls++;
      seen = await request.json();
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }, route);
    const d = createDispatcher({ ...noSecrets, store, mux });
    const values = await sealTo(
      store.getLinkState()!.encryptionPublic,
      JSON.stringify({ DATABASE_URL: "postgres://elsewhere.example/db" }),
      {
        coreId: store.getLinkState()!.coreId,
        route: "POST /builds/{buildID}/deploy",
        path: "/builds/b1/deploy",
        field: "values",
      },
    );
    const body = { environmentId: "env_1", values };
    const unsigned = await d.dispatch(
      await signed({ method: "POST", routePattern: route.pattern, params: route.params, body }),
    );
    expect(unsigned.status).toBe(403);
    expect((await jsonOf(unsigned)).error).toBe("link: Tier 2 needs a valid member signature");
    expect(calls).toBe(0);
    const approved = await d.dispatch(
      await signed({ method: "POST", routePattern: route.pattern, params: route.params, body }, keys.admin),
    );
    expect(approved.status).toBe(202);
    expect(calls).toBe(1);
    expect(seen).toEqual({ environmentId: "env_1", values: { DATABASE_URL: "postgres://elsewhere.example/db" } });
    // Without values the same deploy stays Tier 1.
    const plain = await d.dispatch(
      await signed({
        method: "POST",
        routePattern: route.pattern,
        params: route.params,
        body: { environmentId: "env_1" },
      }),
    );
    expect(plain.status).toBe(202);
    expect(calls).toBe(2);
  });

  it("refuses a sealed value that does not open", async () => {
    const h = await harness();
    const p = (await h.call("POST", "/projects", { name: "shop" })).json;
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const value = await sealTo((await createLinkKeys()).encryptionPublic, "x-value", {
      coreId: h.store.getLinkState()!.coreId,
      route: "PUT /projects/{projectID}/env/{name}",
      path: `/projects/${p.id}/env/API_KEY`,
      field: "value",
    });
    const reply = await d.dispatch(
      await signed(
        {
          method: "PUT",
          routePattern: "/projects/{projectID}/env/{name}",
          params: { projectID: p.id, name: "API_KEY" },
          body: { value, secret: true },
        },
        keys.owner,
      ),
    );
    expect(reply.status).toBe(400);
    expect((await jsonOf(reply)).error).toBe("link: value does not open with this core's key");
  });

  it("refuses a box sealed for another field, route, project, name or core", async () => {
    const h = await harness();
    const p = (await h.call("POST", "/projects", { name: "shop" })).json;
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const state = h.store.getLinkState()!;
    const other = (await h.call("POST", "/projects", { name: "blog" })).json;
    const here = {
      coreId: state.coreId,
      route: "PUT /projects/{projectID}/env/{name}",
      path: `/projects/${p.id}/env/API_KEY`,
      field: "value",
    };
    // The control: sealed for exactly here, it opens.
    const ok = await d.dispatch(
      await signed(
        {
          method: "PUT",
          routePattern: "/projects/{projectID}/env/{name}",
          params: { projectID: p.id, name: "API_KEY" },
          body: { value: await sealTo(state.encryptionPublic, "right-value", here), secret: true },
        },
        keys.owner,
      ),
    );
    expect(ok.status).toBe(200);
    for (const moved of [
      { ...here, field: "values" },
      { ...here, route: "PUT /workspace/env/{name}" },
      { ...here, coreId: "core_elsewhere" },
      { ...here, path: `/projects/${other.id}/env/API_KEY` },
      { ...here, path: `/projects/${p.id}/env/OTHER_KEY` },
    ]) {
      const value = await sealTo(state.encryptionPublic, "moved-value", moved);
      const reply = await d.dispatch(
        await signed(
          {
            method: "PUT",
            routePattern: "/projects/{projectID}/env/{name}",
            params: { projectID: p.id, name: "API_KEY" },
            body: { value, secret: true },
          },
          keys.owner,
        ),
      );
      expect(reply.status).toBe(400);
      expect((await jsonOf(reply)).error).toBe("link: value does not open with this core's key");
    }
    expect(h.store.resolveEnv(p.id).vars.API_KEY).toBe("right-value");
  });

  it("refuses a box in the old sealed format (v1)", async () => {
    const h = await harness();
    const p = (await h.call("POST", "/projects", { name: "shop" })).json;
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const state = h.store.getLinkState()!;
    const box = await sealTo(state.encryptionPublic, "old-value", {
      coreId: state.coreId,
      route: "PUT /projects/{projectID}/env/{name}",
      path: `/projects/${p.id}/env/API_KEY`,
      field: "value",
    });
    const reply = await d.dispatch(
      await signed(
        {
          method: "PUT",
          routePattern: "/projects/{projectID}/env/{name}",
          params: { projectID: p.id, name: "API_KEY" },
          body: { value: { $sealed: { ...box.$sealed, v: 1 } }, secret: true },
        },
        keys.owner,
      ),
    );
    expect(reply.status).toBe(400);
    expect((await jsonOf(reply)).error).toBe("link: value is in the old sealed format (v1); seal it again");
    expect(h.store.resolveEnv(p.id).vars.API_KEY).toBeUndefined();
  });

  it("refuses a $sealed box at an undeclared path", async () => {
    const h = await harness();
    const p = (await h.call("POST", "/projects", { name: "shop" })).json;
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const box = await sealTo(h.store.getLinkState()!.encryptionPublic, "x", {
      coreId: h.store.getLinkState()!.coreId,
      route: "PATCH /projects/{projectID}/settings",
      path: `/projects/${p.id}/settings`,
      field: "buildCommand",
    });
    const reply = await d.dispatch(
      await signed(
        {
          method: "PATCH",
          routePattern: "/projects/{projectID}/settings",
          params: { projectID: p.id },
          body: { buildCommand: box },
        },
        keys.owner,
      ),
    );
    expect(reply.status).toBe(400);
    expect((await jsonOf(reply)).error).toBe("link: buildCommand is sealed where this route takes no sealed value");
  });

  it("refuses a build of another repository", async () => {
    const h = await harness();
    const p = (await h.call("POST", "/projects", { name: "shop" })).json;
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const reply = await d.dispatch(
      await signed({
        method: "POST",
        routePattern: "/projects/{projectID}/builds",
        params: { projectID: p.id },
        body: { repo: "https://example.com/other.git" },
      }),
    );
    expect(reply.status).toBe(400);
    expect((await jsonOf(reply)).error).toBe("link: repo can't be sent over the link");
    expect(h.store.listBuilds(p.id)).toEqual([]);
  });

  it("refuses a manual Cloud Run choice for a new environment and a transfer", async () => {
    const h = await harness();
    const p = (await h.call("POST", "/projects", { name: "shop" })).json;
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const manual = {
      target: "cloudrun",
      mode: "manual",
      project: "my-proj-1",
      region: "us-east1",
      arRepo: "us-east1-docker.pkg.dev/my-proj-1/nbo",
    };
    // A custom environment is Tier 2: an Admin's signature gets it past the
    // tier check, and the field filter still refuses the manual choice.
    const stage = await d.dispatch(
      await signed(
        {
          method: "POST",
          routePattern: "/projects/{projectID}/stages",
          params: { projectID: p.id },
          body: { name: "staging", branch: "staging", clouds: [manual] },
        },
        keys.admin,
      ),
    );
    expect(stage.status).toBe(400);
    expect((await jsonOf(stage)).error).toBe("link: clouds.0.project can't be sent over the link");
    expect(h.store.listStages(p.id).some((s) => s.name === "staging")).toBe(false);
    const transfer = await d.dispatch(
      await signed({
        method: "POST",
        routePattern: "/projects/{projectID}/transfer",
        params: { projectID: p.id },
        body: manual,
      }),
    );
    expect(transfer.status).toBe(400);
    expect((await jsonOf(transfer)).error).toBe("link: project can't be sent over the link");
  });

  it("GET /projects/{id}/git over the link has no webhookSecret", async () => {
    const h = await harness();
    const setup = await h.call("POST", "/projects", { name: "shop" });
    const id = setup.json.id;
    const put = await h.call("PUT", `/projects/${id}/git`, {
      repo: "https://github.com/acme/storefront.git",
      productionBranch: "main",
      framework: "static",
      buildCommand: "true",
      outputDir: "dist",
    });
    expect(put.status).toBe(200);
    const secret = put.json.webhookSecret as string;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const reply = await d.dispatch(
      await signed({ method: "GET", routePattern: "/projects/{projectID}/git", params: { projectID: id } }),
    );
    expect(reply.status).toBe(200);
    const text = await bodyOf(reply);
    expect(text).not.toContain(secret);
    expect(JSON.parse(text).webhookSecret).toBeUndefined();
  });

  it("marks the request as a link request and keeps its signer", async () => {
    const store = await bareStore();
    let marks: unknown[] = [];
    const d = createDispatcher({
      ...noSecrets,
      store,
      mux: stubMux(async (request) => {
        marks = [isLinkRequest(request), isTokenRequest(request), linkSignerOf(request), new URL(request.url).host];
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    });
    expect((await d.dispatch(await signed({}))).status).toBe(200);
    expect(marks).toEqual([true, true, "platform", "link.invalid"]);
  });

  it("journals refusals and successes with tier and signer", async () => {
    const h = await harness();
    const d = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
    const ok = await signed({ method: "GET", routePattern: "/projects" });
    await d.dispatch(ok);
    await d.dispatch(await signed({ method: "GET", routePattern: "/system/api-tokens" }));
    const k8s = await signed(
      {
        method: "POST",
        routePattern: "/system/connections/kubernetes",
        body: { name: "a", source: { kubeconfig: "x" } },
      },
      keys.owner,
    );
    await d.dispatch(k8s);
    const rows = h.store.listJournal({ limit: 10 });
    expect(rows).toHaveLength(3);
    const byNonce = (n: string) => rows.find((r) => r.nonce === n)!;
    expect(byNonce(ok.envelope.nonce)).toMatchObject({
      accepted: true,
      tier: 0,
      signedBy: "platform",
      status: 200,
      reason: "",
      route: "/projects",
      method: "GET",
    });
    expect(rows.find((r) => r.route === "/system/api-tokens")).toMatchObject({
      accepted: false,
      status: 403,
      reason: "route is not allowed over the link: GET /system/api-tokens",
    });
    expect(byNonce(k8s.envelope.nonce)).toMatchObject({
      accepted: true,
      tier: 2,
      signedBy: `${keys.owner.memberId}/${keys.owner.keyId}`,
      status: 400,
      reason: "source.kubeconfig must be sealed to this core's key",
    });
  });

  it("runs the handler once for the same instruction sent twice at the same time", async () => {
    const store = await bareStore();
    let runs = 0;
    const d = createDispatcher({
      ...noSecrets,
      store,
      mux: stubMux(async () => {
        runs++;
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    });
    const i = await signed({});
    const replies = await Promise.all([d.dispatch(i), d.dispatch(structuredClone(i))]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(runs).toBe(1);
    const refused = replies.find((r) => r.status === 409)!;
    expect((await jsonOf(refused)).error).toBe("link: instruction was already received");
    expect(store.listJournal({ limit: 10 }).filter((r) => r.accepted)).toHaveLength(1);
  });

  it("refuses with 409 when the journal already holds the accepted nonce (both passed verify)", async () => {
    const store = await bareStore();
    // As when two copies are verified at the same time: neither sees the other's row.
    store.journalHas = () => false;
    let runs = 0;
    const d = createDispatcher({
      ...noSecrets,
      store,
      mux: stubMux(async () => {
        runs++;
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    });
    const i = await signed({});
    expect((await d.dispatch(i)).status).toBe(200);
    const again = await d.dispatch(i);
    expect(again.status).toBe(409);
    expect((await jsonOf(again)).error).toBe("link: instruction was already received");
    expect(runs).toBe(1);
    const rows = store.listJournal({ limit: 10 });
    expect(rows.filter((r) => r.accepted)).toHaveLength(1);
    expect(rows.find((r) => !r.accepted)).toMatchObject({ status: 409, tier: 0, signedBy: "platform" });
  });

  it("refuses a 17th concurrent instruction with 429", async () => {
    const store = await bareStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = 0;
    const d = createDispatcher({
      ...noSecrets,
      store,
      mux: stubMux(async () => {
        entered++;
        await gate;
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    });
    const running = await Promise.all(Array.from({ length: 16 }, () => signed({}))).then((is) =>
      is.map((i) => d.dispatch(i)),
    );
    await vi.waitFor(() => expect(entered).toBe(16));
    const busy = await d.dispatch(await signed({}));
    expect(busy.status).toBe(429);
    expect((await jsonOf(busy)).error).toBe("link: core is busy");
    release();
    expect((await Promise.all(running)).map((r) => r.status)).toEqual(Array(16).fill(200));
    expect((await d.dispatch(await signed({}))).status).toBe(200);
  });

  it("answers 500 without the exception's text when a handler throws", async () => {
    const store = await bareStore();
    const d = createDispatcher({
      ...noSecrets,
      store,
      mux: stubMux(async () => {
        throw new Error("boom with body data hunter2");
      }),
    });
    const i = await signed({});
    const reply = await d.dispatch(i);
    expect(reply.status).toBe(500);
    const text = await bodyOf(reply);
    expect(JSON.parse(text).error).toBe("link: internal error");
    expect(text).not.toContain("hunter2");
    expect(store.listJournal({ limit: 5 }).find((r) => r.nonce === i.envelope.nonce)).toMatchObject({
      status: 500,
      reason: "internal error",
    });
  });

  it("never rejects on a malformed instruction", async () => {
    const store = await bareStore();
    const d = createDispatcher({ ...noSecrets, store, mux: stubMux(async () => new Response("{}", { status: 200 })) });
    for (const bad of [null, {}, { envelope: null }, { envelope: { params: 5 } }] as never[]) {
      const reply = await d.dispatch(bad);
      expect(reply.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("streams a reply that is not JSON in chunks of at most 64 KiB", async () => {
    const store = await bareStore();
    const text = "log line\n".repeat(20_000);
    const d = createDispatcher({
      ...noSecrets,
      store,
      mux: stubMux(async () => new Response(text, { status: 200, headers: { "content-type": "text/plain" } })),
    });
    const reply = await d.dispatch(await signed({}));
    expect(reply.kind).toBe("stream");
    if (reply.kind !== "stream") return;
    const parts: Uint8Array[] = [];
    for await (const c of reply.chunks) parts.push(c);
    expect(parts.every((p) => p.length <= 64 * 1024)).toBe(true);
    expect(Buffer.concat(parts).toString("utf8")).toBe(text);
  });

  it("withholds keys in a JSON answer over 256 KiB", async () => {
    const store = await bareStore();
    const big = { items: Array.from({ length: 30_000 }, (_, n) => ({ name: `VAR_${n}`, deep: { value: "ab" } })) };
    const d = createDispatcher({
      ...noSecrets,
      store,
      mux: stubMux(
        async () => new Response(JSON.stringify(big), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    });
    const reply = await d.dispatch(await signed({}));
    expect(reply.kind).toBe("stream");
    if (reply.kind !== "stream") return;
    const parts: Uint8Array[] = [];
    for await (const c of reply.chunks) parts.push(c);
    expect(parts.every((p) => p.length <= 64 * 1024)).toBe(true);
    const text = Buffer.concat(parts).toString("utf8");
    expect(JSON.parse(text).items[29_999]).toEqual({ name: "VAR_29999", deep: { value: "[withheld over the link]" } });
    expect(text).not.toContain(JSON.stringify("ab"));
  });

  it("answers 502 for a JSON answer over 5 MiB", async () => {
    const store = await bareStore();
    const huge = JSON.stringify({ blob: "x".repeat(5 * 1024 * 1024 + 10) });
    const d = createDispatcher({
      ...noSecrets,
      store,
      mux: stubMux(async () => new Response(huge, { status: 200, headers: { "content-type": "application/json" } })),
    });
    const i = await signed({});
    const reply = await d.dispatch(i);
    expect(reply.status).toBe(502);
    expect((await jsonOf(reply)).error).toBe("link: answer too large");
    expect(store.listJournal({ limit: 5 }).find((r) => r.nonce === i.envelope.nonce)).toMatchObject({
      status: 502,
      reason: "answer too large",
    });
  });

  it("refuses a 33rd open stream with 429 and frees a slot when a stream ends", async () => {
    const store = await bareStore();
    const endless = () =>
      new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const d = createDispatcher({ ...noSecrets, store, mux: stubMux(async () => endless()) });
    const open: LinkReply[] = [];
    for (let n = 0; n < 32; n++) {
      const r = await d.dispatch(await signed({}));
      expect(r.kind, String(n)).toBe("stream");
      open.push(r);
    }
    const refused = await d.dispatch(await signed({}));
    expect(refused.status).toBe(429);
    expect((await jsonOf(refused)).error).toBe("link: too many open streams");
    const first = open[0]!;
    if (first.kind !== "stream") return;
    await first.chunks[Symbol.asyncIterator]().return?.();
    expect((await d.dispatch(await signed({}))).kind).toBe("stream");
    for (const r of open) if (r.kind === "stream") await r.chunks[Symbol.asyncIterator]().return?.();
  });

  it("ends a stream that sends nothing for the idle time with error idle", async () => {
    const store = await bareStore();
    const d = createDispatcher({
      ...noSecrets,
      store,
      streamIdleMs: 50,
      maxStreams: 1,
      mux: stubMux(
        async () =>
          new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }), {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      ),
    });
    const reply = await d.dispatch(await signed({}));
    if (reply.kind !== "stream") throw new Error("expected a stream");
    await expect(reply.chunks[Symbol.asyncIterator]().next()).rejects.toThrow("idle");
    // Its slot is free again.
    const next = await d.dispatch(await signed({}));
    expect(next.kind).toBe("stream");
    if (next.kind === "stream") await next.chunks[Symbol.asyncIterator]().return?.();
  });

  it("streams a JSON reply of 256 KiB or more", async () => {
    const store = await bareStore();
    const big = JSON.stringify({ items: Array.from({ length: 30_000 }, (_, n) => `item-${n}`) });
    expect(big.length).toBeGreaterThan(256 * 1024);
    const d = createDispatcher({
      ...noSecrets,
      store,
      mux: stubMux(async () => new Response(big, { status: 200, headers: { "content-type": "application/json" } })),
    });
    const reply = await d.dispatch(await signed({}));
    expect(reply.kind).toBe("stream");
    expect(await bodyOf(reply)).toBe(big);
  });
});
