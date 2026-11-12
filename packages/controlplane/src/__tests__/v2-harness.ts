// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Mode } from "../mode.js";
import type { CommandRunner } from "@nbo/deploy";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serveFetch } from "@nbo/nodehost";
import { createAdminMux, createRegistry, type Registry } from "@nbo/edge";
import { createStore, type Store } from "../store.js";
import { createMux, type Mux } from "../handlers.js";
import { wireV2, type V2, type V2Options } from "../v2.js";
import { createArtifactStore, type ArtifactStore } from "../artifacts.js";
import {
  fakeCloudSetup,
  fakeCloudTeardown,
  fakeDeploymentTrigger,
  makeLocalRepo,
  rewriteGitUrl,
  type FakeCloudSetup,
  type FakeCloudTeardown,
  type FakeDeploymentTrigger,
} from "../testing.js";

const repoUrl = "https://github.com/acme/storefront.git";

export interface Harness {
  store: Store;
  // dbPath is the store's SQLite file (tests read its raw bytes).
  dbPath: string;
  registry: Registry;
  // edgePuts records every split the edge accepted, in order.
  edgePuts: { host: string; weights: number[] }[];
  v2: V2;
  // mux is the handler call() uses (it also lists its routes).
  mux: Mux;
  // artifacts keeps each build's .nbo/ (under the harness's temp dir).
  artifacts: ArtifactStore;
  deploys: FakeDeploymentTrigger;
  cloud: FakeCloudSetup;
  teardown: FakeCloudTeardown;
  head: string;
  commit(message: string): Promise<string>;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any; text: string }>;
  stopEdge(): Promise<void>;
  close(): Promise<void>;
}

// mode "production" gives the store a secret key (connections can be
// saved) and wires production setup; deploys stay faked. v2 overrides
// wireV2 options (a fake kubectl runner, resolver, edge installer, ...).
// secretKey: give a dev-mode store a secret key too (production always has one).
export async function startHarness(opts: { mode?: Mode; v2?: Partial<V2Options>; secretKey?: boolean } = {}): Promise<Harness> {
  const cleanups: (() => Promise<void> | void)[] = [];
  const dir = await mkdtemp(join(tmpdir(), "controlplane-v2-"));
  const dbPath = join(dir, "test.db");
  const store = createStore(dbPath, opts.mode === "production" || opts.secretKey ? { secretKey: randomBytes(32) } : undefined);
  cleanups.push(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const registry = createRegistry();
  const admin = createAdminMux(registry);
  const edgePuts: Harness["edgePuts"] = [];
  const recording = async (request: Request) => {
    const res = await admin(request.clone());
    if (request.method === "PUT" && res.status === 204) {
      const body = (await request.json()) as { backends: { weight: number }[] };
      edgePuts.push({ host: decodeURIComponent(new URL(request.url).pathname.replace(/^\/targets\//, "")), weights: body.backends.map((b) => b.weight) });
    }
    return res;
  };
  const server = await new Promise<Server>((resolve) => {
    const s = serveFetch(recording, { host: "127.0.0.1", port: 0 }, () => resolve(s));
  });
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const repo = await makeLocalRepo();
  cleanups.push(() => rm(repo.repoPath, { recursive: true, force: true }));
  cleanups.push(rewriteGitUrl(repoUrl, repo.repoPath));

  const artifactsDir = join(dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const artifacts = createArtifactStore(artifactsDir, (projectId) => store.listBuilds(projectId).map((b) => b.id));
  const deploys = fakeDeploymentTrigger(store);
  const cloud = fakeCloudSetup();
  const teardown = fakeCloudTeardown();
  const v2 = wireV2(store, {
    deploymentTrigger: deploys,
    cloudSetup: cloud,
    cloudTeardown: teardown,
    edgeAdminUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    edgePublicPort: 9443,
    artifacts,
    mode: opts.mode,
    ...opts.v2,
  });
  const mux = createMux(store, deploys, v2.queue, v2);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await mux(
      new Request(`http://cp${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }),
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, json, text };
  };
  return {
    store,
    dbPath,
    registry,
    edgePuts,
    v2,
    mux,
    artifacts,
    deploys,
    cloud,
    teardown,
    head: repo.head,
    commit: repo.commit,
    call,
    stopEdge: () => new Promise<void>((r) => server.close(() => r())),
    async close() {
      for (const c of cleanups.splice(0).reverse()) await c();
    },
  };
}

export const staticSetup = (overrides: Record<string, unknown> = {}) => ({
  name: "storefront",
  repo: repoUrl,
  productionBranch: "main",
  framework: "static",
  spa: false,
  buildCommand: "mkdir dist && echo hi > dist/index.html",
  outputDir: "dist",
  clouds: [{ target: "kubernetes" }],
  ...overrides,
});

export const bothClouds = [
  { target: "kubernetes" },
  { target: "cloudrun", mode: "manual", project: "my-proj-1", region: "us-east1", arRepo: "us-east1-docker.pkg.dev/my-proj-1/nbo" },
];

// deployedProject runs a full setup and waits for its first build.
export async function deployedProject(h: Harness, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await h.call("POST", "/projects/setup", staticSetup(overrides));
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${res.text}`);
  const id = res.json.project.id as string;
  await h.v2.setup.settled(id);
  await h.v2.queue.idle(id);
  return id;
}

// noCommands: the route tests never run gcloud, kubectl or docker.
export const noCommands: CommandRunner = async (cmd) => {
  throw new Error(`no commands in this test (${cmd})`);
};

export const bearer = (secret: string): Record<string, string> => ({ authorization: `Bearer ${secret}` });
