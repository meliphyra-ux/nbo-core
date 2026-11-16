// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createStore, ErrInvalidEnvironmentConfig, type Store } from "../../store/store.js";
import { createSetup, type SetupRequest } from "../setup.js";
import { lsRemoteHead } from "../../git/gitremote.js";
import type { CloudSetup, Preflight } from "../../clouds/cloud-setup.js";
import type { Build } from "../../git/git.js";

const openStores: Store[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const s of openStores.splice(0)) s.close();
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-setup-"));
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

async function makeRepo(): Promise<{ repoPath: string; head: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "controlplane-setup-repo-"));
  scratch.push(repoPath);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await writeFile(join(repoPath, "a.txt"), "a");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { repoPath, head: git("rev-parse", "HEAD") };
}

const readyPreflight: Preflight = {
  gcloud: {
    installed: true,
    account: "me@example.com",
    project: "my-proj",
    region: "europe-north1",
    ready: true,
    reason: null,
  },
  docker: { installed: true, running: true, ready: true, reason: null },
  kubernetes: { reachable: true, context: "kind-nbo-local", ready: true, reason: null },
};

function fakeCloudSetup(
  overrides: { preflight?: Preflight; ensureError?: Error } = {},
): CloudSetup & { ensured: [string, string][] } {
  const ensured: [string, string][] = [];
  return {
    ensured,
    async preflight() {
      return overrides.preflight ?? readyPreflight;
    },
    async ensureCloudRun(project, region) {
      ensured.push([project, region]);
      if (overrides.ensureError) throw overrides.ensureError;
      return { project, region, arRepo: `${region}-docker.pkg.dev/${project}/nbo` };
    },
  };
}

function fakeQueue(store: Store) {
  const enqueued: [string, string][] = [];
  return {
    enqueued,
    enqueue(projectId: string, revision: string): Build {
      enqueued.push([projectId, revision]);
      return store.createQueuedBuild(projectId, revision);
    },
  };
}

const publicUrl = "https://github.com/acme/storefront.git";

// The https URL the API accepts is mapped to a real local repo at the
// one git boundary setup uses, so ls-remote runs for real.
function lsRemoteVia(repoPath: string) {
  return (repo: string, branch: string) => lsRemoteHead(repo === publicUrl ? repoPath : repo, branch);
}

function request(overrides: Partial<SetupRequest> = {}): SetupRequest {
  return {
    name: "storefront",
    repo: publicUrl,
    productionBranch: "main",
    framework: "static",
    spa: false,
    buildCommand: "npm run build",
    outputDir: "dist",
    clouds: [{ target: "kubernetes" }],
    ...overrides,
  };
}

async function harness(opts: { preflight?: Preflight; ensureError?: Error; repoPath?: string } = {}) {
  const store = await openTestStore();
  const repo = opts.repoPath ? { repoPath: opts.repoPath, head: "" } : await makeRepo();
  const cloudSetup = fakeCloudSetup(opts);
  const queue = fakeQueue(store);
  const setup = createSetup({ store, cloudSetup, queue, lsRemote: lsRemoteVia(repo.repoPath) });
  return { store, cloudSetup, queue, setup, head: repo.head };
}

