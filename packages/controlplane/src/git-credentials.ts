// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandRunner } from "@nbo/deploy";
import { ErrInvalid } from "./errors.js";
import type { Store } from "./store.js";
import type { GitConfig } from "./git.js";
import { open, seal, ErrSecretKey } from "./secrets.js";
import { lostAccessMessage, type LegacyGitHub } from "./github-legacy.js";
import { isHttpsGitUrl, isSshGitUrl } from "./gitremote.js";
import { publishedHostKeys } from "./git-host-keys.js";

// Git credentials per project (spec 7.4): core holds its own way into each
// repository, so pushes build while nothing else is up. A project has at most
// one credential row; no row means a public repository.
//
// - token: an HTTPS token (and optional user name). It reaches git only as an
//   http.<repo>.extraHeader through GIT_CONFIG_* in the environment of the git
//   steps (clone, checkout, log, ls-remote), never in a URL, an argument, a
//   .git/config file, a log line or the build command's environment.
// - deploy-key: an SSH key pair NBO made. The private half is sealed here,
//   written to a 0600 file for the length of one git step, and given to ssh
//   through GIT_SSH_COMMAND with host keys checked against NBO's own
//   known_hosts file (a new host is remembered on first use; a changed key is
//   refused).
// - github-legacy: never stored here. A project whose GitConfig.github is set
//   (linked to the old per-server GitHub App) reads as this kind, and gets an
//   installation token through github-legacy.ts until it is migrated.
//
// The secret column is sealed with the secret key; the API shows only the
// kind, the public key and the user name.
export const gitCredentialsSchema = `
CREATE TABLE IF NOT EXISTS project_git_credentials (
	project_id TEXT PRIMARY KEY REFERENCES projects(id),
	kind TEXT NOT NULL,
	sealed TEXT NOT NULL DEFAULT '',
	public_key TEXT NOT NULL DEFAULT '',
	username TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL
);
`;

export type GitCredentialKind = "public" | "token" | "deploy-key" | "github-legacy";

// What a request may set (the deploy key's material comes from generateDeployKey).
export type GitCredentialRequest = { kind: "public" } | { kind: "token"; token: string; username?: string } | { kind: "deploy-key" };

// What the store keeps.
export type GitCredentialInput =
  | { kind: "public" }
  | { kind: "token"; token: string; username?: string }
  | { kind: "deploy-key"; privateKey: string; publicKey: string };

// GitCredentialView: what the API shows. Never the sealed value.
export interface GitCredentialView {
  kind: GitCredentialKind;
  publicKey?: string;
  username?: string;
}

export interface StoredGitCredential {
  kind: "token" | "deploy-key";
  publicKey: string;
  username: string;
  updatedAt: string;
}

export interface GitCredentialsStore {
  // getGitCredential: the stored row without its secret (undefined = public).
  getGitCredential(projectId: string): StoredGitCredential | undefined;
  // setGitCredential seals the secret; { kind: "public" } deletes the row.
  setGitCredential(projectId: string, credential: GitCredentialInput): void;
  deleteGitCredential(projectId: string): void;
  // openGitCredential: the token or private key, for git steps only.
  openGitCredential(projectId: string): string | undefined;
  // legacyGitHubAppId: the id of the per-server GitHub App an older NBO
  // stored (github_app in server_settings), or null.
  legacyGitHubAppId(): number | null;
}

// A token or user name reaches a header value: no whitespace or control
// characters, and no ":" in a user name (it separates the two in Basic auth).
const tokenShape = /^[\x21-\x7e]{1,1024}$/;
const usernameShape = /^[\x21-\x39\x3b-\x7e]{1,100}$/;

