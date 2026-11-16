// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createStore, type Store } from "../../store/store.js";
import { createGitCredentials, sweepStaleGitKeys } from "../git-credentials.js";
import { ErrSecretKey } from "../../store/secrets.js";
import { rewriteGitUrl } from "../../testing.js";
import type { GitConfig } from "../git.js";
import { startHarness, deployedProject, noCommands, type Harness } from "../../__tests__/v2-harness.js";

const TOKEN = "tok_SEEDED_123";
const basicOf = (user: string, token: string) => Buffer.from(`${user}:${token}`).toString("base64");
const httpsRepo = "https://git.example.test/acme/private.git";
const config = (repo: string): GitConfig => ({
  repo,
  productionBranch: "main",
  framework: "static",
  buildCommand: "true",
  outputDir: "dist",
});
const hasSshKeygen = spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error === undefined;

describe("createGitCredentials", () => {
  let dir: string;
  let store: Store;
  let projectId: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nbo-gitcred-"));
    store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
    projectId = store.createProject("shop").id;
  });
  afterAll(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("gives no environment to a project without a credential", async () => {
    store.deleteGitCredential(projectId);
    expect(await createGitCredentials(store, {})(projectId, config(httpsRepo))).toBeNull();
  });

  it("a token becomes an Authorization header for that repository, with the token and its base64 in secrets", async () => {
    store.setGitCredential(projectId, { kind: "token", token: TOKEN });
    const auth = await createGitCredentials(store, {})(projectId, config(httpsRepo));
    expect(auth).not.toBeNull();
    const values = Object.entries(auth!.env);
    const key = values.find(([k, v]) => k.startsWith("GIT_CONFIG_KEY_") && v === `http.${httpsRepo}.extraHeader`);
    expect(key, JSON.stringify(auth!.env)).toBeDefined();
    const index = key![0].slice("GIT_CONFIG_KEY_".length);
    expect(auth!.env[`GIT_CONFIG_VALUE_${index}`]).toBe(`Authorization: Basic ${basicOf("x-access-token", TOKEN)}`);
    expect(Number(auth!.env.GIT_CONFIG_COUNT)).toBeGreaterThan(Number(index));
    expect(auth!.secrets).toEqual(expect.arrayContaining([TOKEN, basicOf("x-access-token", TOKEN)]));
    await auth!.cleanup();
  });

  it("a token's git steps never follow a redirect, so the header can't go to another host", async () => {
    store.setGitCredential(projectId, { kind: "token", token: TOKEN });
    const auth = await createGitCredentials(store, {})(projectId, config(httpsRepo));
    const pairs = Object.entries(auth!.env).filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"));
    const follow = pairs.find(([, v]) => v === "http.followRedirects");
    expect(follow, JSON.stringify(auth!.env)).toBeDefined();
    expect(auth!.env[`GIT_CONFIG_VALUE_${follow![0].slice("GIT_CONFIG_KEY_".length)}`]).toBe("false");
    expect(Number(auth!.env.GIT_CONFIG_COUNT)).toBe(
      Math.max(...pairs.map(([k]) => Number(k.slice("GIT_CONFIG_KEY_".length)))) + 1,
    );
    // git reads the pair as config.
    const read = spawnSync("git", ["config", "--get", "http.followRedirects"], {
      env: { ...process.env, ...auth!.env },
      encoding: "utf8",
    });
    expect(read.stdout.trim()).toBe("false");
  });

  it("a token with a user name puts that name in the header", async () => {
    store.setGitCredential(projectId, { kind: "token", token: TOKEN, username: "deploy-bot" });
    const auth = await createGitCredentials(store, {})(projectId, config(httpsRepo));
    expect(Object.values(auth!.env)).toContain(`Authorization: Basic ${basicOf("deploy-bot", TOKEN)}`);
    expect(store.getGitCredential(projectId)).toEqual(
      expect.objectContaining({ kind: "token", username: "deploy-bot" }),
    );
  });

  it("a deploy key is written to a 0600 file that cleanup removes, with host keys checked", async () => {
    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n";
    store.setGitCredential(projectId, { kind: "deploy-key", privateKey, publicKey: "ssh-ed25519 AAAAtest nbo-x" });
    const knownHostsFile = join(dir, "known_hosts");
    const auth = await createGitCredentials(store, { knownHostsFile })(
      projectId,
      config("ssh://git@git.example.test/acme/private.git"),
    );
    const cmd = auth!.env.GIT_SSH_COMMAND!;
    expect(cmd).toContain("IdentitiesOnly=yes");
    expect(cmd).toContain("StrictHostKeyChecking=accept-new");
    expect(cmd).not.toMatch(/StrictHostKeyChecking=no\b/);
    expect(cmd).toContain(`UserKnownHostsFile='${knownHostsFile.replace(/\\/g, "/")}'`);
    const file = /-i '([^']+)'/.exec(cmd)![1]!;
    expect(await readFile(file, "utf8")).toBe(privateKey);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(Object.keys(auth!.env).some((k) => k.startsWith("GIT_CONFIG_KEY_"))).toBe(false);
    await auth!.cleanup();
    expect(existsSync(file)).toBe(false);
  });

  it("first connections to github.com, gitlab.com and bitbucket.org are checked against their published host keys", async () => {
    store.setGitCredential(projectId, {
      kind: "deploy-key",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n",
      publicKey: "ssh-ed25519 AAAAtest",
    });
    const knownHostsFile = join(dir, "known_hosts");
    const auth = await createGitCredentials(store, { knownHostsFile })(
      projectId,
      config("git@github.com:acme/private.git"),
    );
    try {
      const cmd = auth!.env.GIT_SSH_COMMAND!;
      const published = /GlobalKnownHostsFile='([^']+)'/.exec(cmd)?.[1];
      expect(published, cmd).toBeDefined();
      const text = await readFile(published!, "utf8");
      for (const line of [
        "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
        "gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf",
        "bitbucket.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO",
      ])
        expect(text).toContain(line);
      for (const host of ["github.com", "gitlab.com", "bitbucket.org"]) {
        expect(text).toMatch(new RegExp(`^${host.replace(".", "\\.")} ssh-rsa `, "m"));
        expect(text).toMatch(new RegExp(`^${host.replace(".", "\\.")} ecdsa-sha2-nistp256 `, "m"));
      }
      if (hasSshKeygen) {
        // ssh's own parser finds each host in the file.
        for (const host of ["github.com", "gitlab.com", "bitbucket.org"]) {
          expect(spawnSync("ssh-keygen", ["-F", host, "-f", published!], { encoding: "utf8" }).stdout).toContain(host);
        }
      }
      // Other hosts are remembered on first use in NBO's own file.
      expect(cmd).toContain("StrictHostKeyChecking=accept-new");
      expect(cmd).toContain(`UserKnownHostsFile='${knownHostsFile.replace(/\\/g, "/")}'`);
    } finally {
      await auth!.cleanup();
    }
  });

  it("sweepStaleGitKeys removes key folders a stopped process left behind", async () => {
    const left = await mkdtemp(join(dir, "nbo-git-key-"));
    const fresh = await mkdtemp(join(dir, "nbo-git-key-"));
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(left, old, old);
    // Folders made since "before" (another process's, in use) stay.
    sweepStaleGitKeys(dir, Date.now() - 60_000);
    expect(existsSync(left)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    await rm(fresh, { recursive: true, force: true });
  });

  it("the store never hands out the sealed value through getGitCredential", () => {
    store.setGitCredential(projectId, { kind: "token", token: TOKEN });
    expect(JSON.stringify(store.getGitCredential(projectId))).not.toContain(TOKEN);
  });

  it("a git token is sealed data for the secret key check", async () => {
    const d = await mkdtemp(join(tmpdir(), "nbo-gitcred-key-"));
    try {
      const path = join(d, "test.db");
      const s1 = createStore(path, { secretKey: randomBytes(32) });
      const p = s1.createProject("only-token").id;
      s1.setGitCredential(p, { kind: "token", token: TOKEN });
      s1.close();
      const s2 = createStore(path);
      expect(s2.hasSealedSecrets()).toBe(true);
      s2.setSecretKey(randomBytes(32));
      expect(() => s2.verifySecretKey()).toThrow(ErrSecretKey);
      s2.close();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("deleting a project deletes its credential row", () => {
    const p = store.createProject("goes-away").id;
    store.setGitCredential(p, { kind: "token", token: TOKEN });
    store.deleteProject(p);
    expect(store.getGitCredential(p)).toBeUndefined();
  });
});

describe("git credential routes", () => {
  let h: Harness;
  let projectId: string;
  const gitBody = (overrides: Record<string, unknown> = {}) => ({
    repo: httpsRepo,
    productionBranch: "main",
    framework: "static",
    buildCommand: "true",
    outputDir: "dist",
    ...overrides,
  });

  beforeAll(async () => {
    h = await startHarness({ v2: { run: noCommands } });
    h.store.setSecretKey(randomBytes(32));
    projectId = await deployedProject(h);
  }, 60_000);
  afterAll(async () => h.close());

  it("never shows a stored token: not in PUT's answer, GET .../git or the summary", async () => {
    const put = await h.call(
      "PUT",
      `/projects/${projectId}/git`,
      gitBody({ credential: { kind: "token", token: TOKEN } }),
    );
    expect(put.status, put.text).toBe(200);
    const get = await h.call("GET", `/projects/${projectId}/git`);
    expect(get.status).toBe(200);
    expect(get.json.credential).toEqual({ kind: "token" });
    const summary = await h.call("GET", `/projects/${projectId}/summary`);
    for (const text of [put.text, get.text, summary.text]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(basicOf("x-access-token", TOKEN));
    }
  });

  it("a build whose clone fails keeps the token out of its log and error", async () => {
    const missing = join(tmpdir(), `nbo-no-such-repo-${randomBytes(4).toString("hex")}`);
    const unrewrite = rewriteGitUrl(httpsRepo, missing);
    try {
      expect(
        (await h.call("PUT", `/projects/${projectId}/git`, gitBody({ credential: { kind: "token", token: TOKEN } })))
          .status,
      ).toBe(200);
      const res = await h.call("POST", `/projects/${projectId}/builds`, { revision: "a".repeat(40) });
      expect(res.status, res.text).toBe(202);
      await h.v2.queue.idle(projectId);
      const build = h.store.getBuild(res.json.id);
      expect(build.status).toBe("failed");
      expect(build.log).toContain("git");
      const view = await h.call("GET", `/builds/${build.id}`);
      for (const text of [build.log, build.error, view.text]) {
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(basicOf("x-access-token", TOKEN));
      }
    } finally {
      unrewrite();
    }
  });

  it("a repository moved to another host needs its credential again; the stored token never goes there", async () => {
    expect(
      (await h.call("PUT", `/projects/${projectId}/git`, gitBody({ credential: { kind: "token", token: TOKEN } })))
        .status,
    ).toBe(200);
    for (const repo of [
      "https://evil.example.test/acme/private.git",
      "https://git.example.test:8443/acme/private.git",
    ]) {
      const res = await h.call("PUT", `/projects/${projectId}/git`, gitBody({ repo }));
      expect(res.status, repo).toBe(400);
      expect(res.json.error).toBe("the repository moved to another host: give its credential again");
    }
    expect(h.store.getGitConfig(projectId).repo).toBe(httpsRepo);
    const auth = await h.v2.gitAuth(projectId, h.store.getGitConfig(projectId));
    expect(Object.values(auth!.env).filter((v) => v.includes("evil.example.test"))).toEqual([]);
    await auth!.cleanup();
    // Another path on the same host keeps the token; a new host with a credential is fine.
    expect(
      (await h.call("PUT", `/projects/${projectId}/git`, gitBody({ repo: "https://git.example.test/acme/other.git" })))
        .status,
    ).toBe(200);
    const moved = await h.call(
      "PUT",
      `/projects/${projectId}/git`,
      gitBody({ repo: "https://evil.example.test/acme/private.git", credential: { kind: "public" } }),
    );
    expect(moved.status).toBe(200);
    expect(moved.json.credential).toEqual({ kind: "public" });
    expect(
      (await h.call("PUT", `/projects/${projectId}/git`, gitBody({ credential: { kind: "token", token: TOKEN } })))
        .status,
    ).toBe(200);
  });

  it("a deploy key does not follow a repository to another ssh host either", async () => {
    h.store.setGitCredential(projectId, {
      kind: "deploy-key",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n",
      publicKey: "ssh-ed25519 AAAAtest",
    });
    // Moving from https to ssh is another origin: the credential is given with it (the stored key is kept).
    expect(
      (await h.call("PUT", `/projects/${projectId}/git`, gitBody({ repo: "git@git.example.test:acme/private.git" })))
        .status,
    ).toBe(400);
    expect(
      (
        await h.call(
          "PUT",
          `/projects/${projectId}/git`,
          gitBody({ repo: "git@git.example.test:acme/private.git", credential: { kind: "deploy-key" } }),
        )
      ).status,
    ).toBe(200);
    expect(h.store.getGitCredential(projectId)?.publicKey).toBe("ssh-ed25519 AAAAtest");
    // The same host spelled the other way, and the default port, is the same host.
    expect(
      (
        await h.call(
          "PUT",
          `/projects/${projectId}/git`,
          gitBody({ repo: "ssh://git@git.example.test:22/acme/private.git" }),
        )
      ).status,
    ).toBe(200);
    for (const repo of [
      "git@other.example.test:acme/private.git",
      "ssh://git@git.example.test:2222/acme/private.git",
    ]) {
      const res = await h.call("PUT", `/projects/${projectId}/git`, gitBody({ repo }));
      expect(res.status, repo).toBe(400);
      expect(res.json.error).toBe("the repository moved to another host: give its credential again");
    }
    expect(
      (await h.call("PUT", `/projects/${projectId}/git`, gitBody({ credential: { kind: "token", token: TOKEN } })))
        .status,
    ).toBe(200);
  });

  it("refuses an ssh repository address without a deploy key", async () => {
    for (const repo of ["ssh://git@git.example.test/acme/private.git", "git@git.example.test:acme/private.git"]) {
      const res = await h.call(
        "PUT",
        `/projects/${projectId}/git`,
        gitBody({ repo, credential: { kind: "token", token: TOKEN } }),
      );
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('an ssh repository address needs credential kind "deploy-key"');
    }
  });

  it("refuses an import through a GitHub App, in setup and in git settings", async () => {
    const message =
      "importing through a GitHub App is a feature of the hosted dashboard; give repo and credential instead";
    const put = await h.call(
      "PUT",
      `/projects/${projectId}/git`,
      gitBody({ github: { installationId: 1, repoId: 2 } }),
    );
    expect(put.status).toBe(400);
    expect(put.json.error).toBe(message);
    const setup = await h.call("POST", "/projects/setup", {
      name: "from-app",
      github: { installationId: 1, repoId: 2 },
      productionBranch: "main",
      framework: "static",
      buildCommand: "true",
      clouds: [{ target: "kubernetes" }],
    });
    expect(setup.status).toBe(400);
    expect(setup.json.error).toBe(message);
  });

  it("setup takes a token credential and keeps it", async () => {
    const res = await h.call("POST", "/projects/setup", {
      name: "with-token",
      repo: "https://github.com/acme/storefront.git",
      productionBranch: "main",
      framework: "static",
      buildCommand: "mkdir dist && echo hi > dist/index.html",
      outputDir: "dist",
      clouds: [{ target: "kubernetes" }],
      credential: { kind: "token", token: TOKEN, username: "bot" },
    });
    expect(res.status, res.text).toBe(201);
    expect(res.text).not.toContain(TOKEN);
    const id = res.json.project.id as string;
    await h.v2.setup.settled(id);
    await h.v2.queue.idle(id);
    expect((await h.call("GET", `/projects/${id}/git`)).json.credential).toEqual({ kind: "token", username: "bot" });
  });

  it.skipIf(!hasSshKeygen)(
    "POST .../git/deploy-key makes a key pair and GET .../git shows its public half only",
    async () => {
      const made = await h.call("POST", `/projects/${projectId}/git/deploy-key`);
      expect(made.status, made.text).toBe(201);
      expect(made.json.publicKey).toMatch(/^ssh-ed25519 /);
      expect(made.text).not.toContain("PRIVATE KEY");
      const put = await h.call(
        "PUT",
        `/projects/${projectId}/git`,
        gitBody({ repo: "git@git.example.test:acme/private.git", credential: { kind: "deploy-key" } }),
      );
      expect(put.status, put.text).toBe(200);
      const get = await h.call("GET", `/projects/${projectId}/git`);
      expect(get.json.credential).toEqual({ kind: "deploy-key", publicKey: made.json.publicKey });
      expect(get.text).not.toContain("PRIVATE KEY");
      expect(put.text).not.toContain("PRIVATE KEY");
    },
    30_000,
  );
});