describe("createSetup.start validation", () => {
  it("rejects a non-https repo, a bad name, a bad outputDir, duplicate cloud targets", async () => {
    const { setup } = await harness();
    expect(() => setup.start(request({ repo: "git@github.com:acme/x.git" }))).toThrow(
      /needs credential kind "deploy-key"/,
    );
    expect(() => setup.start(request({ repo: "http://github.com/acme/x.git" }))).toThrow(/https:\/\//);
    expect(() => setup.start(request({ repo: "file:///tmp/x" }))).toThrow(ErrInvalidEnvironmentConfig);
    expect(() => setup.start(request({ name: "Store Front" }))).toThrow(/lowercase letters, numbers and hyphens/);
    expect(() => setup.start(request({ name: "-bad" }))).toThrow(ErrInvalidEnvironmentConfig);
    expect(() => setup.start(request({ outputDir: "../etc" }))).toThrow(/outputDir/);
    expect(() => setup.start(request({ rootDirectory: "../etc" }))).toThrow(/rootDirectory/);
    expect(() => setup.start(request({ buildCommand: "" }))).toThrow(/buildCommand/);
    expect(() => setup.start(request({ clouds: [] }))).toThrow(/clouds/);
    expect(() => setup.start(request({ clouds: [{ target: "kubernetes" }, { target: "kubernetes" }] }))).toThrow(
      /once/,
    );
    expect(() =>
      setup.start(
        request({ clouds: [{ target: "cloudrun", mode: "manual", project: "", region: "us-central1", arRepo: "x" }] }),
      ),
    ).toThrow(/project/);
  });
});

describe("cloud choice validation", () => {
  it("rejects GCP project, region and repository strings gcloud/docker could misread", async () => {
    const { setup } = await harness();
    const manual = (project: string, region: string, arRepo: string) =>
      request({ clouds: [{ target: "cloudrun", mode: "manual", project, region, arRepo }] });
    expect(() =>
      setup.start(manual("--impersonate-service-account=x", "us-east1", "us-east1-docker.pkg.dev/x/nbo")),
    ).toThrow(/project/);
    expect(() =>
      setup.start(manual("my-proj-1", "--verbosity=debug", "us-east1-docker.pkg.dev/my-proj-1/nbo")),
    ).toThrow(/region/);
    expect(() => setup.start(manual("my-proj-1", "us-east1", "evil.example.com/my-proj-1/nbo"))).toThrow(/arRepo/);
    expect(() => setup.start(manual("my-proj-1", "us-east1", "europe-west1-docker.pkg.dev/my-proj-1/nbo"))).toThrow(
      /arRepo/,
    );
    expect(() => setup.start(request({ clouds: [{ target: "cloudrun", mode: "auto", region: "-x" }] }))).toThrow(
      /region/,
    );
  });
});

describe("createSetup.start", () => {
  it("stores rootDirectory in the git config", async () => {
    const { store, setup } = await harness();
    const p = setup.start(request({ rootDirectory: "apps/web" }));
    expect(store.getGitConfig(p.id).rootDirectory).toBe("apps/web");
    await setup.settled(p.id);
  });

  it("with local kubernetes creates env k8s, resolves head, marks ready and enqueues the head", async () => {
    const { store, queue, setup, head } = await harness();
    const p = setup.start(request());
    expect(p).toMatchObject({
      name: "storefront",
      setupStatus: "provisioning",
      edgeHost: "storefront.127.0.0.1.sslip.io",
    });
    expect(store.getGitConfig(p.id)).toMatchObject({
      repo: publicUrl,
      productionBranch: "main",
      framework: "static",
      outputDir: "dist",
    });

    await setup.settled(p.id);

    const envs = store.listEnvironments(p.id);
    expect(envs.map((e) => [e.name, e.target])).toEqual([["k8s", "kubernetes"]]);
    expect(JSON.parse(envs[0]!.config)).toEqual({ cronsEnabled: true });
    expect(store.getProject(p.id)).toMatchObject({ setupStatus: "ready", setupError: "", lastSeenSha: head });
    expect(queue.enqueued).toEqual([[p.id, head]]);
  });

  it("with cloudrun auto provisions via ensureCloudRun using preflight's project and region", async () => {
    const { store, cloudSetup, setup } = await harness();
    const p = setup.start(request({ clouds: [{ target: "cloudrun", mode: "auto" }] }));
    await setup.settled(p.id);
    expect(cloudSetup.ensured).toEqual([["my-proj", "europe-north1"]]);
    const env = store.listEnvironments(p.id)[0]!;
    expect(env).toMatchObject({ name: "cloudrun", target: "cloudrun" });
    expect(JSON.parse(env.config)).toEqual({
      project: "my-proj",
      region: "europe-north1",
      arRepo: "europe-north1-docker.pkg.dev/my-proj/nbo",
      cronsEnabled: true,
    });
    expect(store.getProject(p.id).setupStatus).toBe("ready");
  });

  it("with cloudrun auto and no gcloud region uses us-central1", async () => {
    const { cloudSetup, setup } = await harness({
      preflight: { ...readyPreflight, gcloud: { ...readyPreflight.gcloud, region: null } },
    });
    const p = setup.start(request({ clouds: [{ target: "cloudrun", mode: "auto" }] }));
    await setup.settled(p.id);
    expect(cloudSetup.ensured).toEqual([["my-proj", "us-central1"]]);
  });

  it("with cloudrun auto and a requested region uses that region", async () => {
    const { cloudSetup, setup } = await harness();
    const p = setup.start(request({ clouds: [{ target: "cloudrun", mode: "auto", region: "asia-east1" }] }));
    await setup.settled(p.id);
    expect(cloudSetup.ensured).toEqual([["my-proj", "asia-east1"]]);
  });

  it("with cloudrun auto and gcloud not ready marks needs-setup with the preflight reason", async () => {
    const { store, setup, queue } = await harness({
      preflight: {
        ...readyPreflight,
        gcloud: {
          ...readyPreflight.gcloud,
          account: null,
          ready: false,
          reason: "gcloud is not logged in — run gcloud auth login",
        },
      },
    });
    const p = setup.start(request({ clouds: [{ target: "cloudrun", mode: "auto" }] }));
    await setup.settled(p.id);
    expect(store.getProject(p.id)).toMatchObject({
      setupStatus: "needs-setup",
      setupError: "gcloud is not logged in — run gcloud auth login",
    });
    expect(queue.enqueued).toEqual([]);
  });

  it("with both clouds creates k8s and cloudrun environments, crons on the first only", async () => {
    const { store, setup } = await harness();
    const p = setup.start(
      request({
        clouds: [
          { target: "kubernetes" },
          {
            target: "cloudrun",
            mode: "manual",
            project: "my-proj-1",
            region: "us-east1",
            arRepo: "us-east1-docker.pkg.dev/my-proj-1/nbo",
          },
        ],
      }),
    );
    await setup.settled(p.id);
    const envs = store.listEnvironments(p.id);
    expect(envs.map((e) => [e.name, JSON.parse(e.config)])).toEqual([
      ["k8s", { cronsEnabled: true }],
      [
        "cloudrun",
        {
          project: "my-proj-1",
          region: "us-east1",
          arRepo: "us-east1-docker.pkg.dev/my-proj-1/nbo",
          cronsEnabled: false,
        },
      ],
    ]);
  });

  it("setup with an unreachable repo marks the project needs-setup with git's real error", async () => {
    const { store, setup, queue } = await harness({ repoPath: join(tmpdir(), `nbo-no-such-repo-${Date.now()}`) });
    const p = setup.start(request());
    await setup.settled(p.id);
    const got = store.getProject(p.id);
    expect(got.setupStatus).toBe("needs-setup");
    expect(got.setupError).toMatch(/git ls-remote|does not appear to be a git repository|not found/i);
    expect(queue.enqueued).toEqual([]);
    expect(store.listEnvironments(p.id)).toHaveLength(1);
  });

  it("setup where ensureCloudRun fails marks needs-setup and keeps the project and git config", async () => {
    const { store, setup } = await harness({
      ensureError: new Error("enabling the Cloud Run and Artifact Registry APIs failed: billing disabled"),
    });
    const p = setup.start(request({ clouds: [{ target: "cloudrun", mode: "auto" }] }));
    await setup.settled(p.id);
    expect(store.getProject(p.id)).toMatchObject({
      setupStatus: "needs-setup",
      setupError: "enabling the Cloud Run and Artifact Registry APIs failed: billing disabled",
    });
    expect(store.getGitConfig(p.id).repo).toBe(publicUrl);
    expect(store.listEnvironments(p.id)).toHaveLength(0);
  });

  it("rejects a duplicate project name", async () => {
    const { setup } = await harness();
    const p = setup.start(request());
    await setup.settled(p.id);
    expect(() => setup.start(request())).toThrow(/already exists/);
  });
});

describe("createSetup.retry", () => {
  it("retry after a fix completes setup without duplicating environments", async () => {
    const store = await openTestStore();
    const { repoPath, head } = await makeRepo();
    let failing = true;
    const cloudSetup = fakeCloudSetup();
    const queue = fakeQueue(store);
    const setup = createSetup({
      store,
      cloudSetup,
      queue,
      lsRemote: async (repo, branch) => {
        if (failing) throw new Error("git ls-remote failed: could not resolve host");
        return lsRemoteVia(repoPath)(repo, branch);
      },
    });
    const p = setup.start(request({ clouds: [{ target: "kubernetes" }, { target: "cloudrun", mode: "auto" }] }));
    await setup.settled(p.id);
    expect(store.getProject(p.id).setupStatus).toBe("needs-setup");

    failing = false;
    const retried = setup.retry(p.id);
    expect(retried.setupStatus).toBe("provisioning");
    await setup.settled(p.id);

    expect(store.getProject(p.id)).toMatchObject({ setupStatus: "ready", setupError: "" });
    expect(store.listEnvironments(p.id).map((e) => e.name)).toEqual(["k8s", "cloudrun"]);
    expect(cloudSetup.ensured).toHaveLength(1);
    expect(queue.enqueued).toEqual([[p.id, head]]);
  });

  it("retry with new clouds replaces the pending choices", async () => {
    const { store, setup } = await harness({ ensureError: new Error("billing disabled") });
    const p = setup.start(request({ clouds: [{ target: "cloudrun", mode: "auto" }] }));
    await setup.settled(p.id);
    setup.retry(p.id, [{ target: "kubernetes" }]);
    await setup.settled(p.id);
    expect(store.getProject(p.id).setupStatus).toBe("ready");
    expect(store.listEnvironments(p.id).map((e) => e.name)).toEqual(["k8s"]);
  });
});

describe("createSetup.addCloud", () => {
  it("adds the other cloud to an existing project, crons staying where they were", async () => {
    const { setup } = await harness();
    const p = setup.start(request());
    await setup.settled(p.id);
    const env = await setup.addCloud(p.id, { target: "cloudrun", mode: "auto" });
    expect(env).toMatchObject({ name: "cloudrun", target: "cloudrun" });
    expect(JSON.parse(env.config).cronsEnabled).toBe(false);
  });

  it("refuses a target the project already has", async () => {
    const { setup } = await harness();
    const p = setup.start(request());
    await setup.settled(p.id);
    await expect(setup.addCloud(p.id, { target: "kubernetes" })).rejects.toThrow(/already/);
  });

  it("gives an ephemeral stage its own s-pv-<id>-<slot> row with crons off, Production untouched", async () => {
    const { setup, store } = await harness();
    const p = setup.start(request());
    await setup.settled(p.id);
    const prodBefore = store.listEnvironments(p.id, { includeArchived: true });
    const pv = store.createEphemeralStage(p.id, {
      branch: "feature/x",
      host: "feature-x--storefront.127.0.0.1.sslip.io",
      expiresAt: "",
      label: "",
    });
    const stage = store.getStage(pv.id);
    const k8s = await setup.addCloud(p.id, { target: "kubernetes" }, { stageId: pv.id });
    expect(k8s).toMatchObject({ name: `s-${stage.name}-k8s`, target: "kubernetes", stageId: pv.id });
    expect(JSON.parse(k8s.config).cronsEnabled).toBe(false);
    const pv2 = store.createEphemeralStage(p.id, {
      branch: "feature/y",
      host: "feature-y--storefront.127.0.0.1.sslip.io",
      expiresAt: "",
      label: "",
    });
    const cr = await setup.addCloud(p.id, { target: "cloudrun", mode: "auto" }, { stageId: pv2.id });
    expect(cr).toMatchObject({ name: `s-${store.getStage(pv2.id).name}-cr`, stageId: pv2.id });
    expect(JSON.parse(cr.config).cronsEnabled).toBe(false);
    expect(store.listEnvironments(p.id, { includeArchived: true })).toEqual(prodBefore);
    await expect(setup.addCloud(p.id, { target: "kubernetes" }, { stageId: pv.id })).rejects.toThrow(/already/);
  });
});
