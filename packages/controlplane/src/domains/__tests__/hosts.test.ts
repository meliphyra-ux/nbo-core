// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { defaultHostFor, moveDefaultHosts, stageHostLabel } from "../hosts.js";
import type { ServerSettings } from "../../store/server-settings.js";
import type { Mode } from "../../mode.js";
import { createStore, type Store } from "../../store/store.js";
import { createSetup } from "../../deploys/setup.js";
import type { CloudSetup } from "../../clouds/cloud-setup.js";

const settings = (patch: Partial<ServerSettings> = {}): ServerSettings => ({
  baseDomain: "",
  acmeEmail: "",
  acmeDirectory: "production",
  edgeClusterId: "kc_1",
  edgeAddress: "",
  edgeVersion: "",
  cloudflareRanges: "",
  ...patch,
});

describe("defaultHostFor", () => {
  it("keeps the local sslip host in dev mode, whatever the settings", () => {
    expect(
      defaultHostFor("shop", settings({ baseDomain: "apps.example.com", edgeAddress: "34.1.2.3" }), "dev"),
    ).toEqual({ host: "shop.127.0.0.1.sslip.io" });
  });

  it("uses the local sslip host when there is no edge", () => {
    expect(defaultHostFor("shop", settings(), "production")).toEqual({ host: "shop.127.0.0.1.sslip.io" });
  });

  it("uses the base domain when one is set", () => {
    expect(
      defaultHostFor("shop", settings({ baseDomain: "apps.example.com", edgeAddress: "34.1.2.3" }), "production"),
    ).toEqual({ host: "shop.apps.example.com" });
  });

  it("dashes an IPv4 edge address into sslip.io", () => {
    expect(defaultHostFor("shop", settings({ edgeAddress: "34.1.2.3" }), "production")).toEqual({
      host: "shop.34-1-2-3.sslip.io",
    });
  });

  it("dashes an IPv6 edge address into sslip.io, brackets or not", () => {
    expect(defaultHostFor("shop", settings({ edgeAddress: "2600:1900::1" }), "production")).toEqual({
      host: "shop.2600-1900--1.sslip.io",
    });
    expect(defaultHostFor("shop", settings({ edgeAddress: "[2600:1900::1]" }), "production")).toEqual({
      host: "shop.2600-1900--1.sslip.io",
    });
  });

  it("asks for a base domain when the edge only has a hostname", () => {
    expect(defaultHostFor("shop", settings({ edgeAddress: "abc.elb.amazonaws.com" }), "production")).toEqual({
      host: "shop.127.0.0.1.sslip.io",
      needsBaseDomain: true,
    });
  });
});

describe("moveDefaultHosts", () => {
  it("treats the project's own Cloud Run domain as taken, and leaves it alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-hosts-"));
    const store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
    try {
      const previous = store.getServerSettings();
      store.updateServerSettings({ baseDomain: "apps.example.com", edgeClusterId: "kc_1", edgeAddress: "34.1.2.3" });
      const p = store.createProject("shop");
      store.updateProject(p.id, { edgeHost: "shop.127.0.0.1.sslip.io" });
      const mapped = store.addDomain(p.id, "shop.apps.example.com", "custom", "cloudrun");

      const out = moveDefaultHosts(store, previous, "production");

      expect(out).toEqual({ moved: [], skipped: [{ projectId: p.id, host: "shop.apps.example.com" }] });
      expect(store.getProject(p.id).edgeHost).toBe("shop.127.0.0.1.sslip.io");
      expect(store.getDomain(mapped.id)).toMatchObject({ kind: "custom", serving: "cloudrun" });
    } finally {
      store.close();
    }
  });
});

