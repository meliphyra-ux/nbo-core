// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../../store/store.js";
import { createSetup } from "../setup.js";
import type { CloudSetup } from "../../clouds/cloud-setup.js";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

async function openStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-setup-prod-"));
  const s = createStore(join(dir, "test.db"));
  s.setSecretKey(randomBytes(32));
  stores.push(s);
  return s;
}

function harness(store: Store) {
  const gcloudCalls: string[] = [];
  const cloudSetup: CloudSetup = {
    async preflight() {
      gcloudCalls.push("preflight");
      throw new Error("host gcloud must not be consulted in production");
    },
    async ensureCloudRun() {
      gcloudCalls.push("ensureCloudRun");
      throw new Error("host gcloud must not be consulted in production");
    },
  };
  const queue = { enqueue: (id: string, rev: string) => store.createQueuedBuild(id, rev) };
  const setup = createSetup({ store, cloudSetup, queue, lsRemote: async () => "abc", mode: "production" });
  return { setup, gcloudCalls };
}

const keys = { deployerKey: '{"type":"service_account"}', pullerKey: '{"type":"service_account"}' };

describe("provisionEnvironment for Cloud Run in production", () => {
  it("builds the config from the Google connection with the chosen region and never touches host gcloud", async () => {
    const s = await openStore();
    s.saveGoogleConnection(
      {
        project: "acme",
        region: "europe-west1",
        arRepo: "europe-west1-docker.pkg.dev/acme/nbo",
        deployer: "d@acme.iam.gserviceaccount.com",
        puller: "p@acme.iam.gserviceaccount.com",
      },
      keys,
    );
    const { setup, gcloudCalls } = harness(s);
    const p = s.createProject("shop");
    const env = await setup.addCloud(p.id, { target: "cloudrun", mode: "auto", region: "us-central1" });
    expect(JSON.parse(env.config)).toMatchObject({
      project: "acme",
      region: "us-central1",
      arRepo: "us-central1-docker.pkg.dev/acme/nbo",
    });
    expect(gcloudCalls).toEqual([]);
  });

  it("defaults to the connection's region", async () => {
    const s = await openStore();
    s.saveGoogleConnection(
      {
        project: "acme",
        region: "europe-west1",
        arRepo: "europe-west1-docker.pkg.dev/acme/nbo",
        deployer: "d@x",
        puller: "p@x",
      },
      keys,
    );
    const { setup } = harness(s);
    const p = s.createProject("shop");
    const env = await setup.addCloud(p.id, { target: "cloudrun", mode: "auto" });
    expect(JSON.parse(env.config)).toMatchObject({
      project: "acme",
      region: "europe-west1",
      arRepo: "europe-west1-docker.pkg.dev/acme/nbo",
    });
  });

  it("refuses when Google Cloud is not connected", async () => {
    const s = await openStore();
    const { setup, gcloudCalls } = harness(s);
    const p = s.createProject("shop");
    await expect(setup.addCloud(p.id, { target: "cloudrun", mode: "auto" })).rejects.toThrow(/not connected/);
    expect(gcloudCalls).toEqual([]);
  });

  it("refuses Kubernetes when no cluster is connected, and accepts it once one is", async () => {
    const s = await openStore();
    const { setup } = harness(s);
    const p = s.createProject("shop");
    await expect(setup.addCloud(p.id, { target: "kubernetes" })).rejects.toThrow(
      "Kubernetes is not connected: connect a cluster first with nbo-server connect kubernetes",
    );
    expect(s.listEnvironments(p.id)).toEqual([]);
    s.saveKubernetesConnection(
      { name: "prod", server: "https://k", registry: { kind: "artifact-registry" } },
      { kubeconfig: "x" },
    );
    const env = await setup.addCloud(p.id, { target: "kubernetes" });
    expect(env.target).toBe("kubernetes");
  });

  it("rejects manual Cloud Run in production", async () => {
    const s = await openStore();
    const { setup } = harness(s);
    const p = s.createProject("shop");
    await expect(
      setup.addCloud(p.id, {
        target: "cloudrun",
        mode: "manual",
        project: "other-proj",
        region: "us-central1",
        arRepo: "us-central1-docker.pkg.dev/other-proj/nbo",
      }),
    ).rejects.toThrow(/connected Google Cloud project/);
  });
});
