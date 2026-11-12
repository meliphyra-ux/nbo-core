// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// A fake Google for tests only: one node:http server on 127.0.0.1 standing in
// for accounts.google.com (the authorization page), oauth2.googleapis.com
// (the token endpoint) and Google's JWKS. NBO_GOOGLE_AUTH_URL,
// NBO_GOOGLE_TOKEN_URL and NBO_GOOGLE_JWKS_URL point at it. Never started
// outside tests.
//
// GET /auth "signs the person in" at once: it records the request (client id,
// redirect URI, PKCE challenge, state) and redirects back to redirect_uri with
// a one-time code. POST /token checks the client secret, the code, the exact
// redirect URI and the PKCE verifier, then answers an ID token signed RS256
// with the fake's key (published at GET /jwks). Each test sets the claims of
// the next sign-in with `nextClaims`, and can sign with another key or not at
// all (`signWith`).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

export interface FakeTokenCall {
  form: Record<string, string>;
}

export interface FakeAuthCall {
  query: Record<string, string>;
}

export interface FakeGoogle {
  url: string;
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  clientId: string;
  clientSecret: string;
  // Claims merged over the defaults for the next code /auth issues.
  nextClaims: Record<string, unknown>;
  // "good": the published key; "other": a key not in the JWKS; "none": alg none.
  signWith: "good" | "other" | "none";
  authCalls: FakeAuthCall[];
  tokenCalls: FakeTokenCall[];
  jwksFetches: number;
  // approve follows NBO's authorization redirect the way a browser would and
  // returns the callback URL Google sends the browser back to.
  approve(authorizeUrl: string): Promise<URL>;
  // idToken builds a signed ID token with these claims (for direct tests).
  idToken(claims: Record<string, unknown>, signWith?: FakeGoogle["signWith"]): string;
  close(): Promise<void>;
}

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "fake-key-1";
  const codes = new Map<string, { challenge: string; method: string; redirectUri: string; clientId: string; claims: Record<string, unknown>; signWith: FakeGoogle["signWith"] }>();

  const makeToken = (claims: Record<string, unknown>, signWith: FakeGoogle["signWith"]): string => {
    if (signWith === "none") return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
    const key: KeyObject = signWith === "other" ? other.privateKey : good.privateKey;
    const input = `${b64({ alg: "RS256", kid, typ: "JWT" })}.${b64(claims)}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
  };

  const fake = {
    url: "",
    authUrl: "",
    tokenUrl: "",
    jwksUrl: "",
    clientId: "fake-client.apps.googleusercontent.com",
    clientSecret: `fake-secret-${randomBytes(8).toString("hex")}`,
    nextClaims: {},
    signWith: "good",
    authCalls: [],
    tokenCalls: [],
    jwksFetches: 0,
  } as unknown as FakeGoogle;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.method === "GET" && url.pathname === "/jwks") {
      fake.jwksFetches++;
      const jwk = good.publicKey.export({ format: "jwk" });
      return send(res, 200, { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }, { "cache-control": "public, max-age=3600" });
    }
    if (req.method === "GET" && url.pathname === "/auth") {
      const query = Object.fromEntries(url.searchParams);
      fake.authCalls.push({ query });
      if (query.response_type !== "code" || !query.redirect_uri || !query.state) return send(res, 400, { error: "invalid_request" });
      const code = randomBytes(16).toString("hex");
      const now = Math.floor(Date.now() / 1000);
      codes.set(code, {
        challenge: query.code_challenge ?? "",
        method: query.code_challenge_method ?? "",
        redirectUri: query.redirect_uri,
        clientId: query.client_id ?? "",
        signWith: fake.signWith,
        claims: {
          iss: "https://accounts.google.com",
          aud: query.client_id,
          azp: query.client_id,
          sub: "100000000000000000001",
          email: "ada@example.com",
          email_verified: true,
          name: "Ada",
          picture: "https://lh3.example.com/ada.png",
          iat: now,
          exp: now + 3600,
          ...fake.nextClaims,
        },
      });
      const back = new URL(query.redirect_uri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", query.state);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      fake.tokenCalls.push({ form });
      const grant = codes.get(form.code ?? "");
      if (form.grant_type !== "authorization_code" || !grant) return send(res, 400, { error: "invalid_grant" });
      codes.delete(form.code!);
      if (form.client_id !== fake.clientId || form.client_secret !== fake.clientSecret || grant.clientId !== fake.clientId) return send(res, 401, { error: "invalid_client" });
      if (form.redirect_uri !== grant.redirectUri) return send(res, 400, { error: "redirect_uri_mismatch" });
      const verifier = form.code_verifier ?? "";
      if (grant.method !== "S256" || createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return send(res, 400, { error: "invalid_grant" });
      return send(res, 200, { access_token: `ya29.${randomBytes(8).toString("hex")}`, token_type: "Bearer", expires_in: 3599, id_token: makeToken(grant.claims, grant.signWith) });
    }
    send(res, 404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.url = base;
  fake.authUrl = `${base}/auth`;
  fake.tokenUrl = `${base}/token`;
  fake.jwksUrl = `${base}/jwks`;
  fake.approve = async (authorizeUrl: string) => {
    const res = await fetch(authorizeUrl, { redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status !== 302 || !location) throw new Error(`fake Google refused the authorization request: ${res.status} ${await res.text()}`);
    return new URL(location);
  };
  fake.idToken = (claims, signWith = "good") => makeToken(claims, signWith);
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}