describe("createSetup default hosts", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
  });

  async function setupFor(mode: Mode, patch: Partial<ServerSettings>) {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-hosts-"));
    const store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
    stores.push(store);
    if (Object.keys(patch).length > 0) store.updateServerSettings(patch);
    const cloudSetup: CloudSetup = {
      async preflight() {
        throw new Error("not used");
      },
      async ensureCloudRun() {
        throw new Error("not used");
      },
    };
    const queue = { enqueue: (id: string, rev: string) => store.createQueuedBuild(id, rev) };
    const setup = createSetup({ store, cloudSetup, queue, lsRemote: async () => "abc", mode });
    return { store, setup };
  }

  const request = (name: string) => ({
    name,
    repo: "https://github.com/acme/shop.git",
    productionBranch: "main",
    framework: "static" as const,
    spa: false,
    buildCommand: "npm run build",
    clouds: [{ target: "cloudrun" as const, mode: "auto" as const }],
  });

  it("keeps <name>.127.0.0.1.sslip.io and adds no domain row in dev mode", async () => {
    const { store, setup } = await setupFor("dev", {
      baseDomain: "apps.example.com",
      edgeClusterId: "kc_1",
      edgeAddress: "34.1.2.3",
    });
    const p = setup.start(request("shop"));
    await setup.settled(p.id);
    expect(store.getProject(p.id).edgeHost).toBe("shop.127.0.0.1.sslip.io");
    expect(store.listDomains()).toEqual([]);
  });

  it("uses the edge's host in production and records it as the default domain", async () => {
    const { store, setup } = await setupFor("production", { edgeClusterId: "kc_1", edgeAddress: "34.1.2.3" });
    const p = setup.start(request("shop"));
    await setup.settled(p.id);
    expect(store.getProject(p.id).edgeHost).toBe("shop.34-1-2-3.sslip.io");
    expect(store.listDomains(p.id)).toMatchObject([
      { host: "shop.34-1-2-3.sslip.io", kind: "default", status: "dns_pending" },
    ]);
  });

  it("uses the base domain in production when one is set", async () => {
    const { store, setup } = await setupFor("production", {
      baseDomain: "apps.example.com",
      edgeClusterId: "kc_1",
      edgeAddress: "34.1.2.3",
    });
    const p = setup.start(request("shop"));
    await setup.settled(p.id);
    expect(store.getProject(p.id).edgeHost).toBe("shop.apps.example.com");
    expect(store.listDomains(p.id).map((d) => d.host)).toEqual(["shop.apps.example.com"]);
  });

  it("refuses a project whose default host is already someone's domain", async () => {
    const { store, setup } = await setupFor("production", {
      baseDomain: "apps.example.com",
      edgeClusterId: "kc_1",
      edgeAddress: "34.1.2.3",
    });
    const other = store.createProject("other");
    store.addDomain(other.id, "shop.apps.example.com", "custom");
    expect(() => setup.start(request("shop"))).toThrow(/already in use/);
    expect(store.listProjects().map((p) => p.name)).toEqual(["other"]);
  });

  it("adds no domain row while the edge only has a hostname (no base domain yet)", async () => {
    const { store, setup } = await setupFor("production", { edgeClusterId: "kc_1", edgeAddress: "lb.example.com" });
    const p = setup.start(request("shop"));
    await setup.settled(p.id);
    expect(store.getProject(p.id).edgeHost).toBe("shop.127.0.0.1.sslip.io");
    expect(store.listDomains()).toEqual([]);
  });
});