// attachGitCredentialMethods mutates store in place like
// attachRevalidateTokenMethods, wrapping the secret-key hooks so a sealed git
// credential counts as sealed data (a missing key file must not be silently
// replaced).
export function attachGitCredentialMethods(db: DatabaseSync, store: Store, initialKey?: Buffer): Store {
  let key: Buffer | undefined = initialKey;
  const needKey = (): Buffer => {
    if (!key) throw new ErrSecretKey("no secret key loaded");
    return key;
  };
  const origSetKey = store.setSecretKey.bind(store);
  const origHasSealed = store.hasSealedSecrets.bind(store);
  const origVerify = store.verifySecretKey.bind(store);

  const methods: GitCredentialsStore & Pick<Store, "setSecretKey" | "hasSealedSecrets" | "verifySecretKey"> = {
    setSecretKey(k: Buffer): void {
      key = k;
      origSetKey(k);
    },
    hasSealedSecrets(): boolean {
      return origHasSealed() || (db.prepare("SELECT COUNT(*) AS n FROM project_git_credentials WHERE sealed <> ''").get() as { n: number }).n > 0;
    },
    verifySecretKey(): void {
      origVerify();
      const k = needKey();
      for (const r of db.prepare("SELECT sealed FROM project_git_credentials WHERE sealed <> ''").all() as { sealed: string }[]) open(k, r.sealed);
    },
    getGitCredential(projectId) {
      const r = db.prepare("SELECT kind, public_key, username, updated_at FROM project_git_credentials WHERE project_id = ?").get(projectId) as
        | { kind: string; public_key: string; username: string; updated_at: string }
        | undefined;
      if (!r || (r.kind !== "token" && r.kind !== "deploy-key")) return undefined;
      return { kind: r.kind, publicKey: r.public_key, username: r.username, updatedAt: r.updated_at };
    },
    setGitCredential(projectId, credential) {
      if (credential.kind === "public") {
        methods.deleteGitCredential(projectId);
        return;
      }
      store.getProject(projectId); // ErrNotFound for an unknown project
      let secret: string;
      let publicKey = "";
      let username = "";
      if (credential.kind === "token") {
        if (!tokenShape.test(credential.token)) throw new ErrInvalid("token must be 1 to 1024 visible characters with no spaces");
        if (credential.username !== undefined && !usernameShape.test(credential.username)) throw new ErrInvalid('username must be 1 to 100 visible characters with no spaces or ":"');
        secret = credential.token;
        username = credential.username ?? "";
      } else {
        if (!credential.privateKey.includes("PRIVATE KEY") || !/^ssh-ed25519 /.test(credential.publicKey)) throw new ErrInvalid("a deploy key needs an ed25519 key pair");
        secret = credential.privateKey;
        publicKey = credential.publicKey.trim();
      }
      db.prepare(
        `INSERT INTO project_git_credentials (project_id, kind, sealed, public_key, username, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET kind = excluded.kind, sealed = excluded.sealed, public_key = excluded.public_key,
           username = excluded.username, updated_at = excluded.updated_at`,
      ).run(projectId, credential.kind, seal(needKey(), secret), publicKey, username, new Date().toISOString());
    },
    deleteGitCredential(projectId) {
      db.prepare("DELETE FROM project_git_credentials WHERE project_id = ?").run(projectId);
    },
    openGitCredential(projectId) {
      const r = db.prepare("SELECT sealed FROM project_git_credentials WHERE project_id = ?").get(projectId) as { sealed: string } | undefined;
      return r && r.sealed !== "" ? open(needKey(), r.sealed) : undefined;
    },
    legacyGitHubAppId() {
      const r = db.prepare("SELECT value FROM server_settings WHERE key = 'github_app'").get() as { value: string } | undefined;
      if (!r) return null;
      try {
        const id = (JSON.parse(r.value) as { appId?: unknown }).appId;
        return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
      } catch {
        return null;
      }
    },
  };
  Object.assign(store, methods);
  return store;
}

// credentialView: the kind, and the public key or user name it has. Nothing sealed.
export function credentialView(store: Store, projectId: string, config: GitConfig | null): GitCredentialView {
  if (config?.github) return { kind: "github-legacy" };
  const c = store.getGitCredential(projectId);
  if (!c) return { kind: "public" };
  if (c.kind === "deploy-key") return { kind: "deploy-key", publicKey: c.publicKey };
  return c.username ? { kind: "token", username: c.username } : { kind: "token" };
}

export const repoMovedHost = "the repository moved to another host: give its credential again";

