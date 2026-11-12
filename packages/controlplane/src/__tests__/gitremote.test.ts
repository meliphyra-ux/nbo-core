// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { isHttpsGitUrl, isSshGitUrl, repoSlug, lsRemoteHead, lsRemoteHeads, parseLsRemoteHeads } from "../gitremote.js";

const scratchDirs: string[] = [];
afterEach(async () => {
  for (const d of scratchDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function makeRepo(): Promise<{ repoPath: string; head: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "controlplane-gitremote-"));
  scratchDirs.push(repoPath);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await writeFile(join(repoPath, "a.txt"), "a");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { repoPath, head: git("rev-parse", "HEAD") };
}

describe("isHttpsGitUrl", () => {
  it.each([
    ["https://github.com/acme/store.git", true],
    ["https://gitlab.com/acme/group/store", true],
    ["https://git.example.com/x", true],
    ["http://github.com/acme/store.git", false],
    ["file:///tmp/repo", false],
    ["ssh://git@github.com/acme/store.git", false],
    ["git@github.com:acme/store.git", false],
    ["https://user:pass@github.com/acme/store.git", false],
    ["https://token@github.com/acme/store.git", false],
    ["https://github.com", false],
    ["https://github.com/", false],
    ["/home/me/repo", false],
    ["C:\repo", false],
    ["", false],
  ])("%s → %s", (url, ok) => {
    expect(isHttpsGitUrl(url)).toBe(ok);
  });
});

describe("isSshGitUrl", () => {
  it.each([
    ["ssh://git@github.com/acme/store.git", true],
    ["ssh://git@git.example.test:2222/acme/store.git", true],
    ["git@github.com:acme/store.git", true],
    ["ssh://-oProxyCommand=x/acme/store.git", false],
    ["git@-oProxyCommand=x:acme/store.git", false],
    ["-o@host:acme/store.git", false],
    ["git@host:../etc/passwd", false],
    ["git@host:-u", false],
    ["ssh://user:pass@host/acme/store.git", false],
    ["https://github.com/acme/store.git", false],
    ["git@host:", false],
  ])("%s → %s", (url, ok) => {
    expect(isSshGitUrl(url)).toBe(ok);
  });

  it("names a project after an scp-like address's repository", () => {
    expect(repoSlug("git@github.com:acme/Store.git")).toBe("store");
  });
});

describe("repoSlug", () => {
  it("turns https://github.com/Acme/Store_Front.git into store-front", () => {
    expect(repoSlug("https://github.com/Acme/Store_Front.git")).toBe("store-front");
  });
  it("trims trailing slashes and caps at 40 chars", () => {
    expect(repoSlug("https://gitlab.com/a/b/my-app/")).toBe("my-app");
    expect(repoSlug(`https://github.com/a/${"x".repeat(60)}`)).toHaveLength(40);
  });
});

describe("lsRemoteHead", () => {
  it("returns the branch head of a real local repo", async () => {
    const { repoPath, head } = await makeRepo();
    expect(await lsRemoteHead(repoPath, "main")).toBe(head);
  });

  it("rejects naming the branch when it doesn't exist", async () => {
    const { repoPath } = await makeRepo();
    await expect(lsRemoteHead(repoPath, "nope")).rejects.toThrow(/branch "nope" not found/);
  });

  it("rejects quickly on an unreachable repo", async () => {
    const missing = join(tmpdir(), `nbo-missing-repo-${Date.now()}`);
    const started = Date.now();
    await expect(lsRemoteHead(missing, "main")).rejects.toThrow(/git ls-remote/);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});


describe("parseLsRemoteHeads", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  it("reads <sha> TAB refs/heads/<name> lines, skipping peeled, tag and other refs", () => {
    const out = [
      `${a}\trefs/heads/main`,
      `${b}\trefs/heads/feature/x`,
      `${a}\trefs/tags/v1`,
      `${b}\trefs/tags/v1^{}`,
      `${a}\trefs/pull/3/head`,
      `${a}\tHEAD`,
      `${b}\trefs/heads/odd^{}`,
      "",
    ].join("\n");
    expect([...parseLsRemoteHeads(out)]).toEqual([
      ["main", a],
      ["feature/x", b],
    ]);
  });
  it("rejects shas that are not 40 lowercase hex characters", () => {
    const out = [`nothex\trefs/heads/one`, `${"A".repeat(40)}\trefs/heads/two`, `${a.slice(1)}\trefs/heads/three`, `${a}\trefs/heads/ok`].join("\r\n");
    expect([...parseLsRemoteHeads(out)]).toEqual([["ok", a]]);
  });
});

describe("lsRemoteHeads", () => {
  it("lists every branch head of a real local repo in one call", async () => {
    const { repoPath, head } = await makeRepo();
    execFileSync("git", ["branch", "staging"], { cwd: repoPath });
    execFileSync("git", ["tag", "-a", "v1", "-m", "v1"], { cwd: repoPath });
    const heads = await lsRemoteHeads(repoPath);
    expect([...heads.keys()].sort()).toEqual(["main", "staging"]);
    expect(heads.get("main")).toBe(head);
    expect(heads.get("staging")).toBe(head);
  });
  it("rejects on an unreachable repo", async () => {
    await expect(lsRemoteHeads(join(tmpdir(), `nbo-missing-repo-${Date.now()}`))).rejects.toThrow(/git ls-remote/);
  });
});
