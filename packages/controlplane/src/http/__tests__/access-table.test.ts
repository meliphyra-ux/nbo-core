// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { startHarness, deployedProject, noCommands, bearer, type Harness } from "../../__tests__/v2-harness.js";
import { routeAccess, routeLinkTier } from "../access.js";
import { checkToken } from "../api-tokens.js";
import { parsePublicUrl } from "../public-url.js";
import { startFakeGitHub, type FakeApp, type FakeGitHub } from "../../__tests__/fake-github.js";

const LEVELS = ["public", "webhook", "token", "local"];
const REFUSED = { error: "API tokens can't use this route" };
const PUBLIC = "nbo.example.com";
// A refusal the gate (not a handler) answers with.
const isGateBody = (json: any): boolean =>
  json !== null &&
  typeof json === "object" &&
  typeof json.error === "string" &&
  /^(API tokens can't use this route|request refused|invalid API token|this API token was made)/.test(json.error);

const split = (key: string): [string, string] => {
  const i = key.indexOf(" ");
  return [key.slice(0, i), key.slice(i + 1)];
};

// The /system routes a linked platform may use, exactly as the allowlist
// lists them: 9 reads, 2 tests, 11 setup changes.
const LINK_SYSTEM_ROUTES = [
  "GET /system/preflight",
  "GET /system/connections",
  "GET /system/regions",
  "GET /system/regions/domain-mapping",
  "GET /system/edge",
  "GET /system/clusters/{id}/relay",
  "GET /system/connections/detect",
  "GET /system/connections/plan",
  "GET /system/connections/google/identity",
  "POST /system/connections/{kind}/test",
  "POST /system/connections/kubernetes/{id}/test",
  "POST /system/connections/google",
  "POST /system/connections/kubernetes",
  "PUT /system/connections/kubernetes/{id}",
  "DELETE /system/connections/kubernetes/{id}",
  "DELETE /system/connections/{kind}",
  "POST /system/clusters/{id}/relay",
  "POST /system/clusters/{id}/update-setup",
  "POST /system/edge/install",
  "POST /system/edge/reinstall",
  "PATCH /system/domains",
  "PATCH /system/workspace-settings",
];

describe("the link tier column", () => {
  it("gives every route a link tier and nothing else", () => {
    expect(Object.keys(routeLinkTier).sort()).toEqual(Object.keys(routeAccess).sort());
  });

  it("uses only 0, 1, 2, null or a tier function", () => {
    for (const [route, tier] of Object.entries(routeLinkTier)) {
      expect(tier === null || tier === 0 || tier === 1 || tier === 2 || typeof tier === "function", route).toBe(true);
    }
  });

  it("allows exactly the listed /system routes", () => {
    const allowed = Object.entries(routeLinkTier)
      .filter(([r, t]) => split(r)[1].startsWith("/system") && t !== null)
      .map(([r]) => r);
    expect(LINK_SYSTEM_ROUTES).toHaveLength(22);
    expect(allowed.sort()).toEqual([...LINK_SYSTEM_ROUTES].sort());
  });

  it("gives the /system reads tier 0, the tests tier 1 and the setup changes tier 2", () => {
    for (const r of LINK_SYSTEM_ROUTES.slice(0, 9)) expect(routeLinkTier[r], r).toBe(0);
    for (const r of LINK_SYSTEM_ROUTES.slice(9, 11)) expect(routeLinkTier[r], r).toBe(1);
    for (const r of LINK_SYSTEM_ROUTES.slice(11)) expect(routeLinkTier[r], r).toBe(2);
  });

  it("refuses every local row except those", () => {
    for (const [route, level] of Object.entries(routeAccess)) {
      if (level !== "local" || LINK_SYSTEM_ROUTES.includes(route)) continue;
      expect(routeLinkTier[route], route).toBeNull();
    }
  });

  it("refuses the webhook route", () => {
    for (const [route, level] of Object.entries(routeAccess))
      if (level === "webhook") expect(routeLinkTier[route], route).toBeNull();
    expect(routeLinkTier["POST /projects/{projectID}/webhooks/github"]).toBeNull();
  });

  it("refuses API tokens and the Terraform provider download", () => {
    for (const route of Object.keys(routeLinkTier)) {
      if (/\/system\/(api-tokens|terraform-provider)/.test(route)) expect(routeLinkTier[route], route).toBeNull();
    }
  });

  it("makes every write that is not allowed a read fail closed", () => {
    for (const [route, tier] of Object.entries(routeLinkTier)) {
      if (!route.startsWith("GET ")) expect(tier, route).not.toBe(0);
    }
  });
});

describe("the access table", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ v2: { run: noCommands } });
  });
  afterAll(async () => h.close());

  it("names every route the router registers, and nothing else", () => {
    const routes = h.mux.routes();
    expect(routes.length).toBeGreaterThan(60);
    expect(new Set(routes).size).toBe(routes.length);
    const table = Object.keys(routeAccess);
    expect(
      routes.filter((r) => !(r in routeAccess)),
      "routes with no level",
    ).toEqual([]);
    expect(
      table.filter((r) => !routes.includes(r)),
      "table rows with no route",
    ).toEqual([]);
    expect([...routes].sort()).toEqual([...table].sort());
  });

  it("uses only the four levels", () => {
    for (const [route, level] of Object.entries(routeAccess)) expect(LEVELS, route).toContain(level);
  });

  it("marks every /system/* row local", () => {
    const system = Object.entries(routeAccess).filter(([r]) => split(r)[1].startsWith("/system"));
    expect(system.length).toBeGreaterThan(20);
    for (const [route, level] of system) expect(level, route).toBe("local");
  });

  it("has no sign-in, member, audit or GitHub App row left", () => {
    for (const route of Object.keys(routeAccess)) {
      expect(route).not.toMatch(
        / \/auth|\/system\/(members|invites|audit|sign-in|github)|^[A-Z]+ \/github|\/projects\/\{projectID\}\/github$/,
      );
    }
  });

  it("is local exactly where the token check refuses by path", () => {
    const store = h.store;
    const { secret } = store.createApiToken("table-check");
    for (const [route, level] of Object.entries(routeAccess)) {
      const [method, pattern] = split(route);
      if (level === "public" || level === "webhook") continue;
      const path = pattern.replace(/\{[^}]+\}/g, "none");
      const out = checkToken(new Request(`http://localhost${path}`, { method, headers: bearer(secret) }), path, store);
      if (level === "local") expect(out instanceof Response && out.status === 403, route).toBe(true);
      else expect(out instanceof Response, route).toBe(false);
    }
  });
});

