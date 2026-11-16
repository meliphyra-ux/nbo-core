// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { run } from "../builds/run.js";

// gitEnv disables any interactive credential prompt, so a private or
// mistyped repo fails fast with git's own error instead of hanging on
// a prompt nobody can answer (the control-plane has no terminal).
export const gitEnv = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

// isHttpsGitUrl accepts only https:// remotes with a host and a path
// and no embedded credentials. The URL flows into `git clone` /
// `git ls-remote` on the operator's machine, so file://, ssh, scp-like
// `git@host:` forms and local paths are refused at the API boundary.
export function isHttpsGitUrl(url: string): boolean {
  if (!url.startsWith("https://")) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.hostname === "") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return parsed.pathname.replace(/\/+$/, "").length > 1;
}

// isSshGitUrl accepts ssh://[user@]host[:port]/path and the scp-like
// user@host:path form, for projects with a deploy key. Host, user and path
// are plain names: nothing starting with "-" (which ssh would read as an
// option), no spaces, quotes or "..".
export function isSshGitUrl(url: string): boolean {
  const name = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
  const host = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
  const path = (p: string): boolean =>
    /^[A-Za-z0-9_~][A-Za-z0-9._~/-]*$/.test(p) && !p.split("/").includes("..") && p.replace(/\/+$/, "").length > 0;
  let m = /^ssh:\/\/(?:([^@/]+)@)?([^/:@]+)(?::(\d{1,5}))?\/(.+)$/.exec(url);
  if (m) {
    if (m[1] !== undefined && !name.test(m[1])) return false;
    if (m[3] !== undefined && (Number(m[3]) < 1 || Number(m[3]) > 65535)) return false;
    return host.test(m[2]!) && path(m[4]!);
  }
  m = /^([^@/:]+)@([^/:@]+):(.+)$/.exec(url);
  if (m) return name.test(m[1]!) && host.test(m[2]!) && path(m[3]!);
  return false;
}

// repoSlug derives a default project name from a repo URL: last path
// segment, minus ".git", lowercased, anything outside [a-z0-9-] → "-",
// trimmed of "-", capped at 40 chars.
export function repoSlug(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last
    .replace(/\.git$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// GitRemoteOptions: env adds to git's environment (a project's credential,
// git-credentials.ts).
export interface GitRemoteOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
}

// lsRemoteHead resolves a branch's current head sha without cloning.
export async function lsRemoteHead(repo: string, branch: string, options?: GitRemoteOptions): Promise<string> {
  const out = await run("git", ["ls-remote", "--", repo, `refs/heads/${branch}`], {
    env: { ...gitEnv, ...options?.env },
    timeoutMs: options?.timeoutMs ?? 30_000,
  });
  const line = out.split(/\r?\n/).find((l) => l.endsWith(`\trefs/heads/${branch}`));
  const sha = line?.split("\t")[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`branch "${branch}" not found in ${repo}`);
  return sha;
}

// parseLsRemoteHeads reads `git ls-remote --heads` output into branch → sha.
// Only `<40 hex>\trefs/heads/<name>` lines count: other refs, peeled
// entries (`^{}`) and lines with a malformed sha are skipped.
export function parseLsRemoteHeads(out: string): Map<string, string> {
  const heads = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref || !ref.startsWith("refs/heads/") || ref.endsWith("^{}")) continue;
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    heads.set(ref.slice("refs/heads/".length), sha);
  }
  return heads;
}

// lsRemoteHeads lists every branch head of a repo in one git call.
export async function lsRemoteHeads(repo: string, options?: GitRemoteOptions): Promise<Map<string, string>> {
  const out = await run("git", ["ls-remote", "--heads", "--", repo], {
    env: { ...gitEnv, ...options?.env },
    timeoutMs: options?.timeoutMs ?? 30_000,
  });
  return parseLsRemoteHeads(out);
}
