// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, type Store } from "../../store/store.js";
import { createGitCredentials } from "../git-credentials.js";
import { createLegacyGitHub, lostAccessMessage } from "../github-legacy.js";
import { lsRemoteHeads } from "../gitremote.js";
import type { GitConfig } from "../git.js";
import { startFakeGitHub, type FakeApp, type FakeGitHub } from "../../__tests__/fake-github.js";

// The read-only path for projects linked to the old per-server GitHub App
// (kept for a migration period): an installation token,
// narrowed to the one repository, as an Authorization header for git.
describe("github-legacy", () => {
  let fake: FakeGitHub;
  let app: FakeApp;
  let dir: string;
  let store: Store;
  let projectId: string;
  let config: GitConfig;
  let repoId: number;
  let installationId: number;

  beforeAll(async () => {
    fake = await startFakeGitHub();
    app = fake.createApp();
    installationId = fake.addInstallation({ account: "acme" });
    const repo = await fake.addRepo([installationId], { name: "storefront", owner: "acme", private: true });
    repoId = repo.id;
    dir = await mkdtemp(join(tmpdir(), "nbo-legacy-"));
    const dbPath = join(dir, "test.db");
    store = createStore(dbPath, { secretKey: randomBytes(32) });
    // What the old code stored: the app's settings under github_app and its
    // private key sealed among the server secrets.
    const raw = new DatabaseSync(dbPath);
    raw.prepare("INSERT INTO server_settings (key, value) VALUES ('github_app', ?)").run(
      JSON.stringify({
        appId: app.id,
        slug: app.slug,
        clientId: app.clientId,
        htmlUrl: app.htmlUrl,
        ownerLogin: app.ownerLogin,
        allowRepoCreation: false,
        createdAt: new Date().toISOString(),
      }),
    );
    raw.close();
    store.setServerSecret("github_private_key", app.pem);
    projectId = store.createProject("storefront").id;
    config = {
      repo: `${fake.url}/acme/storefront.git`,
      productionBranch: "main",
      framework: "static",
      buildCommand: "true",
      github: { installationId, repoId, fullName: "acme/storefront" },
    };
  }, 60_000);
  afterAll(async () => {
    store.close();
    await fake.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const tokenCalls = () =>
    fake.calls.filter((c) => c.method === "POST" && c.path === `/app/installations/${installationId}/access_tokens`);

  it("gives a linked project an installation-token header narrowed to its repository, and reuses it", async () => {
    const auth = createGitCredentials(store, { legacy: createLegacyGitHub(store, { api: fake.url }) });
    const first = await auth(projectId, config);
    expect(first).not.toBeNull();
    const header = Object.entries(first!.env).find(([k]) => k.startsWith("GIT_CONFIG_VALUE_"))?.[1] ?? "";
    expect(header).toMatch(/^Authorization: Basic /);
    const [user, token] = Buffer.from(header.slice("Authorization: Basic ".length), "base64")
      .toString("utf8")
      .split(":");
    expect(user).toBe("x-access-token");
    expect(fake.issuedTokens()).toContain(token);
    expect(first!.secrets).toContain(token);
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0]!.body).toEqual({ repository_ids: [repoId], permissions: { contents: "read" } });

    // The header is accepted by the fake's private repository.
    const heads = await lsRemoteHeads(config.repo, { env: first!.env });
    expect(heads.get("main")).toMatch(/^[0-9a-f]{40}$/);

    const second = await auth(projectId, config);
    expect(second!.env).toEqual(first!.env);
    expect(tokenCalls()).toHaveLength(1);
    await first!.cleanup();
    await second!.cleanup();
  });

  it("lists the tokens it holds in memory (the link's reply filter redacts them)", async () => {
    const legacy = createLegacyGitHub(store, { api: fake.url });
    expect(legacy.cachedTokens()).toEqual([]);
    const auth = await legacy.env(config.github!, config.repo);
    const header = Object.entries(auth!.env).find(([k]) => k.startsWith("GIT_CONFIG_VALUE_"))?.[1] ?? "";
    const token = Buffer.from(header.slice("Authorization: Basic ".length), "base64").toString("utf8").split(":")[1];
    expect(legacy.cachedTokens()).toEqual([token]);
    await auth!.cleanup();
  });

  it("without the legacy reader a linked project says the app can't reach it", async () => {
    const auth = createGitCredentials(store, {});
    await expect(auth(projectId, config)).rejects.toThrow(lostAccessMessage("acme/storefront"));
  });
});