describe("every route answers each caller as the table says", () => {
  let h: Harness;
  let token: string;
  beforeAll(async () => {
    h = await startHarness({ v2: { run: noCommands, publicUrl: parsePublicUrl(`https://${PUBLIC}`) } });
    token = h.store.createApiToken("every-route").secret;
  });
  afterAll(async () => h.close());

  for (const [route, level] of Object.entries(routeAccess)) {
    const [method, pattern] = split(route);
    const path = pattern.replace(/\{[^}]+\}/g, "none");
    const body = method === "GET" ? undefined : "{}";

    it(`${route} (${level}): loopback, the public address, and a token`, async () => {
      const send = (host: string, headers: Record<string, string> = {}) =>
        h.mux(
          new Request(`http://${host}${path}`, {
            method,
            body,
            headers: { host, "content-type": "application/json", ...headers },
          }),
        );
      const read = async (res: Response) => {
        const text = await res.text();
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        return { status: res.status, json, text };
      };

      // Loopback with no token: the handler always runs.
      const loop = await read(await send("localhost:8081"));
      expect(isGateBody(loop.json), `loopback: ${loop.status} ${loop.text}`).toBe(false);

      // The public address with no token: only public and webhook routes run.
      const pub = await read(await send(PUBLIC));
      if (level === "public" || level === "webhook")
        expect(isGateBody(pub.json), `public: ${pub.status} ${pub.text}`).toBe(false);
      else {
        expect(pub.status, `public: ${pub.text}`).toBe(403);
        expect(isGateBody(pub.json), `public: ${pub.text}`).toBe(true);
      }

      // A token, from loopback and from the public address.
      for (const host of ["localhost:8081", PUBLIC]) {
        const res = await read(await send(host, bearer(token)));
        const said = `token on ${host}: ${res.status} ${res.text}`;
        if (level === "local") {
          expect(res.status, said).toBe(403);
          expect(res.json, said).toEqual(REFUSED);
        } else expect(isGateBody(res.json), said).toBe(false);
      }
    });
  }
});