// repoOrigin: where git connects for repo, as "scheme://host:port" (ssh's
// scp-like form is ssh on port 22; https's default port is 443), lowercase;
// null for an address NBO doesn't accept. A stored credential stays with this
// origin: a repository that moves elsewhere needs its credential given again.
export function repoOrigin(repo: string): string | null {
  const scp = /^[^@/:]+@([^/:@]+):/.exec(repo);
  if (!repo.includes("://") && scp) return `ssh://${scp[1]!.toLowerCase()}:22`;
  let u: URL;
  try {
    u = new URL(repo);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  const port = u.port || (scheme === "https" ? "443" : scheme === "ssh" ? "22" : scheme === "http" ? "80" : "");
  return `${scheme}://${u.hostname.toLowerCase()}:${port}`;
}

export const githubImportRefused = "importing through a GitHub App is a feature of the hosted dashboard; give repo and credential instead";
export const sshNeedsDeployKey = 'an ssh repository address needs credential kind "deploy-key"';
export const deployKeyNeedsSsh = 'credential kind "deploy-key" needs an ssh repository address (ssh://git@host/path or git@host:path)';

// repoCredentialProblem: why repo can't be used with a credential of kind
// (null when it can). https only without credentials in the URL; ssh only
// with a deploy key, and a deploy key only over ssh.
export function repoCredentialProblem(repo: string, kind: GitCredentialKind): string | null {
  if (isSshGitUrl(repo)) return kind === "deploy-key" ? null : sshNeedsDeployKey;
  if (!isHttpsGitUrl(repo)) return "repo must be an https:// git URL with no credentials in it (no local paths), or with a deploy key an ssh address (ssh://git@host/path or git@host:path)";
  if (kind === "deploy-key") return deployKeyNeedsSsh;
  return null;
}

// parseCredential validates an untrusted credential (undefined when absent).
export function parseCredential(raw: unknown): GitCredentialRequest | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ErrInvalid('credential must be { kind: "public" | "token" | "deploy-key" }');
  const r = raw as Record<string, unknown>;
  const allowed = r.kind === "token" ? ["kind", "token", "username"] : ["kind"];
  const extra = Object.keys(r).filter((k) => !allowed.includes(k));
  if (r.kind === "public") {
    if (extra.length) throw new ErrInvalid(`credential kind "public" takes no ${extra.join(", ")}`);
    return { kind: "public" };
  }
  if (r.kind === "deploy-key") {
    if (extra.length) throw new ErrInvalid(`credential kind "deploy-key" takes no ${extra.join(", ")}; NBO makes the key (POST /projects/{id}/git/deploy-key)`);
    return { kind: "deploy-key" };
  }
  if (r.kind === "token") {
    if (extra.length) throw new ErrInvalid(`credential kind "token" takes only token and username`);
    if (typeof r.token !== "string" || !tokenShape.test(r.token)) throw new ErrInvalid("token must be 1 to 1024 visible characters with no spaces");
    if (r.username !== undefined && (typeof r.username !== "string" || !usernameShape.test(r.username))) throw new ErrInvalid('username must be 1 to 100 visible characters with no spaces or ":"');
    return r.username === undefined ? { kind: "token", token: r.token } : { kind: "token", token: r.token, username: r.username as string };
  }
  throw new ErrInvalid('credential kind must be "public", "token" or "deploy-key"');
}

// credentialInput turns a requested credential into what to store: a deploy
// key the project already has is kept ("keep"); otherwise one is made now
// (label names it in the key's comment).
export async function credentialInput(
  store: Store,
  req: GitCredentialRequest,
  projectId: string | undefined,
  label: string,
  keygen: CommandRunner,
): Promise<GitCredentialInput | "keep"> {
  if (req.kind !== "deploy-key") return req;
  if (projectId !== undefined && store.getGitCredential(projectId)?.kind === "deploy-key") return "keep";
  return { kind: "deploy-key", ...(await generateDeployKey(label, keygen)) };
}

// GitAuth is the environment of one git step, the values the build log must
// never show, and what to remove once the step is done (a deploy key's file).
export interface GitAuth {
  env: Record<string, string>;
  secrets: string[];
  cleanup(): Promise<void>;
}

export type GitAuthFn = (projectId: string, config: GitConfig) => Promise<GitAuth | null>;

