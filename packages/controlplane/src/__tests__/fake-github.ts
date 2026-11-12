// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// A fake GitHub for tests only: one node:http server on 127.0.0.1 standing in
// for both github.com and api.github.com (the tests point NBO at its
// address). Never started outside tests.
//
// It checks every app JWT against the app's own public key (RS256, `iss`,
// `exp` within 10 minutes), issues installation tokens (recording the
// requested repository_ids and permissions), serves the REST calls NBO makes
// and hosts git repositories over git's plain ("dumb") HTTP protocol,
// answering 401 to a private repository unless the request carries a token
// issued for it.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, createVerify, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { run } from "../run.js";

export interface FakeCall {
  method: string;
  // The path without its query string.
  path: string;
  query: URLSearchParams;
  body: unknown;
  // The Authorization header ("" when none).
  auth: string;
  headers: Record<string, string>;
}

export interface FakeApp {
  id: number;
  slug: string;
  name: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  pem: string;
  htmlUrl: string;
  ownerLogin: string;
  // Organization when the app was registered through an organization's form.
  ownerType: "User" | "Organization";
  permissions: Record<string, string>;
  events: string[];
  hookConfig: { url: string; content_type: string; insecure_ssl: string };
  // The manifest's setup_url ("" for createApp), where installing returns.
  setupUrl: string;
}

export interface FakeInstallationInput {
  account: string;
  accountType?: "User" | "Organization";
  repositorySelection?: "all" | "selected";
  suspended?: boolean;
}

export interface FakeRepoInput {
  name: string;
  owner: string;
  private: boolean;
  defaultBranch?: string;
  template?: boolean;
}

export interface FakeCheckRun {
  id: number;
  repoId: number;
  body: Record<string, unknown>;
}

export interface FakeDelivery {
  id: number;
  guid: string;
  event: string;
  action: string | null;
  deliveredAt: string;
  installationId: number | null;
  repositoryId: number | null;
  payload: unknown;
}

export interface FakeGitHub {
  url: string;
  stop(): Promise<void>;
  calls: FakeCall[];
  // Manifests posted to /settings/apps/new (and the organization form).
  manifests: { owner: string | null; manifest: Record<string, unknown>; state: string }[];
  app: FakeApp | null;
  // createApp registers an app directly (what a manifest conversion does).
  createApp(input?: { name?: string; ownerLogin?: string; ownerType?: "User" | "Organization"; permissions?: Record<string, string> }): FakeApp;
  // The person "signed in" to the fake for user authorization. GET /user and
  // GET /user/emails answer for the user as it was when the code was issued;
  // change login between sign-ins to rename them.
  user: FakeUser;
  // setMembership: user login's membership of organization org (GET
  // /orgs/{org}/memberships/{username}); null removes it (404).
  setMembership(org: string, login: string, state: "active" | "pending" | null): void;
  addInstallation(input: FakeInstallationInput): number;
  removeInstallation(id: number): void;
  addRepo(installationIds: number[], input: FakeRepoInput): Promise<{ id: number; fullName: string; bareDir: string }>;
  // setRepoAccess changes which installations can see a repository.
  setRepoAccess(repoId: number, installationIds: number[]): void;
  // pushCommit adds a commit on branch (created from the default branch's
  // head when new) and returns its sha. files replaces the tree's files
  // (flat or nested paths); the default is a README naming the repository.
  pushCommit(repoId: number, branch: string, files?: Record<string, string>): Promise<string>;
  addDelivery(event: string, payload: unknown): string;
  deliveries: FakeDelivery[];
  checkRuns: FakeCheckRun[];
  // The next request matching method and path pattern ("*" matches one path
  // segment; a RegExp is tested against the path) answers status.
  failNext(method: string, pathPattern: string | RegExp, status: number): void;
  // Repositories made by /generate reach "all repositories" installations
  // only after this many lookups of GET /repositories/{id} have answered 404
  // (GitHub adds them a moment later); 0 (the default) adds them at once.
  generateGrantDelay: number;
  // User tokens revoked through DELETE /applications/{client_id}/token.
  revoked: string[];
  // POST /login/oauth/access_token answers form-encoded unless the request's
  // Accept asks for application/json, as github.com does; true makes it
  // answer form-encoded even then.
  tokenAnswerAlwaysForm: boolean;
  // The next request matching method and path pattern is answered by
  // respond instead (a stalled, oversize or redirecting answer).
  interceptNext(method: string, pathPattern: string | RegExp, respond: (res: ServerResponse) => void): void;
  // The fake's clock (for token expiry and JWT checks); null restores Date.now.
  setNow(now: (() => number) | null): void;
  // Tokens issued so far (installation and user), for leak checks.
  issuedTokens(): string[];
}

