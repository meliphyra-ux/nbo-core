// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { ErrDuplicateName, ErrInvalid, ErrNotFound } from "./errors.js";
import type { Store } from "./store.js";
import type { Router } from "./router.js";
import type { Access } from "./access.js";
import { isPublicHost } from "./public-url.js";

// API tokens let a program (a Terraform provider, CI) use the project-level
// API from outside loopback. A token is "nbo_" plus 32 random bytes in hex;
// only its sha256 is stored, so the secret exists once, in the create answer.
// user_id and role are added by migrate.ts's addedColumns. Core writes ''
// and 'admin'; a database that once had sign-in on (a platform feature now)
// can hold tokens made for members, with that member's id and a role, which
// guardRequest reads so a token made for a Viewer never gains power.
export const apiTokensSchema = `
CREATE TABLE IF NOT EXISTS api_tokens (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	prefix TEXT NOT NULL,
	hash TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL,
	last_used_at TEXT NOT NULL DEFAULT ''
);
`;

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string;
  // Read only: the member a token was made for while sign-in was on ("" for
  // core's own tokens) and the role it was made with ('admin' for core's).
  userId: string;
  role: TokenRole;
}

export type TokenRole = "viewer" | "developer" | "admin" | "owner";
const tokenRoles: readonly string[] = ["viewer", "developer", "admin", "owner"];

interface Row {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string;
  user_id: string;
  role: string;
}

const TOUCH_INTERVAL_MS = 60_000;
const tokenShape = /^nbo_[0-9a-f]{64}$/;

const hashOf = (secret: string): string => createHash("sha256").update(secret).digest("hex");

function toToken(r: Row): ApiToken {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    userId: r.user_id ?? "",
    // An unknown stored role fails closed: the least a member can do.
    role: tokenRoles.includes(r.role) ? (r.role as TokenRole) : "viewer",
  };
}

// The answer shape for the token routes: never the hash, the owner or the role.
function publicView(t: ApiToken): Omit<ApiToken, "userId" | "role"> {
  return { id: t.id, name: t.name, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt };
}