// nextGitConfigIndex: GIT_CONFIG_* entries already in NBO's own environment
// (an operator's, or the tests' url rewrites) are kept; the header is added after them.
function nextGitConfigIndex(env: NodeJS.ProcessEnv): number {
  const n = Number(env.GIT_CONFIG_COUNT ?? "0");
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

// headerAuth: an Authorization header for one repository's URL only, and
// no redirects followed (git would send the header on to where a redirect
// points, which could be another host).
export function headerAuth(repo: string, username: string, token: string): GitAuth {
  const basic = Buffer.from(`${username}:${token}`).toString("base64");
  const i = nextGitConfigIndex(process.env);
  return {
    env: {
      GIT_CONFIG_COUNT: String(i + 2),
      [`GIT_CONFIG_KEY_${i}`]: `http.${repo}.extraHeader`,
      [`GIT_CONFIG_VALUE_${i}`]: `Authorization: Basic ${basic}`,
      [`GIT_CONFIG_KEY_${i + 1}`]: "http.followRedirects",
      [`GIT_CONFIG_VALUE_${i + 1}`]: "false",
    },
    secrets: [token, basic],
    cleanup: async () => {},
  };
}

// shellQuote: one argument for the sh that runs GIT_SSH_COMMAND (forward
// slashes, so a Windows path keeps its separators).
const shellQuote = (s: string): string => `'${s.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;

// publishedHostsFile: the published host keys of the big git hosts
// (git-host-keys.ts), rewritten next to known_hosts before each use so it
// always matches this NBO's list.
export function publishedHostsFile(knownHostsFile: string): string {
  return join(dirname(knownHostsFile), "known_hosts.published");
}

async function deployKeyAuth(privateKey: string, knownHostsFile: string): Promise<GitAuth> {
  await mkdir(dirname(knownHostsFile), { recursive: true });
  const published = publishedHostsFile(knownHostsFile);
  // Written aside and renamed, so a step running at the same time never reads it half written.
  const next = `${published}.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFile(next, `${publishedHostKeys.join("\n")}\n`);
  try {
    await rename(next, published);
  } catch (err) {
    // Windows refuses to replace a file another step has open; that copy has the same list.
    await rm(next, { force: true });
    if (!existsSync(published)) throw err;
  }
  const dir = await mkdtemp(join(tmpdir(), keyDirPrefix));
  const file = join(dir, "id_ed25519");
  try {
    await writeFile(file, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, { mode: 0o600 });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    env: {
      GIT_SSH_COMMAND: [
        "ssh",
        `-i ${shellQuote(file)}`,
        "-o IdentitiesOnly=yes",
        "-o BatchMode=yes",
        // github.com, gitlab.com and bitbucket.org are checked against their
        // published keys from the first connection; any other host is
        // remembered on first use in NBO's own file, and a changed key is
        // refused either way.
        `-o GlobalKnownHostsFile=${shellQuote(published)}`,
        `-o UserKnownHostsFile=${shellQuote(knownHostsFile)}`,
        "-o StrictHostKeyChecking=accept-new",
      ].join(" "),
    },
    secrets: [privateKey.trim()],
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

const keyDirPrefix = "nbo-git-key-";

// sweepStaleGitKeys removes deploy key folders (and key pairs being made) a
// stopped process left in the temporary folder. main runs it once at start.
// Only folders older than before (default: when this process started) go,
// so a folder another NBO process sharing the folder is using now stays.
export function sweepStaleGitKeys(dir: string = tmpdir(), before: number = Date.now() - process.uptime() * 1000): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(keyDirPrefix) && !name.startsWith("nbo-keygen-")) continue;
    try {
      if (statSync(join(dir, name)).mtimeMs >= before) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// createGitCredentials: the git environment for a project's repository, or
// null for a public one. legacy reads a linked project's installation token;
// knownHostsFile is where deploy-key steps keep host keys (main: next to the
// database). Callers run cleanup in finally.
export function createGitCredentials(store: Store, opts: { legacy?: LegacyGitHub; knownHostsFile?: string }): GitAuthFn {
  return async (projectId, config) => {
    if (config.github) {
      if (!opts.legacy) throw new Error(lostAccessMessage(config.github.fullName));
      return opts.legacy.env(config.github, config.repo);
    }
    const c = store.getGitCredential(projectId);
    if (!c) return null;
    const secret = store.openGitCredential(projectId);
    if (secret === undefined) return null;
    if (c.kind === "token") return headerAuth(config.repo, c.username || "x-access-token", secret);
    if (!opts.knownHostsFile) throw new Error("NBO has no known_hosts file for deploy keys");
    return deployKeyAuth(secret, opts.knownHostsFile);
  };
}

// withGitAuth runs fn with the project's git environment (undefined for a
// public repository) and always cleans up.
export async function withGitAuth<T>(gitAuth: GitAuthFn | undefined, projectId: string, config: GitConfig, fn: (env: Record<string, string> | undefined) => Promise<T>): Promise<T> {
  const auth = gitAuth ? await gitAuth(projectId, config) : null;
  try {
    return await fn(auth?.env);
  } finally {
    await auth?.cleanup();
  }
}

// generateDeployKey makes an ed25519 key pair with ssh-keygen in a private
// temporary folder, reads both halves and removes the folder.
export async function generateDeployKey(projectId: string, run: CommandRunner): Promise<{ publicKey: string; privateKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), "nbo-keygen-"));
  try {
    const file = join(dir, "id_ed25519");
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `nbo-${projectId}`, "-f", file], { timeoutMs: 30_000 });
    const privateKey = await readFile(file, "utf8");
    const publicKey = (await readFile(`${file}.pub`, "utf8")).trim();
    return { publicKey, privateKey };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