describe("token answers hold no secret", () => {
  const SECRET_VALUE = "sekrit-project-value-7f3a";
  const WORKSPACE_SECRET = "sekrit-workspace-value-91c2";
  let h: Harness;
  let token: Record<string, string>;
  let ids: Record<string, string>;
  let webhookSecret: string;
  // The old per-server GitHub App's stored key, a project linked to it and
  // another project's HTTPS token: no token answer may hold any of them.
  let fake: FakeGitHub;
  let app: FakeApp;
  const GIT_TOKEN = "tok_access_table_5e1d";

  beforeAll(async () => {
    fake = await startFakeGitHub();
    h = await startHarness({ v2: { run: noCommands, githubApiUrl: fake.url } });
    h.store.setSecretKey(randomBytes(32));
    app = fake.createApp();
    const raw = new DatabaseSync(h.dbPath);
    raw
      .prepare("INSERT INTO server_settings (key, value) VALUES ('github_app', ?)")
      .run(JSON.stringify({ appId: app.id }));
    raw.close();
    h.store.setServerSecret("github_private_key", app.pem);
    h.store.setServerSecret("github_client_secret", app.clientSecret);
    h.store.setServerSecret("github_webhook_secret", app.webhookSecret);
    fake.addInstallation({ account: "acme" });
    const projectID = await deployedProject(h);
    h.store.setGitConfig(projectID, {
      ...h.store.getGitConfig(projectID),
      github: { installationId: 1, repoId: 2, fullName: "acme/storefront" },
    });
    const other = await deployedProject(h, { name: "other" });
    h.store.setGitCredential(other, { kind: "token", token: GIT_TOKEN });
    expect(
      (await h.call("PUT", `/projects/${projectID}/env/API_KEY`, { value: SECRET_VALUE, secret: true })).status,
    ).toBe(200);
    expect((await h.call("PUT", "/workspace/env/SHARED_KEY", { value: WORKSPACE_SECRET, secret: true })).status).toBe(
      200,
    );
    webhookSecret = h.store.ensureWebhookSecret(projectID);
    const env = h.store.listEnvironments(projectID)[0]!;
    const build = h.store.listBuilds(projectID)[0]!;
    ids = { projectID, environmentID: env.id, buildID: build.id };
    token = bearer(h.store.createApiToken("reader").secret);
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await fake.stop();
  });

  it("covers every token GET route with no secret value or webhook secret in it", async () => {
    const gets = Object.entries(routeAccess).filter(([r, l]) => l === "token" && r.startsWith("GET "));
    expect(gets.length).toBeGreaterThanOrEqual(17);
    for (const [route] of gets) {
      const path = split(route)[1].replace(/\{([^}]+)\}/g, (_, name: string) => {
        expect(ids[name], `no fixture id for {${name}}`).toBeDefined();
        return ids[name]!;
      });
      const res = await h.call("GET", path, undefined, token);
      expect([401, 403], `${route}: ${res.text}`).not.toContain(res.status);
      for (const secret of [
        SECRET_VALUE,
        WORKSPACE_SECRET,
        webhookSecret,
        app.pem,
        app.clientSecret,
        app.webhookSecret,
        GIT_TOKEN,
      ])
        expect(res.text, route).not.toContain(secret);
    }
  });
});