// attachApiTokenMethods mutates store in place, like attachDomainMethods.
export function attachApiTokenMethods(db: DatabaseSync, store: Store): Store {
  // Last write per token, in memory, so most requests never touch the database.
  const lastTouched = new Map<string, number>();
  Object.assign(store, {
    // createApiToken makes an ownerless admin token, the only kind core makes.
    createApiToken(name: string): { token: ApiToken; secret: string } {
      if (typeof name !== "string" || name.length < 1 || name.length > 60) throw new ErrInvalid("name must be 1 to 60 characters");
      const secret = `nbo_${randomBytes(32).toString("hex")}`;
      const id = `tok_${randomBytes(8).toString("hex")}`;
      try {
        db.prepare("INSERT INTO api_tokens (id, name, prefix, hash, created_at, user_id, role) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          id,
          name,
          secret.slice(4, 12),
          hashOf(secret),
          new Date().toISOString(),
          "",
          "admin",
        );
      } catch (err) {
        if (err instanceof Error && /UNIQUE/i.test(err.message)) throw new ErrDuplicateName(`an API token named "${name}" already exists`);
        throw err;
      }
      const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as unknown as Row;
      return { token: toToken(row), secret };
    },
    listApiTokens(): ApiToken[] {
      return (db.prepare("SELECT * FROM api_tokens ORDER BY created_at, id").all() as unknown as Row[]).map(toToken);
    },
    deleteApiToken(id: string): void {
      const res = db.prepare("DELETE FROM api_tokens WHERE id = ?").run(id);
      if (Number(res.changes) === 0) throw new ErrNotFound(`API token "${id}"`);
    },
    findApiToken(secret: string): ApiToken | null {
      if (!tokenShape.test(secret)) return null;
      const row = db.prepare("SELECT * FROM api_tokens WHERE hash = ?").get(hashOf(secret)) as Row | undefined;
      return row ? toToken(row) : null;
    },
    touchApiToken(id: string): void {
      const now = Date.now();
      const last = lastTouched.get(id);
      if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
      lastTouched.set(id, now);
      // Bookkeeping only: a failed write must never fail the request.
      try {
        db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(new Date(now).toISOString(), id);
      } catch {
        // ignored on purpose
      }
    },
  });
  return store;
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const loopbackHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const loopbackOrigin = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// isLoopbackRequest keeps the loopback-only boundary real for browsers.
// A web page the operator visits can't read this API's responses (no CORS
// headers), but it CAN send "simple" cross-site POSTs, and /projects/setup
// runs a build command. Browsers always send Origin on cross-site POSTs, so
// any Origin that isn't a loopback http origin is refused; a Host that isn't
// loopback means DNS rebinding and is refused too. Requests with neither
// header (curl, the CLI, tests) are server-to-server.
export function isLoopbackRequest(request: Request): boolean {
  const host = request.headers.get("host");
  if (host !== null && !loopbackHost.test(host)) return false;
  const origin = request.headers.get("origin");
  if (origin !== null && !loopbackOrigin.test(origin)) return false;
  return true;
}

// segmentsOf resolves a path the way an attacker might spell it: percent-
// decoded (repeatedly, so %2573 can't hide an "s"), lowercased, backslash as
// slash, slashes collapsed, dot segments resolved. null means it can't be
// decoded honestly, which callers treat as "refuse".
function segmentsOf(path: string): string[] | null {
  let p = path;
  for (let i = 0; ; i++) {
    if (i === 5) return null;
    let next: string;
    try {
      next = decodeURIComponent(p);
    } catch {
      return null;
    }
    if (next === p) break;
    p = next;
  }
  const stack: string[] = [];
  for (const seg of p.toLowerCase().replace(/[\\]/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack;
}

// reachesUnder: could this path be under /<top>? Fails closed.
function reachesUnder(path: string, top: string): boolean {
  const stack = segmentsOf(path);
  if (!stack) return true;
  const first = path.toLowerCase().replace(/[\\]/g, "/").split("/").find((s) => s !== "" && s !== ".");
  return stack[0] === top || first === top;
}

// Tokens never reach /system (connections, the edge, tokens) or /auth (kept
// refused though core has no /auth route, so nothing added there opens).
const reachesSystem = (path: string): boolean => reachesUnder(path, "system");
const reachesAuth = (path: string): boolean => reachesUnder(path, "auth");

// isLegacyRoute: the two routes that take raw paths or unchecked cloud
// settings. Fails closed like reachesSystem.
function isLegacyRoute(path: string): boolean {
  const s = segmentsOf(path);
  if (!s) return true;
  return s.length === 3 && ((s[0] === "environments" && s[2] === "deployments") || (s[0] === "projects" && s[2] === "environments"));
}

const tokenRequests = new WeakSet<Request>();

// isTokenRequest: did guardRequest accept this request on the strength of a
// token? Handlers leave secrets out of the answer when it did.
export function isTokenRequest(request: Request): boolean {
  return tokenRequests.has(request);
}

const BEARER = /^Bearer (\S+)$/i;

// checkToken decides a request that carries an Authorization header: the
// token must be ours (401 otherwise), and no token may use /system/*,
// /auth/* or the two legacy routes (403). An accepted request is marked
// (isTokenRequest) and the token's last use recorded.
export function checkToken(request: Request, path: string, store: Store): Response | ApiToken {
  const m = BEARER.exec(request.headers.get("authorization") ?? "");
  const token = m ? store.findApiToken(m[1]!) : null;
  if (!token) return json({ error: "invalid API token" }, 401);
  if (reachesSystem(path) || reachesAuth(path) || isLegacyRoute(path)) return json({ error: "API tokens can't use this route" }, 403);
  tokenRequests.add(request);
  store.touchApiToken(token.id);
  return token;
}

// guardRequest is the one request guard, used by createMux. null means go
// on. level is the matched route's row in access.ts (undefined when no route
// matched). Without an Authorization header the loopback rule applies as it
// always has, and a route whose row is "webhook" also passes on the public
// address (NBO_PUBLIC_URL, any spelling of its name): its signature is its
// authentication. With a header (outside webhook routes) the token must be ours (401 even from
// loopback, so a typo isn't hidden by the open loopback access), and a valid
// token may use any route except /system/*, /auth/* and the two legacy
// routes, whatever the Host and Origin: a browser never sends a token by
// itself. A token made for a member below Admin while sign-in was on is 401:
// core has no roles, and such a token must not become an all-powerful one.
export function guardRequest(request: Request, path: string, store: Store, publicUrl?: URL, level?: Access): Response | null {
  const header = request.headers.get("authorization");
  // A webhook sender may carry its own Authorization header; it is not read.
  const webhook = level === "webhook";
  if (header === null || webhook) {
    if (isLoopbackRequest(request)) return null;
    if (webhook && isPublicHost(request, publicUrl)) return null;
    if (isPublicHost(request, publicUrl)) return json({ error: "request refused: on NBO's public address only API tokens and webhooks are accepted" }, 403);
    return json({ error: "request refused: the control-plane only accepts loopback callers" }, 403);
  }
  const checked = checkToken(request, path, store);
  if (checked instanceof Response) return checked;
  if (checked.role !== "admin" && checked.role !== "owner") {
    return json({ error: "this API token was made for a member below Admin while sign-in was on; make a new token with nbo-server token create" }, 401);
  }
  return null;
}

// The token routes are local (access.ts): loopback only, no token. Every
// token is listed and any can be revoked; a new one is an ownerless admin
// token (a role in the body is ignored).
export function registerApiTokenRoutes(router: Router, store: Store): void {
  router.handle("GET", "/system/api-tokens", async () => json(store.listApiTokens().map(publicView), 200));
  router.handle("POST", "/system/api-tokens", async (request) => {
    let name: unknown;
    try {
      name = ((await request.json()) as { name?: unknown } | null)?.name;
    } catch {
      return json({ error: "name is required" }, 400);
    }
    if (typeof name !== "string" || name.trim() === "") return json({ error: "name is required" }, 400);
    try {
      const { token, secret } = store.createApiToken(name.trim());
      return json({ ...publicView(token), token: secret }, 201);
    } catch (err) {
      if (err instanceof ErrDuplicateName) return json({ error: err.message }, 409);
      if (err instanceof ErrInvalid) return json({ error: err.message }, 400);
      throw err;
    }
  });
  router.handle("DELETE", "/system/api-tokens/{id}", async (_request, params) => {
    try {
      store.deleteApiToken(params.id!);
      return new Response(null, { status: 204 });
    } catch (err) {
      if (err instanceof ErrNotFound) return json({ error: err.message }, 404);
      throw err;
    }
  });
}
