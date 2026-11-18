// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { afterEach, describe, expect, it } from "vitest";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../../store/store.js";
import { createTestMux } from "../../__tests__/test-mux.js";
import { wireV2 } from "../../v2.js";
import { fakeCloudSetup, fakeDeploymentTrigger, fakeGoogleConnect, fakeKubeConnect } from "../../testing.js";
import { routeAccess, routeLinkTier } from "../../http/access.js";
import { LINK_ROUTE_TIERS } from "@nbo/link-protocol";
import { runServerCli, type ServerCliIO } from "../../server-cli.js";
import { filterJson, knownSecrets } from "../../link/filter.js";
import { googleAudience, googleIdentity, signGoogleToken } from "../google-identity.js";

const open: Store[] = [];
afterEach(() => {
  for (const s of open.splice(0)) {
    try {
      s.close();
    } catch {
      // closed
    }
  }
});

async function openStore(path?: string, key = randomBytes(32)) {
  const p = path ?? join(await mkdtemp(join(tmpdir(), "google-identity-")), "t.db");
  const store = createStore(p, { secretKey: key });
  open.push(store);
  return { store, path: p, key };
}

const ROUTE = "GET /system/connections/google/identity";

describe("google identity", () => {
  it("identity is created once and stable", async () => {
    const { store } = await openStore();
    const a = googleIdentity(store);
    const b = googleIdentity(store);
    expect(b).toEqual(a);
    expect(a.id).toMatch(/^[0-9a-f]{16}$/);
    expect(a.provider).toBe(`core-${a.id}`);
    expect(a.subject).toBe(`core-${a.id}`);
    expect(a.issuer).toBe(`https://core-${a.id}.nbo.invalid`);
  });

  it("jwks has exactly kty/alg/kid/use/n/e and kid is the RFC 7638 thumbprint", async () => {
    const { store } = await openStore();
    const id = googleIdentity(store);
    expect(id.jwks.keys).toHaveLength(1);
    const k = id.jwks.keys[0]!;
    expect(Object.keys(k).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    expect(k).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    const thumb = createHash("sha256")
      .update(JSON.stringify({ e: k.e, kty: "RSA", n: k.n }))
      .digest("base64url");
    expect(k.kid).toBe(thumb);
    expect(id.keyId).toBe(thumb);
  });

  it("token claims are exact and the signature verifies", async () => {
    const { store } = await openStore();
    const id = googleIdentity(store);
    const aud = googleAudience("123456", id.provider);
    expect(aud).toBe(
      `//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/nbo-cores/providers/${id.provider}`,
    );
    const jwt = signGoogleToken(store, aud, 1_800_000_000);
    const [h, c, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", kid: id.keyId, typ: "JWT" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
      iss: id.issuer,
      sub: id.subject,
      aud,
      iat: 1_799_999_940,
      exp: 1_800_003_600,
    });
    const pub = createPublicKey({ key: id.jwks.keys[0]!, format: "jwk" });
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${c}`), pub, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("identity survives a reopen of the store with the same secret key", async () => {
    const { store, path, key } = await openStore();
    const a = googleIdentity(store);
    store.close();
    const again = await openStore(path, key);
    expect(googleIdentity(again.store)).toEqual(a);
  });

  it("route is tier 0 and local in every table", () => {
    expect(routeAccess[ROUTE]).toBe("local");
    expect(routeLinkTier[ROUTE]).toBe(0);
    expect(LINK_ROUTE_TIERS[ROUTE]).toBe(0);
  });

  it("the private key never appears in the route, the CLI or the stored rows", async () => {
    const { store, path } = await openStore();
    const deploys = fakeDeploymentTrigger(store);
    const v2 = wireV2(store, {
      mode: "dev" as never,
      deploymentTrigger: deploys,
      cloudSetup: fakeCloudSetup(),
      edgeAdminUrl: "http://127.0.0.1:1",
      edgePublicPort: 9443,
      googleConnect: fakeGoogleConnect(store),
      kubeConnect: fakeKubeConnect(store),
    });
    const mux = createTestMux(store, deploys, v2.queue, v2);
    const res = await mux(new Request("http://cp/system/connections/google/identity"));
    const text = await res.text();
    expect(res.status).toBe(200);
    const id = googleIdentity(store);
    expect(JSON.parse(text)).toEqual({
      issuer: id.issuer,
      subject: id.subject,
      provider: id.provider,
      keyId: id.keyId,
      jwks: id.jwks,
    });
    const pem = (store as never as { getServerSecret(n: string): string }).getServerSecret("google_identity_key");
    const body = pem.split("\n").slice(1, -2).join("");
    expect(pem).toContain("PRIVATE KEY");
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain(body);

    const out: string[] = [];
    const io: ServerCliIO = {
      fetch: (async () =>
        new Response(text, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
      readFile: async () => "",
      stdin: async () => "",
      env: {},
    };
    expect(await runServerCli(["google", "identity"], io)).toBe(0);
    const printed = out.join("\n");
    expect(JSON.parse(printed)).toEqual({
      issuer: id.issuer,
      subject: id.subject,
      provider: id.provider,
      keyId: id.keyId,
    });

    store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    const rows = JSON.stringify(db.prepare("SELECT key, value FROM server_settings").all());
    db.close();
    expect(rows).not.toContain("PRIVATE KEY");
    expect(rows).not.toContain(body);
  });

  it("the link filter keeps the public identity and redacts the private key", async () => {
    const { store } = await openStore();
    const id = googleIdentity(store);
    const secrets = knownSecrets(store);
    const body = { issuer: id.issuer, subject: id.subject, provider: id.provider, keyId: id.keyId, jwks: id.jwks };
    expect(filterJson(body, secrets)).toEqual(body);
    const pem = (store as never as { getServerSecret(n: string): string }).getServerSecret("google_identity_key");
    expect(JSON.stringify(filterJson({ leaked: pem }, secrets))).not.toContain("PRIVATE KEY");
  });
});