describe("stage hosts", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
  });

  async function open(): Promise<Store> {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-hosts-"));
    const store = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
    stores.push(store);
    return store;
  }

  it("labels a stage <stage>--<project> and gives it a default host like a project's", async () => {
    const store = await open();
    const p = store.createProject("shop");
    const stage = store.createStage(p.id, { name: "staging", branch: "staging", host: "" });
    expect(stageHostLabel(stage, p)).toBe("staging--shop");
    expect(defaultHostFor(stageHostLabel(stage, p), settings(), "dev").host).toBe("staging--shop.127.0.0.1.sslip.io");
    expect(
      defaultHostFor(
        stageHostLabel(stage, p),
        settings({ baseDomain: "apps.example.com", edgeAddress: "34.1.2.3" }),
        "production",
      ).host,
    ).toBe("staging--shop.apps.example.com");
    expect(defaultHostFor(stageHostLabel(stage, p), settings({ edgeAddress: "34.1.2.3" }), "production").host).toBe(
      "staging--shop.34-1-2-3.sslip.io",
    );
  });

  it("moveDefaultHosts moves a stage's placeholder host with its default domain row", async () => {
    const store = await open();
    const previous = store.getServerSettings();
    store.updateServerSettings({ baseDomain: "apps.example.com", edgeClusterId: "kc_1", edgeAddress: "34.1.2.3" });
    const p = store.createProject("shop");
    store.updateProject(p.id, { edgeHost: "shop.127.0.0.1.sslip.io" });
    const stage = store.createStage(p.id, {
      name: "staging",
      branch: "staging",
      host: "staging--shop.127.0.0.1.sslip.io",
    });

    const out = moveDefaultHosts(store, previous, "production");

    expect(out.skipped).toEqual([]);
    expect(out.moved).toEqual([
      { projectId: p.id, from: "shop.127.0.0.1.sslip.io", to: "shop.apps.example.com" },
      {
        projectId: p.id,
        stage: "staging",
        from: "staging--shop.127.0.0.1.sslip.io",
        to: "staging--shop.apps.example.com",
      },
    ]);
    expect(store.getProject(p.id).edgeHost).toBe("shop.apps.example.com");
    expect(store.getStage(stage.id).host).toBe("staging--shop.apps.example.com");
    const prod = store.productionStage(p.id);
    expect(store.listDomains(p.id).map((d) => [d.host, d.kind, d.stageId])).toEqual([
      ["shop.apps.example.com", "default", prod.id],
      ["staging--shop.apps.example.com", "default", stage.id],
    ]);
  });

  it("moving Production's host keeps the stages' default rows (and moving a stage keeps Production's)", async () => {
    const store = await open();
    store.updateServerSettings({ baseDomain: "old.example.com", edgeClusterId: "kc_1", edgeAddress: "34.1.2.3" });
    const previous = store.getServerSettings();
    const p = store.createProject("shop");
    store.updateProject(p.id, { edgeHost: "shop.old.example.com" });
    store.addDomain(p.id, "shop.old.example.com", "default");
    const stage = store.createStage(p.id, {
      name: "staging",
      branch: "staging",
      host: "staging--shop.old.example.com",
    });
    store.addDomain(p.id, "staging--shop.old.example.com", "default", "edge", stage.id);
    store.updateServerSettings({ baseDomain: "new.example.com" });

    const out = moveDefaultHosts(store, previous, "production", { previousDefault: true });

    expect(out.moved.map((m) => m.to)).toEqual(["shop.new.example.com", "staging--shop.new.example.com"]);
    expect(store.listDomains(p.id).map((d) => [d.host, d.kind, d.stageId])).toEqual([
      ["shop.new.example.com", "default", store.productionStage(p.id).id],
      ["staging--shop.new.example.com", "default", stage.id],
    ]);
  });

  it("keeps a stage on its host when its new one is a project's host", async () => {
    const store = await open();
    const previous = store.getServerSettings();
    store.updateServerSettings({ baseDomain: "apps.example.com", edgeClusterId: "kc_1", edgeAddress: "34.1.2.3" });
    const p = store.createProject("shop");
    store.updateProject(p.id, { edgeHost: "shop.apps.example.com" });
    const other = store.createProject("staging--shop");
    store.updateProject(other.id, { edgeHost: "staging--shop.apps.example.com" });
    const stage = store.createStage(p.id, {
      name: "staging",
      branch: "staging",
      host: "staging--shop.127.0.0.1.sslip.io",
    });

    const out = moveDefaultHosts(store, previous, "production");

    expect(out.moved).toEqual([]);
    expect(out.skipped).toEqual([{ projectId: p.id, stage: "staging", host: "staging--shop.apps.example.com" }]);
    expect(store.getStage(stage.id).host).toBe("staging--shop.127.0.0.1.sslip.io");
  });

  it("keeps a project on its host when its new one is a stage's host", async () => {
    const store = await open();
    const previous = store.getServerSettings();
    store.updateServerSettings({ baseDomain: "apps.example.com", edgeClusterId: "kc_1", edgeAddress: "34.1.2.3" });
    const p = store.createProject("shop");
    store.updateProject(p.id, { edgeHost: "shop.apps.example.com" });
    store.createStage(p.id, { name: "staging", branch: "staging", host: "staging--shop.apps.example.com" });
    const other = store.createProject("staging--shop");
    store.updateProject(other.id, { edgeHost: "staging--shop.127.0.0.1.sslip.io" });

    const out = moveDefaultHosts(store, previous, "production");

    expect(out.skipped).toEqual([{ projectId: other.id, host: "staging--shop.apps.example.com" }]);
    expect(store.getProject(other.id).edgeHost).toBe("staging--shop.127.0.0.1.sslip.io");
  });
});