export interface FakeUser {
  login: string;
  id: number;
  name?: string;
  emails?: { email: string; primary: boolean; verified: boolean }[];
}

interface Installation {
  id: number;
  account: { login: string; id: number; type: "User" | "Organization"; avatar_url: string };
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  ownerId: number;
  private: boolean;
  defaultBranch: string;
  template: boolean;
  installations: Set<number>;
  bareDir: string;
  pushedAt: string;
  commits: number;
}

interface InstallationToken {
  installationId: number;
  repositoryIds: number[] | null;
  permissions: Record<string, string>;
  expiresAt: number;
}

interface UserCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  login: string;
  user: FakeUser;
}

const defaultPermissions: Record<string, string> = { contents: "read", metadata: "read", checks: "write", pull_requests: "write", members: "read", email_addresses: "read" };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function patternMatches(pattern: string | RegExp, path: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(path);
  const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`);
  return re.test(path);
}

const b64urlJson = (s: string): Record<string, unknown> => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;

export async function startFakeGitHub(): Promise<FakeGitHub> {
  const root = await mkdtemp(join(tmpdir(), "fake-github-"));
  let clock: () => number = Date.now;
  let nextId = 1000;
  const id = () => ++nextId;
  let app: (FakeApp & { publicKey: KeyObject }) | null = null;
  const manifestCodes = new Map<string, Record<string, unknown> & { ownerLogin: string; ownerType: "User" | "Organization" }>();
  const installations = new Map<number, Installation>();
  const repos = new Map<number, Repo>();
  const tokens = new Map<string, InstallationToken>();
  const userCodes = new Map<string, UserCode>();
  const userTokens = new Map<string, string>(); // token -> login
  const userTokenUsers = new Map<string, FakeUser>(); // token -> the user as authorized
  const pendingGrants = new Map<number, { insts: number[]; left: number }>();
  const memberships = new Map<string, "active" | "pending">(); // "org/login" (lower case) -> state
  const failures: { method: string; pattern: string | RegExp; status: number }[] = [];
  const intercepts: { method: string; pattern: string | RegExp; respond: (res: ServerResponse) => void }[] = [];
  const calls: FakeCall[] = [];
  const manifests: FakeGitHub["manifests"] = [];
  const deliveries: FakeDelivery[] = [];
  const checkRuns: FakeCheckRun[] = [];
  const accountIds = new Map<string, number>();
  const accountId = (login: string): number => {
    const k = login.toLowerCase();
    if (!accountIds.has(k)) accountIds.set(k, id());
    return accountIds.get(k)!;
  };

  let baseUrl = "";

  const makeApp = (input?: { name?: string; ownerLogin?: string; ownerType?: "User" | "Organization"; permissions?: Record<string, string>; events?: string[]; hookUrl?: string; setupUrl?: string }): FakeApp => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const appId = id();
    const name = input?.name ?? "NBO";
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${appId}`;
    const created: FakeApp & { publicKey: KeyObject } = {
      id: appId,
      slug,
      name,
      clientId: `Iv1.${randomBytes(8).toString("hex")}`,
      clientSecret: randomBytes(20).toString("hex"),
      webhookSecret: randomBytes(20).toString("hex"),
      pem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      htmlUrl: `${baseUrl}/apps/${slug}`,
      ownerLogin: input?.ownerLogin ?? "octo",
      ownerType: input?.ownerType ?? "User",
      permissions: input?.permissions ?? { ...defaultPermissions },
      events: input?.events ?? ["push", "pull_request", "repository", "check_run"],
      hookConfig: { url: input?.hookUrl ?? "https://nbo.invalid/api/controlplane/github/webhook", content_type: "json", insecure_ssl: "0" },
      setupUrl: input?.setupUrl ?? "",
      publicKey,
    };
    app = created;
    return created;
  };

  const installationJson = (i: Installation) => ({
    id: i.id,
    account: i.account,
    repository_selection: i.repositorySelection,
    suspended_at: i.suspendedAt,
    html_url: `${baseUrl}/settings/installations/${i.id}`,
    app_id: app?.id ?? 0,
    app_slug: app?.slug ?? "",
    target_type: i.account.type,
    permissions: app?.permissions ?? {},
    events: app?.events ?? [],
  });

  const repoJson = (r: Repo) => ({
    id: r.id,
    node_id: `R_${r.id}`,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    private: r.private,
    visibility: r.private ? "private" : "public",
    owner: { login: r.owner, id: r.ownerId, type: "User" },
    default_branch: r.defaultBranch,
    pushed_at: r.pushedAt,
    html_url: `${baseUrl}/${r.owner}/${r.name}`,
    clone_url: `${baseUrl}/${r.owner}/${r.name}.git`,
    is_template: r.template,
  });

  const findRepo = (owner: string, name: string): Repo | undefined =>
    [...repos.values()].find((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase());

  // --- auth -------------------------------------------------------------

  const bearer = (req: IncomingMessage): string => {
    const h = req.headers.authorization ?? "";
    const m = /^(?:bearer|token)\s+(.+)$/i.exec(h);
    return m ? m[1]!.trim() : "";
  };

  const requireAppJwt = (req: IncomingMessage): FakeApp => {
    const token = bearer(req);
    if (!app) throw new HttpError(401, "A JSON web token could not be decoded");
    const parts = token.split(".");
    if (parts.length !== 3) throw new HttpError(401, "A JSON web token could not be decoded");
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = b64urlJson(parts[0]!);
      claims = b64urlJson(parts[1]!);
    } catch {
      throw new HttpError(401, "A JSON web token could not be decoded");
    }
    if (header.alg !== "RS256") throw new HttpError(401, "'alg' must be RS256");
    const ok = createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).verify(app.publicKey, Buffer.from(parts[2]!, "base64url"));
    if (!ok) throw new HttpError(401, "A JSON web token could not be decoded");
    const now = Math.floor(clock() / 1000);
    const exp = Number(claims.exp);
    const iat = Number(claims.iat);
    if (String(claims.iss) !== String(app.id)) throw new HttpError(401, "'Issuer' claim ('iss') must match the app id");
    if (!Number.isFinite(exp) || exp <= now) throw new HttpError(401, "'Expiration time' claim ('exp') must be a numeric value representing the future time");
    if (exp > now + 600) throw new HttpError(401, "'Expiration time' claim ('exp') is too far in the future");
    if (!Number.isFinite(iat) || iat > now + 60) throw new HttpError(401, "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued");
    return app;
  };

  const requireInstallationToken = (req: IncomingMessage): { token: string; grant: InstallationToken } => {
    const token = bearer(req);
    const grant = tokens.get(token);
    if (!grant || grant.expiresAt <= clock()) throw new HttpError(401, "Bad credentials");
    return { token, grant };
  };

  const canSee = (grant: InstallationToken, r: Repo): boolean =>
    r.installations.has(grant.installationId) && (grant.repositoryIds === null || grant.repositoryIds.includes(r.id));

  const visibleRepos = (grant: InstallationToken): Repo[] => [...repos.values()].filter((r) => canSee(grant, r)).sort((a, b) => a.id - b.id);

  // --- git ---------------------------------------------------------------

  const git = (cwd: string, args: string[], input?: string, env?: Record<string, string>) => run("git", args, { cwd, input, env: { GIT_TERMINAL_PROMPT: "0", ...env }, timeoutMs: 30_000 });

  const writeTree = async (bare: string, files: Record<string, string>): Promise<string> => {
    const here = new Map<string, string>();
    const subdirs = new Map<string, Record<string, string>>();
    for (const [path, content] of Object.entries(files)) {
      const [first, ...rest] = path.split("/");
      if (rest.length === 0) here.set(first!, content);
      else {
        const sub = subdirs.get(first!) ?? {};
        sub[rest.join("/")] = content;
        subdirs.set(first!, sub);
      }
    }
    const lines: string[] = [];
    for (const [name, content] of here) {
      const blob = (await git(bare, ["hash-object", "-w", "--stdin"], content)).trim();
      lines.push(`100644 blob ${blob}\t${name}`);
    }
    for (const [name, sub] of subdirs) lines.push(`040000 tree ${await writeTree(bare, sub)}\t${name}`);
    return (await git(bare, ["mktree"], lines.join("\n") + "\n")).trim();
  };

  const headOf = async (bare: string, branch: string): Promise<string | null> => {
    try {
      return (await git(bare, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).trim() || null;
    } catch {
      return null;
    }
  };

  const commit = async (r: Repo, branch: string, files?: Record<string, string>): Promise<string> => {
    r.commits++;
    const tree = await writeTree(r.bareDir, files ?? { "README.md": `# ${r.name}\n\ncommit ${r.commits}\n` });
    const parent = (await headOf(r.bareDir, branch)) ?? (await headOf(r.bareDir, r.defaultBranch));
    const date = `${1_700_000_000 + r.commits * 60} +0000`;
    const env = { GIT_AUTHOR_NAME: "Octo", GIT_AUTHOR_EMAIL: "octo@example.test", GIT_COMMITTER_NAME: "Octo", GIT_COMMITTER_EMAIL: "octo@example.test", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const args = ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `commit ${r.commits} on ${branch}`];
    const sha = (await git(r.bareDir, args, undefined, env)).trim();
    await git(r.bareDir, ["update-ref", `refs/heads/${branch}`, sha]);
    await git(r.bareDir, ["update-server-info"]);
    r.pushedAt = new Date(clock()).toISOString();
    return sha;
  };

  const serveGit = async (req: IncomingMessage, res: ServerResponse, r: Repo, rest: string): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "dumb HTTP is read-only");
    if (r.private) {
      const h = req.headers.authorization ?? "";
      let token: string;
      const basic = /^basic\s+(.+)$/i.exec(h);
      if (basic) {
        const decoded = Buffer.from(basic[1]!.trim(), "base64").toString("utf8");
        token = decoded.slice(decoded.indexOf(":") + 1);
      } else token = bearer(req);
      const grant = tokens.get(token);
      if (!grant || grant.expiresAt <= clock() || !canSee(grant, r)) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"', "Content-Type": "text/plain" });
        res.end("Unauthorized");
        return;
      }
    }
    const file = normalize(join(r.bareDir, rest));
    if (!file.startsWith(r.bareDir + sep)) throw new HttpError(404, "Not Found");
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error("not a file");
    } catch {
      throw new HttpError(404, "Not Found");
    }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": rest.startsWith("objects/") ? "application/x-git-loose-object" : "text/plain", "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
  };

  // --- routing -----------------------------------------------------------

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const parseBody = (req: IncomingMessage, text: string): unknown => {
    if (text === "") return undefined;
    const type = req.headers["content-type"] ?? "";
    if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };

  const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
    const text = value === undefined ? "" : JSON.stringify(value);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(text);
  };

  // oauthAnswer: github.com's token endpoint answers form-encoded unless asked for JSON.
  const oauthAnswer = (req: IncomingMessage, res: ServerResponse, value: Record<string, string>): void => {
    if (!fake.tokenAnswerAlwaysForm && (req.headers.accept ?? "").includes("application/json")) return json(res, 200, value);
    res.writeHead(200, { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" });
    res.end(new URLSearchParams(value).toString());
  };

  const redirect = (res: ServerResponse, to: string): void => {
    res.writeHead(302, { Location: to });
    res.end();
  };

  const pageOf = (q: URLSearchParams, perPageDefault = 30): { page: number; perPage: number } => ({
    page: Math.max(1, Number(q.get("page") ?? "1") || 1),
    perPage: Math.min(100, Math.max(1, Number(q.get("per_page") ?? String(perPageDefault)) || perPageDefault)),
  });

  const linkNext = (path: string, q: URLSearchParams, next: Record<string, string>): Record<string, string> => {
    const nq = new URLSearchParams(q);
    for (const [k, v] of Object.entries(next)) nq.set(k, v);
    return { Link: `<${baseUrl}${path}?${nq.toString()}>; rel="next"` };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, call: FakeCall): Promise<void> => {
    const { method, path, query: q } = call;
    const body = (call.body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;

    // git over dumb HTTP: /{owner}/{repo}.git/...
    if ((m = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path))) {
      const r = findRepo(m[1]!, m[2]!);
      if (!r) throw new HttpError(404, "Repository not found");
      return serveGit(req, res, r, decodeURIComponent(m[3]!));
    }

    // Manifest flow (browser form posts).
    if (method === "POST" && ((m = /^\/settings\/apps\/new$/.exec(path)) || (m = /^\/organizations\/([^/]+)\/settings\/apps\/new$/.exec(path)))) {
      const owner = m[1] ?? null;
      const manifest = JSON.parse(String(body.manifest ?? "{}")) as Record<string, unknown>;
      const state = q.get("state") ?? "";
      manifests.push({ owner, manifest, state });
      const code = randomBytes(10).toString("hex");
      manifestCodes.set(code, { ...manifest, ownerLogin: owner ?? fake.user.login, ownerType: owner ? "Organization" : "User" });
      const to = new URL(String(manifest.redirect_url));
      to.searchParams.set("code", code);
      to.searchParams.set("state", state);
      return redirect(res, to.toString());
    }
    if (method === "POST" && (m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path))) {
      const manifest = manifestCodes.get(m[1]!);
      if (!manifest) throw new HttpError(404, "Not Found");
      manifestCodes.delete(m[1]!);
      const hook = manifest.hook_attributes as { url?: string } | undefined;
      const a = makeApp({
        name: String(manifest.name ?? "NBO"),
        ownerLogin: manifest.ownerLogin,
        ownerType: manifest.ownerType,
        permissions: (manifest.default_permissions as Record<string, string>) ?? defaultPermissions,
        events: (manifest.default_events as string[]) ?? [],
        hookUrl: hook?.url,
        setupUrl: typeof manifest.setup_url === "string" ? manifest.setup_url : "",
      });
      return json(res, 201, {
        id: a.id,
        slug: a.slug,
        node_id: `A_${a.id}`,
        name: a.name,
        owner: { login: a.ownerLogin, id: accountId(a.ownerLogin), type: a.ownerType },
        client_id: a.clientId,
        client_secret: a.clientSecret,
        webhook_secret: a.webhookSecret,
        pem: a.pem,
        html_url: a.htmlUrl,
        permissions: a.permissions,
        events: a.events,
        created_at: new Date(clock()).toISOString(),
      });
    }

    // Installing (browser): a private app installs only on the account that
    // owns it (GitHub's rule), then returns to the app's setup URL.
    if (method === "GET" && (m = /^\/apps\/([^/]+)\/installations\/new$/.exec(path))) {
      if (!app || app.slug !== m[1]) throw new HttpError(404, "Not Found");
      const instId = fake.addInstallation({ account: app.ownerLogin, accountType: app.ownerType });
      if (app.setupUrl === "") return json(res, 200, { installationId: instId, state: q.get("state") });
      const to = new URL(app.setupUrl);
      to.searchParams.set("installation_id", String(instId));
      to.searchParams.set("setup_action", "install");
      to.searchParams.set("state", q.get("state") ?? "");
      return redirect(res, to.toString());
    }

    // User authorization (browser + token exchange).
    if (method === "GET" && path === "/login/oauth/authorize") {
      if (!app || q.get("client_id") !== app.clientId) throw new HttpError(404, "Not Found");
      const redirectUri = q.get("redirect_uri") ?? "";
      const code = randomBytes(10).toString("hex");
      userCodes.set(code, { clientId: app.clientId, redirectUri, challenge: q.get("code_challenge") ?? "", login: fake.user.login, user: structuredClone(fake.user) });
      const to = new URL(redirectUri);
      to.searchParams.set("code", code);
      to.searchParams.set("state", q.get("state") ?? "");
      return redirect(res, to.toString());
    }
    if (method === "POST" && path === "/login/oauth/access_token") {
      const code = String(body.code ?? "");
      const grant = userCodes.get(code);
      userCodes.delete(code);
      if (!app || !grant || body.client_id !== app.clientId || body.client_secret !== app.clientSecret) {
        return oauthAnswer(req, res, { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
      }
      if (body.redirect_uri !== undefined && body.redirect_uri !== grant.redirectUri) {
        return oauthAnswer(req, res, { error: "redirect_uri_mismatch", error_description: "The redirect_uri does not match." });
      }
      if (grant.challenge !== "") {
        const verifier = String(body.code_verifier ?? "");
        if (createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) {
          return oauthAnswer(req, res, { error: "bad_verification_code", error_description: "The code_verifier does not match." });
        }
      }
      const token = `ghu_${randomBytes(18).toString("hex")}`;
      userTokens.set(token, grant.login);
      userTokenUsers.set(token, grant.user);
      return oauthAnswer(req, res, { access_token: token, token_type: "bearer", scope: "" });
    }

    // Revoking a user token (the app's own credentials, basic auth).
    if (method === "DELETE" && (m = /^\/applications\/([^/]+)\/token$/.exec(path))) {
      const basic = /^basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
      const [cid, secret] = basic ? Buffer.from(basic[1]!.trim(), "base64").toString("utf8").split(":") : [];
      if (!app || m[1] !== app.clientId || cid !== app.clientId || secret !== app.clientSecret) throw new HttpError(401, "Bad credentials");
      const token = String(body.access_token ?? "");
      userTokens.delete(token);
      userTokenUsers.delete(token);
      fake.revoked.push(token);
      res.writeHead(204);
      return void res.end();
    }

    // App (JWT) endpoints.
    if (method === "GET" && path === "/app") {
      const a = requireAppJwt(req);
      return json(res, 200, { id: a.id, slug: a.slug, name: a.name, owner: { login: a.ownerLogin }, html_url: a.htmlUrl, permissions: a.permissions, events: a.events });
    }
    if (method === "GET" && path === "/app/installations") {
      requireAppJwt(req);
      const { page, perPage } = pageOf(q);
      const all = [...installations.values()].sort((a, b) => a.id - b.id);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const more = page * perPage < all.length;
      return json(res, 200, slice.map(installationJson), more ? linkNext(path, q, { page: String(page + 1) }) : {});
    }
    if ((m = /^\/app\/installations\/(\d+)$/.exec(path))) {
      requireAppJwt(req);
      const inst = installations.get(Number(m[1]));
      if (!inst) throw new HttpError(404, "Not Found");
      if (method === "GET") return json(res, 200, installationJson(inst));
    }
    if (method === "POST" && (m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))) {
      requireAppJwt(req);
      const inst = installations.get(Number(m[1]));
      if (!inst) throw new HttpError(404, "Not Found");
      if (inst.suspendedAt) throw new HttpError(403, "This installation has been suspended");
      const repositoryIds = Array.isArray(body.repository_ids) ? (body.repository_ids as number[]) : null;
      if (repositoryIds) {
        for (const rid of repositoryIds) {
          const r = repos.get(rid);
          if (!r || !r.installations.has(inst.id)) throw new HttpError(422, "There is at least one repository that does not exist or is not accessible to the parent installation.");
        }
      }
      const permissions = (body.permissions as Record<string, string> | undefined) ?? { ...(app?.permissions ?? {}) };
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      const expiresAt = clock() + 60 * 60_000;
      tokens.set(token, { installationId: inst.id, repositoryIds, permissions, expiresAt });
      return json(res, 201, { token, expires_at: new Date(expiresAt).toISOString(), permissions, repository_selection: repositoryIds ? "selected" : inst.repositorySelection });
    }
    if (path === "/app/hook/config") {
      const a = requireAppJwt(req);
      if (method === "PATCH") {
        if (typeof body.url === "string") a.hookConfig.url = body.url;
        if (typeof body.content_type === "string") a.hookConfig.content_type = body.content_type;
        if (typeof body.insecure_ssl === "string") a.hookConfig.insecure_ssl = body.insecure_ssl;
      }
      return json(res, 200, a.hookConfig);
    }
    if (method === "GET" && path === "/app/hook/deliveries") {
      requireAppJwt(req);
      const perPage = Math.min(100, Math.max(1, Number(q.get("per_page") ?? "30") || 30));
      const newestFirst = [...deliveries].sort((a, b) => b.id - a.id);
      const cursor = q.get("cursor");
      const start = cursor ? newestFirst.findIndex((d) => d.id < Number(cursor)) : 0;
      const slice = start < 0 ? [] : newestFirst.slice(start, start + perPage);
      const more = start >= 0 && start + perPage < newestFirst.length;
      const summary = slice.map((d) => ({
        id: d.id,
        guid: d.guid,
        delivered_at: d.deliveredAt,
        redelivery: false,
        duration: 0.01,
        status: "Invalid HTTP Response: 404",
        status_code: 404,
        event: d.event,
        action: d.action,
        installation_id: d.installationId,
        repository_id: d.repositoryId,
      }));
      return json(res, 200, summary, more ? linkNext(path, q, { cursor: String(slice[slice.length - 1]!.id) }) : {});
    }
    if (method === "GET" && (m = /^\/app\/hook\/deliveries\/(\d+)$/.exec(path))) {
      requireAppJwt(req);
      const d = deliveries.find((x) => x.id === Number(m![1]));
      if (!d) throw new HttpError(404, "Not Found");
      return json(res, 200, {
        id: d.id,
        guid: d.guid,
        delivered_at: d.deliveredAt,
        event: d.event,
        action: d.action,
        installation_id: d.installationId,
        repository_id: d.repositoryId,
        request: { headers: { "X-GitHub-Event": d.event, "X-GitHub-Delivery": d.guid }, payload: d.payload },
        response: { headers: {}, payload: "" },
      });
    }

    // User-token endpoints (sign-in).
    if (method === "GET" && (path === "/user" || path === "/user/emails")) {
      const u = userTokenUsers.get(bearer(req));
      if (!u) throw new HttpError(401, "Bad credentials");
      if (path === "/user") return json(res, 200, { login: u.login, id: u.id, name: u.name ?? null, avatar_url: `https://avatars.example.test/u/${u.id}`, type: "User" });
      const emails = u.emails ?? [{ email: `${u.login}@example.test`, primary: true, verified: true }];
      return json(res, 200, emails.map((e) => ({ ...e, visibility: e.primary ? "private" : null })));
    }

    // Installation-token endpoints.
    if (method === "GET" && (m = /^\/orgs\/([^/]+)\/memberships\/([^/]+)$/.exec(path))) {
      const { grant } = requireInstallationToken(req);
      const org = decodeURIComponent(m[1]!);
      const login = decodeURIComponent(m[2]!);
      const inst = installations.get(grant.installationId);
      // An installation token reads members only of its own organization, with Members: read.
      if (!inst || inst.account.login.toLowerCase() !== org.toLowerCase()) throw new HttpError(404, "Not Found");
      if (!(grant.permissions.members === "read" || grant.permissions.members === "write")) throw new HttpError(403, "Resource not accessible by integration");
      const state = memberships.get(`${org.toLowerCase()}/${login.toLowerCase()}`);
      if (!state) throw new HttpError(404, "Not Found");
      const userId = login.toLowerCase() === fake.user.login.toLowerCase() ? fake.user.id : accountId(login);
      return json(res, 200, { state, role: "member", organization: { login: inst.account.login, id: inst.account.id }, user: { login, id: userId } });
    }
    if (method === "GET" && path === "/installation/repositories") {
      const { grant } = requireInstallationToken(req);
      const { page, perPage } = pageOf(q);
      const all = visibleRepos(grant);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const more = page * perPage < all.length;
      return json(res, 200, { total_count: all.length, repository_selection: installations.get(grant.installationId)?.repositorySelection, repositories: slice.map(repoJson) }, more ? linkNext(path, q, { page: String(page + 1) }) : {});
    }
    if (method === "GET" && (m = /^\/repositories\/(\d+)$/.exec(path))) {
      const { grant } = requireInstallationToken(req);
      const pending = pendingGrants.get(Number(m[1]));
      if (pending) {
        if (pending.left > 0) {
          pending.left--;
          throw new HttpError(404, "Not Found");
        }
        pendingGrants.delete(Number(m[1]));
        repos.get(Number(m[1]))!.installations = new Set(pending.insts);
      }
      const r = repos.get(Number(m[1]));
      if (!r || !canSee(grant, r)) throw new HttpError(404, "Not Found");
      return json(res, 200, repoJson(r));
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/check-runs(?:\/(\d+))?$/.exec(path))) {
      const { grant } = requireInstallationToken(req);
      const r = findRepo(m[1]!, m[2]!);
      if (!r || !canSee(grant, r)) throw new HttpError(404, "Not Found");
      if (method === "POST" && !m[3]) {
        const run = { id: id(), repoId: r.id, body: { ...body } };
        checkRuns.push(run);
        return json(res, 201, { id: run.id, ...run.body });
      }
      if (method === "PATCH" && m[3]) {
        const run = checkRuns.find((c) => c.id === Number(m![3]) && c.repoId === r.id);
        if (!run) throw new HttpError(404, "Not Found");
        Object.assign(run.body, body);
        return json(res, 200, { id: run.id, ...run.body });
      }
    }
    if (method === "POST" && (m = /^\/repos\/([^/]+)\/([^/]+)\/generate$/.exec(path))) {
      const login = userTokens.get(bearer(req));
      if (!login) throw new HttpError(401, "Bad credentials");
      const t = findRepo(m[1]!, m[2]!);
      if (!t) throw new HttpError(404, "Not Found");
      if (!t.template) throw new HttpError(422, "Repository is not a template");
      const owner = String(body.owner ?? login);
      const name = String(body.name ?? "");
      if (name === "" || findRepo(owner, name)) throw new HttpError(422, "Name already exists on this account");
      const insts = [...installations.values()].filter((i) => i.account.login.toLowerCase() === owner.toLowerCase() && i.repositorySelection === "all").map((i) => i.id);
      const delayed = fake.generateGrantDelay > 0;
      const created = await fake.addRepo(delayed ? [] : insts, { name, owner, private: body.private === true, defaultBranch: t.defaultBranch });
      if (delayed) pendingGrants.set(created.id, { insts, left: fake.generateGrantDelay });
      return json(res, 201, repoJson(repos.get(created.id)!));
    }
    if (method === "GET" && (m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path))) {
      const r = findRepo(m[1]!, m[2]!);
      if (!r) throw new HttpError(404, "Not Found");
      if (r.private) {
        const token = bearer(req);
        const grant = tokens.get(token);
        const userOk = userTokens.has(token);
        if (!userOk && (!grant || grant.expiresAt <= clock() || !canSee(grant, r))) throw new HttpError(404, "Not Found");
      }
      return json(res, 200, repoJson(r));
    }

    throw new HttpError(404, "Not Found");
  };

  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const text = await readBody(req);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const call: FakeCall = { method: req.method ?? "GET", path: u.pathname, query: u.searchParams, body: parseBody(req, text), auth: req.headers.authorization ?? "", headers };
      calls.push(call);
      const hook = intercepts.findIndex((f) => f.method === call.method && patternMatches(f.pattern, call.path));
      if (hook >= 0) return intercepts.splice(hook, 1)[0]!.respond(res);
      const fail = failures.findIndex((f) => f.method === call.method && patternMatches(f.pattern, call.path));
      if (fail >= 0) {
        const f = failures.splice(fail, 1)[0]!;
        return json(res, f.status, { message: `Fake failure ${f.status}`, documentation_url: "https://docs.github.com/rest" });
      }
      try {
        await handle(req, res, call);
      } catch (err) {
        if (err instanceof HttpError) return json(res, err.status, { message: err.message, documentation_url: "https://docs.github.com/rest" });
        return json(res, 500, { message: err instanceof Error ? err.message : String(err) });
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const fake: FakeGitHub = {
    url: baseUrl,
    calls,
    manifests,
    deliveries,
    checkRuns,
    get app() {
      return app;
    },
    user: { login: "octo", id: 1 },
    setMembership(org, login, state) {
      const key = `${org.toLowerCase()}/${login.toLowerCase()}`;
      if (state === null) memberships.delete(key);
      else memberships.set(key, state);
    },
    createApp: (input) => makeApp(input),
    addInstallation(input) {
      const instId = id();
      installations.set(instId, {
        id: instId,
        account: {
          login: input.account,
          id: accountId(input.account),
          type: input.accountType ?? "User",
          avatar_url: `${baseUrl}/avatars/${input.account}`,
        },
        repositorySelection: input.repositorySelection ?? "all",
        suspendedAt: input.suspended ? new Date(clock()).toISOString() : null,
      });
      return instId;
    },
    removeInstallation(instId) {
      installations.delete(instId);
      for (const r of repos.values()) r.installations.delete(instId);
    },
    async addRepo(installationIds, input) {
      const repoId = id();
      const bareDir = join(root, `${repoId}-${input.name}.git`);
      await run("git", ["init", "--bare", "--quiet", bareDir], { env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 30_000 });
      const r: Repo = {
        id: repoId,
        name: input.name,
        owner: input.owner,
        ownerId: accountId(input.owner),
        private: input.private,
        defaultBranch: input.defaultBranch ?? "main",
        template: input.template ?? false,
        installations: new Set(installationIds),
        bareDir,
        pushedAt: new Date(clock()).toISOString(),
        commits: 0,
      };
      repos.set(repoId, r);
      await git(bareDir, ["symbolic-ref", "HEAD", `refs/heads/${r.defaultBranch}`]);
      await commit(r, r.defaultBranch);
      return { id: repoId, fullName: `${r.owner}/${r.name}`, bareDir };
    },
    setRepoAccess(repoId, installationIds) {
      const r = repos.get(repoId);
      if (!r) throw new Error(`no repo ${repoId}`);
      r.installations = new Set(installationIds);
    },
    async pushCommit(repoId, branch, files) {
      const r = repos.get(repoId);
      if (!r) throw new Error(`no repo ${repoId}`);
      return commit(r, branch, files);
    },
    addDelivery(event, payload) {
      const p = (payload ?? {}) as { action?: unknown; installation?: { id?: unknown }; repository?: { id?: unknown } };
      const d: FakeDelivery = {
        id: id(),
        guid: randomUUID(),
        event,
        action: typeof p.action === "string" ? p.action : null,
        deliveredAt: new Date(clock()).toISOString(),
        installationId: typeof p.installation?.id === "number" ? p.installation.id : null,
        repositoryId: typeof p.repository?.id === "number" ? p.repository.id : null,
        payload,
      };
      deliveries.push(d);
      return d.guid;
    },
    generateGrantDelay: 0,
    revoked: [],
    tokenAnswerAlwaysForm: false,
    failNext(method, pattern, status) {
      failures.push({ method: method.toUpperCase(), pattern, status });
    },
    interceptNext(method, pattern, respond) {
      intercepts.push({ method: method.toUpperCase(), pattern, respond });
    },
    setNow(now) {
      clock = now ?? Date.now;
    },
    issuedTokens: () => [...tokens.keys(), ...userTokens.keys()],
    async stop() {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  return fake;
}

