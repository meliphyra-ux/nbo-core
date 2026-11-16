// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, X509Certificate } from "node:crypto";
import type { CommandRunner } from "@nbo/deploy";
import { createStore, type Store } from "../../store/store.js";
import {
  createAcmeClient,
  createCertWriter,
  createChallengeStore,
  createDomainLoop,
  edgeClusterGoneMessage,
  noEmailMessage,
  ephemeralCertCapReached,
  ephemeralCertCapWarning,
  registeredDomainOf,
  type AcmeClient,
  type AcmeLib,
  type DomainLoopDeps,
} from "../certs.js";
import { MappingNotVerifiedError, type MappingState, type MappingTarget } from "../cloudrun-domains.js";
import type { Resolver } from "../dns-check.js";
import type { EdgeSync } from "../../edge/edge-sync.js";
import { EDGE_VERSION, certSecretName, type RouteTable } from "../../edge/edge-manifests.js";
import {
  brokenWarning,
  flexibleWarning,
  hostUnreachableWarning,
  noRecordWarning,
  notProxiedWarning,
  renewalAlwaysHttpsMessage,
  type FlexibleResult,
  type ReachResult,
} from "../cloudflare-check.js";
import { ErrConflict, ErrInvalid } from "../../store/errors.js";
import { renderDesiredTable } from "../../edge/edge-table.js";
import { createRelayCa } from "../../edge/relay-ca.js";
import { wireV2 } from "../../v2.js";
import { fakeCloudSetup, fakeDeploymentTrigger, fakeGoogleConnect, fakeKubeConnect } from "../../testing.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-certs-"));
  const s = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  cleanups.push(async () => {
    s.close();
    await rm(dir, { recursive: true, force: true });
  });
  return s;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t0 = new Date("2026-11-04T10:00:00.000Z");

async function edgeStore(settings: { acmeEmail?: string } = {}): Promise<Store> {
  const store = await openTestStore();
  const id = store.saveKubernetesConnection(
    {
      name: "edge",
      server: "https://edge.example:6443",
      registry: { kind: "custom", server: "ghcr.io", username: "me" },
    },
    { kubeconfig: "edge-kubeconfig" },
  ).id;
  store.updateServerSettings({
    edgeClusterId: id,
    edgeAddress: "34.1.2.3",
    acmeEmail: settings.acmeEmail ?? "ops@example.com",
  });
  return store;
}

// project creates a project with a live Cloud Run backend at 100% and a
// domain row for host.
function project(store: Store, name: string, host: string) {
  const p = store.createProject(name);
  store.updateProject(p.id, { edgeHost: `${name}.34-1-2-3.sslip.io` });
  const env = store.createEnvironment(
    p.id,
    "cloudrun",
    "cloudrun",
    JSON.stringify({ project: "g", region: "r", arRepo: "a" }),
  );
  const d = store.createDeployment(env.id);
  store.completeDeployment(d.id, "sha256:x", `https://${name}.a.run.app`);
  store.setTrafficWeights(p.id, { [env.id]: 100 });
  return { project: p, domain: store.addDomain(p.id, host, "custom") };
}

const resolverFor = (a: Record<string, string[]>): Resolver => ({
  async resolve4(h) {
    if (h === "boom.example.com") throw new Error("SERVFAIL");
    return a[h] ?? [];
  },
  async resolve6() {
    return [];
  },
  async resolveCname() {
    return [];
  },
});

interface FakeAcme extends AcmeClient {
  hosts: string[];
  failWith: string | null;
  maxInFlight: number;
}

function fakeAcme(notAfter: () => string): FakeAcme {
  let inFlight = 0;
  const acme: FakeAcme = {
    hosts: [],
    failWith: null,
    maxInFlight: 0,
    async issue(host, onChallenge, onCleanup) {
      acme.hosts.push(host);
      inFlight++;
      acme.maxInFlight = Math.max(acme.maxInFlight, inFlight);
      try {
        const token = `tok${acme.hosts.length}`;
        await onChallenge(token, `${token}.thumb`);
        await new Promise((r) => setTimeout(r, 5));
        await onCleanup(token);
        if (acme.failWith) throw new Error(acme.failWith);
        return { certPem: `CERT ${host}`, keyPem: `KEY ${host}`, notAfter: notAfter() };
      } finally {
        inFlight--;
      }
    },
  };
  return acme;
}

function harness(
  store: Store,
  opts: {
    a?: Record<string, string[]>;
    probe?: boolean;
    probeResults?: boolean[];
    acmeDays?: number;
    cloudRun?: DomainLoopDeps["cloudRun"];
  } = {},
) {
  let now = t0;
  const challenges = createChallengeStore();
  const pushes: Record<string, string>[] = [];
  const edgeSync = {
    async push() {
      events.push("push");
      pushes.push(challenges.snapshot());
    },
  } as unknown as EdgeSync;
  const written: { name: string; certPem: string; keyPem: string }[] = [];
  const acme = fakeAcme(() => new Date(now.getTime() + (opts.acmeDays ?? 90) * DAY).toISOString());
  const probes: string[] = [];
  const sleeps: number[] = [];
  const probeResults = [...(opts.probeResults ?? [])];
  const state = {
    writeFails: 0,
    writeError: "secrets is forbidden: User cannot create resource secrets in namespace nbo-edge",
    deleteFails: false,
  };
  const events: string[] = [];
  const deleted: string[] = [];
  const cf = {
    reach: { ok: true } as ReachResult,
    reachCalls: [] as { host: string; token: string; expected: string; published: boolean; probesBefore: number }[],
    flexible: "fine" as FlexibleResult | Error,
    flexibleCalls: [] as string[],
    refresh: false as boolean | Error,
    refreshes: 0,
  };
  const loop = createDomainLoop({
    store,
    resolver: resolverFor(opts.a ?? { "shop.example.com": ["34.1.2.3"] }),
    acme,
    edgeSync,
    challenges,
    cloudRun: opts.cloudRun,
    ranges: {
      isCloudflare: (ip) => ip.startsWith("104.16."),
      async refresh() {
        cf.refreshes++;
        if (cf.refresh instanceof Error) throw cf.refresh;
        return cf.refresh;
      },
    },
    reach: async (host, token, expected) => {
      events.push("reach");
      cf.reachCalls.push({
        host,
        token,
        expected,
        published: challenges.snapshot()[token] === expected,
        probesBefore: probes.length,
      });
      return cf.reach;
    },
    flexible: async (host) => {
      cf.flexibleCalls.push(host);
      if (cf.flexible instanceof Error) throw cf.flexible;
      return cf.flexible;
    },
    writeCert: async (name, certPem, keyPem) => {
      events.push("write");
      if (state.writeFails > 0) {
        state.writeFails--;
        throw new Error(state.writeError);
      }
      written.push({ name, certPem, keyPem });
    },
    deleteCert: async (name) => {
      events.push("delete");
      if (state.deleteFails) throw new Error("kubectl failed");
      deleted.push(name);
    },
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    probe: async (host, token, keyAuth) => {
      probes.push(`${host} ${token} ${keyAuth}`);
      return probeResults.shift() ?? opts.probe ?? true;
    },
  });
  return {
    loop,
    state,
    acme,
    pushes,
    written,
    probes,
    sleeps,
    challenges,
    events,
    deleted,
    cf,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("createDomainLoop", () => {
  it("takes a pending domain to active: challenge published and probed, cert Secret written, tls set", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store);

    await h.loop.tick();

    const d = store.getDomain(domain.id);
    expect(d).toMatchObject({
      status: "active",
      failures: 0,
      lastError: "",
      certNotAfter: new Date(t0.getTime() + 90 * DAY).toISOString(),
    });
    expect(h.written).toEqual([
      { name: certSecretName("shop.example.com"), certPem: "CERT shop.example.com", keyPem: "KEY shop.example.com" },
    ]);
    // The challenge was in the table while Let's Encrypt validated, gone after.
    expect(h.pushes[0]).toEqual({ tok1: "tok1.thumb" });
    expect(h.pushes[h.pushes.length - 1]).toEqual({});
    expect(h.probes).toEqual(["shop.example.com tok1 tok1.thumb", "shop.example.com tok1 tok1.thumb"]);
    expect(h.challenges.snapshot()).toEqual({});
    const table = renderDesiredTable(store, { challenges: {} });
    expect(table.targets["shop.example.com"]).toMatchObject({
      tls: certSecretName("shop.example.com"),
      redirectHttps: true,
    });
  });

  it("keeps a domain in dns_pending while DNS points elsewhere, naming what it found", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store, { a: { "shop.example.com": ["5.6.7.8"] } });
    await h.loop.tick();
    const d = store.getDomain(domain.id);
    expect(d.status).toBe("dns_pending");
    expect(d.lastError).toContain("5.6.7.8");
    expect(d.lastError).toContain("34.1.2.3");
    expect(d.checkedAt).toBe(t0.toISOString());
    expect(h.acme.hosts).toEqual([]);
  });

  it("backs off 1 h, then 6 h, then 24 h after ACME failures", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store);
    h.acme.failWith =
      "urn:ietf:params:acme:error:unauthorized: Invalid response from http://shop.example.com/.well-known/acme-challenge/tok1: 404";

    await h.loop.tick();
    let d = store.getDomain(domain.id);
    expect(d).toMatchObject({
      status: "failed",
      failures: 1,
      lastError: h.acme.failWith,
      nextAttemptAt: new Date(t0.getTime() + HOUR).toISOString(),
    });
    expect(h.challenges.snapshot()).toEqual({});

    h.advance(30 * 60_000);
    await h.loop.tick();
    expect(h.acme.hosts).toHaveLength(1);

    h.advance(30 * 60_000);
    await h.loop.tick();
    d = store.getDomain(domain.id);
    expect(h.acme.hosts).toHaveLength(2);
    expect(d).toMatchObject({
      status: "failed",
      failures: 2,
      nextAttemptAt: new Date(t0.getTime() + HOUR + 6 * HOUR).toISOString(),
    });

    h.advance(6 * HOUR);
    await h.loop.tick();
    d = store.getDomain(domain.id);
    expect(d).toMatchObject({ failures: 3, nextAttemptAt: new Date(t0.getTime() + 7 * HOUR + DAY).toISOString() });

    h.advance(DAY);
    await h.loop.tick();
    expect(store.getDomain(domain.id)).toMatchObject({
      failures: 4,
      nextAttemptAt: new Date(t0.getTime() + 7 * HOUR + 2 * DAY).toISOString(),
    });
  });

  it("never stores a private key in lastError", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store);
    h.acme.failWith = "bad thing\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\nmore";
    await h.loop.tick();
    const d = store.getDomain(domain.id);
    expect(d.lastError).not.toContain("MIIEvQIBADANBg");
    expect(d.lastError).toContain("bad thing");
  });

  it("renews an active certificate with 29 days left, not one with 31", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store);
    store.updateDomain(domain.id, { status: "active", certNotAfter: new Date(t0.getTime() + 31 * DAY).toISOString() });
    await h.loop.tick();
    expect(h.acme.hosts).toEqual([]);

    h.advance(2 * DAY);
    await h.loop.tick();
    expect(h.acme.hosts).toEqual(["shop.example.com"]);
    expect(store.getDomain(domain.id)).toMatchObject({
      status: "active",
      certNotAfter: new Date(t0.getTime() + 92 * DAY).toISOString(),
    });
  });

  it("keeps a renewing domain active when the renewal fails, recording the error", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store);
    store.updateDomain(domain.id, { status: "active", certNotAfter: new Date(t0.getTime() + 10 * DAY).toISOString() });
    h.acme.failWith = "rate limited";
    await h.loop.tick();
    expect(store.getDomain(domain.id)).toMatchObject({
      status: "active",
      lastError: "rate limited",
      failures: 1,
      nextAttemptAt: new Date(t0.getTime() + HOUR).toISOString(),
    });
    await h.loop.tick();
    expect(h.acme.hosts).toHaveLength(1);
  });

  it("waits in cert_pending with a message when no Let's Encrypt email is set", async () => {
    const store = await edgeStore({ acmeEmail: "" });
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store);
    await h.loop.tick();
    expect(store.getDomain(domain.id)).toMatchObject({
      status: "cert_pending",
      lastError: "Set the Let's Encrypt email first (nbo-server domains settings --acme-email <address>)",
    });
    expect(h.acme.hosts).toEqual([]);
  });

  it("fails the issuance when the edge never serves the challenge", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store, { probe: false });
    await h.loop.tick();
    const d = store.getDomain(domain.id);
    expect(d.status).toBe("failed");
    expect(d.lastError).toMatch(/did not serve/);
    expect(h.probes.length).toBe(16);
    expect(h.written).toEqual([]);
    expect(h.challenges.snapshot()).toEqual({});
  });

  it("waits one edge poll after the first good probe and probes again before Let's Encrypt validates", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store);
    await h.loop.tick();
    expect(store.getDomain(domain.id).status).toBe("active");
    expect(h.probes).toHaveLength(2);
    expect(h.sleeps).toHaveLength(1);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(6_000);
  });

  it("keeps probing when the second replica doesn't serve the challenge yet", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store, { probeResults: [true, false, true] });
    await h.loop.tick();
    expect(store.getDomain(domain.id).status).toBe("active");
    expect(h.probes).toHaveLength(3);
  });

  it("fails the issuance when only the first probe ever succeeds", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store, { probe: false, probeResults: [true] });
    await h.loop.tick();
    expect(store.getDomain(domain.id)).toMatchObject({ status: "failed" });
    expect(store.getDomain(domain.id).lastError).toMatch(/did not serve/);
    expect(h.written).toEqual([]);
  });

  it("checkNow skips the backoff and runs that one domain", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store);
    h.acme.failWith = "nope";
    await h.loop.tick();
    h.acme.failWith = null;
    const d = await h.loop.checkNow(domain.id);
    expect(d.status).toBe("active");
    expect(h.acme.hosts).toHaveLength(2);
  });

  it("keeps an issued certificate when writing its Secret fails and writes it next time without a new order", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store);
    h.state.writeFails = 1;

    await h.loop.tick();
    let d = store.getDomain(domain.id);
    expect(d).toMatchObject({ status: "failed", failures: 1 });
    expect(d.lastError).toContain("forbidden");
    expect(h.acme.hosts).toHaveLength(1);
    expect(h.written).toEqual([]);

    h.advance(HOUR);
    await h.loop.tick();
    d = store.getDomain(domain.id);
    expect(h.acme.hosts).toHaveLength(1);
    expect(h.written).toEqual([
      { name: certSecretName("shop.example.com"), certPem: "CERT shop.example.com", keyPem: "KEY shop.example.com" },
    ]);
    expect(d).toMatchObject({
      status: "active",
      failures: 0,
      lastError: "",
      certNotAfter: new Date(t0.getTime() + 90 * DAY).toISOString(),
    });
    expect(store.getPendingCert(domain.id)).toBeUndefined();
  });

  it("orders anew when the kept certificate has 30 days or less left", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store);
    store.setPendingCert(domain.id, {
      certPem: "OLD",
      keyPem: "OLDKEY",
      notAfter: new Date(t0.getTime() + 20 * DAY).toISOString(),
    });
    await h.loop.tick();
    expect(h.acme.hosts).toHaveLength(1);
    expect(h.written[0]!.certPem).toBe("CERT shop.example.com");
  });

  it("keeps the pending certificate sealed", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    store.setPendingCert(domain.id, { certPem: "C", keyPem: "SECRET-KEY-PEM", notAfter: t0.toISOString() });
    expect(store.hasSealedSecrets()).toBe(true);
    expect(store.getPendingCert(domain.id)).toEqual({
      certPem: "C",
      keyPem: "SECRET-KEY-PEM",
      notAfter: t0.toISOString(),
    });
    store.deleteDomain(domain.id);
    expect(store.getPendingCert(domain.id)).toBeUndefined();
  });

  it("deleting the project removes its domains' pending certificates", async () => {
    const store = await edgeStore();
    const { project: p, domain } = project(store, "shop", "shop.example.com");
    store.setPendingCert(domain.id, { certPem: "C", keyPem: "SECRET-KEY-PEM", notAfter: t0.toISOString() });
    store.deleteProject(p.id);
    expect(store.getPendingCert(domain.id)).toBeUndefined();
  });

  it("checkNow bypasses the backoff at most once per 60 s per domain", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", "shop.example.com");
    const h = harness(store);
    h.acme.failWith = "nope";
    await h.loop.tick();
    await h.loop.checkNow(domain.id);
    expect(h.acme.hosts).toHaveLength(2);
    const before = store.getDomain(domain.id);
    h.advance(59_000);
    expect(await h.loop.checkNow(domain.id)).toEqual(before);
    expect(h.acme.hosts).toHaveLength(2);
    h.advance(1_000);
    await h.loop.checkNow(domain.id);
    expect(h.acme.hosts).toHaveLength(3);
  });

  it("keeps going when one domain fails and issues one certificate at a time", async () => {
    const store = await edgeStore();
    project(store, "boom", "boom.example.com");
    const a = project(store, "shop", "shop.example.com");
    const b = project(store, "blog", "blog.example.com");
    const h = harness(store, { a: { "shop.example.com": ["34.1.2.3"], "blog.example.com": ["34.1.2.3"] } });
    await Promise.all([h.loop.tick(), h.loop.checkNow(b.domain.id)]);
    expect(store.getDomain(a.domain.id).status).toBe("active");
    expect(store.getDomain(b.domain.id).status).toBe("active");
    expect(h.acme.maxInFlight).toBe(1);
  });

  it("does nothing while no edge is installed", async () => {
    const store = await openTestStore();
    const p = store.createProject("shop");
    const dom = store.addDomain(p.id, "shop.example.com", "custom");
    const h = harness(store);
    await h.loop.tick();
    expect(store.getDomain(dom.id).status).toBe("dns_pending");
    expect(store.getDomain(dom.id).checkedAt).toBe("");
  });
});

const MIN5 = 5 * 60_000;

function fakeCloudRun() {
  const target: MappingTarget = { project: "g", region: "r", service: "svc" };
  const f = {
    target: target as MappingTarget | null,
    createError: null as Error | null,
    removeError: null as Error | null,
    describeError: null as Error | null,
    // gate holds create and describe until released.
    gate: null as Promise<void> | null,
    state: {
      records: [{ type: "CNAME", name: "www", value: "ghs.googlehosted.com." }],
      ready: false,
      message: "",
    } as MappingState | null,
    calls: [] as string[],
    api: {
      targetFor: () => f.target,
      async describe(_t: MappingTarget, host: string) {
        f.calls.push(`describe ${host}`);
        if (f.gate) await f.gate;
        if (f.describeError) throw f.describeError;
        return f.state;
      },
      async create(_t: MappingTarget, host: string) {
        f.calls.push(`create ${host}`);
        if (f.gate) await f.gate;
        if (f.createError) throw f.createError;
      },
      async remove(_t: MappingTarget, host: string) {
        f.calls.push(`remove ${host}`);
        if (f.removeError) throw f.removeError;
      },
    },
  };
  return f;
}

// mapped: a project with a Cloud Run backend and a domain Google serves.
function mapped(store: Store, host = "shop.example.com") {
  const p = store.createProject("shop");
  store.updateProject(p.id, { edgeHost: "shop.34-1-2-3.sslip.io" });
  return store.addDomain(p.id, host, "custom", "cloudrun");
}

describe("createDomainLoop with Cloud Run domain mappings", () => {
  it("moves verify_pending to cert_pending with no edge installed, storing Google's records", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    const cr = fakeCloudRun();
    const h = harness(store, { cloudRun: cr.api });
    await h.loop.tick();
    expect(cr.calls).toEqual(["create shop.example.com", "describe shop.example.com"]);
    expect(store.getDomain(dom.id)).toMatchObject({
      status: "cert_pending",
      mappingRecords: cr.state!.records,
      lastError: "",
      failures: 0,
    });
  });

  it("keeps verify_pending when the domain is not verified, retrying in 5 minutes with no error", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    store.updateDomain(dom.id, { lastError: "old" });
    const cr = fakeCloudRun();
    cr.createError = new MappingNotVerifiedError("not verified");
    const h = harness(store, { cloudRun: cr.api });
    await h.loop.tick();
    expect(store.getDomain(dom.id)).toMatchObject({
      status: "verify_pending",
      lastError: "",
      nextAttemptAt: new Date(t0.getTime() + MIN5).toISOString(),
    });
    await h.loop.tick();
    expect(cr.calls).toHaveLength(1);
    h.advance(MIN5);
    await h.loop.tick();
    expect(cr.calls).toHaveLength(2);
  });

  it("fails on another error, with a cleaned message and the usual backoff", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    const cr = fakeCloudRun();
    cr.createError = new Error("boom -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    const h = harness(store, { cloudRun: cr.api });
    await h.loop.tick();
    const d = store.getDomain(dom.id);
    expect(d).toMatchObject({
      status: "failed",
      failures: 1,
      nextAttemptAt: new Date(t0.getTime() + HOUR).toISOString(),
    });
    expect(d.lastError).toContain("boom");
    expect(d.lastError).not.toContain("abc");
    // not due yet, then due: a retry that works goes on to cert_pending
    await h.loop.tick();
    expect(cr.calls).toHaveLength(1);
    cr.createError = null;
    h.advance(HOUR);
    await h.loop.tick();
    expect(store.getDomain(dom.id)).toMatchObject({ status: "cert_pending", failures: 0, lastError: "" });
  });

  it("makes cert_pending active when Google says ready, a day's check ahead", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    store.updateDomain(dom.id, { status: "cert_pending", lastError: "waiting" });
    const cr = fakeCloudRun();
    cr.state = { records: [{ type: "A", name: "@", value: "1.2.3.4" }], ready: true, message: "" };
    const h = harness(store, { cloudRun: cr.api });
    await h.loop.tick();
    expect(store.getDomain(dom.id)).toMatchObject({
      status: "active",
      lastError: "",
      warning: "",
      nextAttemptAt: new Date(t0.getTime() + DAY).toISOString(),
      mappingRecords: cr.state.records,
    });
  });

  it("keeps cert_pending when not ready, showing Google's message and checking again in 5 minutes", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    store.updateDomain(dom.id, { status: "cert_pending" });
    const cr = fakeCloudRun();
    cr.state = { records: [], ready: false, message: "Certificate pending" };
    const h = harness(store, { cloudRun: cr.api });
    await h.loop.tick();
    expect(store.getDomain(dom.id)).toMatchObject({
      status: "cert_pending",
      lastError: "Certificate pending",
      nextAttemptAt: new Date(t0.getTime() + MIN5).toISOString(),
    });
  });

  it("goes back to verify_pending when the mapping is gone from a cert_pending row", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    store.updateDomain(dom.id, { status: "cert_pending" });
    const cr = fakeCloudRun();
    cr.state = null;
    const h = harness(store, { cloudRun: cr.api });
    await h.loop.tick();
    expect(store.getDomain(dom.id).status).toBe("verify_pending");
  });

  it("goes back to verify_pending and says so when Google no longer has an active row's mapping", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    store.updateDomain(dom.id, { status: "active", mappingRecords: [{ type: "A", name: "@", value: "1.2.3.4" }] });
    const cr = fakeCloudRun();
    cr.state = null;
    const h = harness(store, { cloudRun: cr.api });
    await h.loop.tick();
    const d = store.getDomain(dom.id);
    expect(d).toMatchObject({ status: "verify_pending", mappingRecords: [] });
    expect(d.lastError).toMatch(/no longer has this mapping.*recreating/);
  });

  it("clears lastError on an active row when describe succeeds", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    store.updateDomain(dom.id, { status: "active", lastError: "gcloud hiccup" });
    const cr = fakeCloudRun();
    cr.state = { records: [], ready: true, message: "" };
    const h = harness(store, { cloudRun: cr.api });
    await h.loop.tick();
    expect(store.getDomain(dom.id).lastError).toBe("");
  });

  it("checks an active row once a day: not ready warns, ready clears", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    store.updateDomain(dom.id, { status: "active" });
    const cr = fakeCloudRun();
    cr.state = { records: [], ready: false, message: "Certificate expired" };
    const h = harness(store, { cloudRun: cr.api });
    await h.loop.tick();
    expect(store.getDomain(dom.id)).toMatchObject({
      status: "active",
      warning: "Certificate expired",
      nextAttemptAt: new Date(t0.getTime() + DAY).toISOString(),
    });
    await h.loop.tick();
    expect(cr.calls).toHaveLength(1);
    cr.state = { records: [], ready: true, message: "" };
    h.advance(DAY);
    await h.loop.tick();
    expect(store.getDomain(dom.id)).toMatchObject({ status: "active", warning: "" });
    expect(cr.calls).toHaveLength(2);
  });

  it("says so when the project has no Cloud Run target, leaving the status", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    const cr = fakeCloudRun();
    cr.target = null;
    const h = harness(store, { cloudRun: cr.api });
    await h.loop.tick();
    const d = store.getDomain(dom.id);
    expect(d.status).toBe("verify_pending");
    expect(d.lastError).not.toBe("");
    expect(d.nextAttemptAt).toBe(new Date(t0.getTime() + MIN5).toISOString());
    expect(cr.calls).toEqual([]);
  });

  it("checkNow works with no edge, at most once a minute; edge rows still do nothing", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    const edgeRow = store.addDomain(store.createProject("blog").id, "blog.example.com", "custom");
    const cr = fakeCloudRun();
    cr.createError = new MappingNotVerifiedError("not verified");
    const h = harness(store, { cloudRun: cr.api });
    await h.loop.tick();
    expect(cr.calls).toHaveLength(1);
    cr.createError = null;
    expect((await h.loop.checkNow(dom.id)).status).toBe("cert_pending");
    expect(cr.calls).toHaveLength(3);
    store.updateDomain(dom.id, { status: "verify_pending" });
    await h.loop.checkNow(dom.id);
    expect(cr.calls).toHaveLength(3);
    h.advance(60_000);
    await h.loop.checkNow(dom.id);
    expect(cr.calls).toHaveLength(5);
    expect(await h.loop.checkNow(edgeRow.id)).toMatchObject({ status: "dns_pending", checkedAt: "" });
  });

  it("tick leaves edge rows alone with no edge", async () => {
    const store = await openTestStore();
    mapped(store);
    const edgeRow = store.addDomain(store.createProject("blog").id, "blog.example.com", "custom");
    const h = harness(store, { cloudRun: fakeCloudRun().api });
    await h.loop.tick();
    expect(store.getDomain(edgeRow.id)).toMatchObject({ status: "dns_pending", checkedAt: "" });
  });

  it("never gives a mapped row to DNS, ACME, the edge or the Cloudflare checks, even with an edge installed", async () => {
    const store = await edgeStore();
    const dom = mapped(store);
    const cr = fakeCloudRun();
    cr.state = { records: [], ready: true, message: "" };
    const h = harness(store, { cloudRun: cr.api });
    await h.loop.tick();
    await h.loop.tick();
    h.advance(DAY);
    await h.loop.tick();
    await h.loop.checkNow(dom.id);
    expect(store.getDomain(dom.id).status).toBe("active");
    expect(h.acme.hosts).toEqual([]);
    expect(h.pushes).toEqual([]);
    expect(h.probes).toEqual([]);
    expect(h.cf.flexibleCalls).toEqual([]);
    expect(h.cf.reachCalls).toEqual([]);
  });

  describe("a domain moved to the edge keeps its mapping until the edge row is active", () => {
    // moved: a row whose 24 hours have passed, unless it's waiting on them.
    async function moved(store: Store, mappingRemoveAfter = "2026-11-01T00:00:00.000Z") {
      const { domain } = project(store, "shop", "shop.example.com");
      store.updateDomain(domain.id, { mappingKept: true, mappingRemoveAfter });
      return domain;
    }

    it("keeps the mapping 24 hours after active, then removes it and clears the flag", async () => {
      const store = await edgeStore();
      const dom = await moved(store, "");
      const cr = fakeCloudRun();
      const h = harness(store, { cloudRun: cr.api });
      await h.loop.tick();
      const after = new Date(t0.getTime() + DAY).toISOString();
      expect(store.getDomain(dom.id)).toMatchObject({ status: "active", mappingKept: true, mappingRemoveAfter: after });
      expect(cr.calls).toEqual([]);

      h.advance(DAY - 1);
      await h.loop.tick();
      expect(store.getDomain(dom.id)).toMatchObject({ mappingKept: true, mappingRemoveAfter: after });
      expect(cr.calls).toEqual([]);

      h.advance(1);
      await h.loop.tick();
      expect(store.getDomain(dom.id)).toMatchObject({ status: "active", mappingKept: false, mappingRemoveAfter: "" });
      expect(cr.calls).toEqual(["remove shop.example.com"]);
    });

    it("Check now doesn't shorten the 24 hours", async () => {
      const store = await edgeStore();
      const dom = await moved(store, "");
      const cr = fakeCloudRun();
      const h = harness(store, { cloudRun: cr.api });
      await h.loop.tick();
      h.advance(HOUR);
      await h.loop.checkNow(dom.id);
      expect(store.getDomain(dom.id).mappingKept).toBe(true);
      expect(cr.calls).toEqual([]);
    });

    it("sets no time while the edge row isn't active", async () => {
      const store = await edgeStore();
      const dom = await moved(store, "");
      const h = harness(store, { cloudRun: fakeCloudRun().api, a: {} });
      await h.loop.tick();
      expect(store.getDomain(dom.id)).toMatchObject({
        status: "dns_pending",
        mappingKept: true,
        mappingRemoveAfter: "",
      });
    });

    it("removes the mapping and clears the flag once its time has passed", async () => {
      const store = await edgeStore();
      const dom = await moved(store);
      const cr = fakeCloudRun();
      const h = harness(store, { cloudRun: cr.api });
      await h.loop.tick();
      expect(store.getDomain(dom.id)).toMatchObject({ status: "active", mappingKept: false, mappingRemoveAfter: "" });
      expect(cr.calls).toEqual(["remove shop.example.com"]);
    });

    it("does not remove it while the edge row is not active", async () => {
      const store = await edgeStore();
      const dom = await moved(store);
      const cr = fakeCloudRun();
      const h = harness(store, { cloudRun: cr.api, a: {} });
      await h.loop.tick();
      expect(store.getDomain(dom.id)).toMatchObject({ status: "dns_pending", mappingKept: true });
      expect(cr.calls).toEqual([]);
    });

    it("keeps the flag, warns and retries on the next tick when removal fails", async () => {
      const store = await edgeStore();
      const dom = await moved(store);
      const cr = fakeCloudRun();
      cr.removeError = new Error("permission denied");
      const h = harness(store, { cloudRun: cr.api });
      await h.loop.tick();
      const d = store.getDomain(dom.id);
      expect(d).toMatchObject({ status: "active", mappingKept: true });
      expect(d.mappingRemoveAfter).not.toBe("");
      expect(d.warning).toContain("permission denied");
      // backed off: not again on the next tick, but after 5 minutes
      cr.removeError = null;
      await h.loop.tick();
      expect(cr.calls).toEqual(["remove shop.example.com"]);
      h.advance(MIN5);
      await h.loop.tick();
      expect(store.getDomain(dom.id)).toMatchObject({ mappingKept: false, warning: "" });
      expect(cr.calls).toEqual(["remove shop.example.com", "remove shop.example.com"]);
    });

    it("keeps the flag and says why when the project has no Cloud Run environment", async () => {
      const store = await edgeStore();
      const dom = await moved(store);
      store.updateDomain(dom.id, { mappingRecords: [{ type: "A", name: "@", value: "1.2.3.4" }] });
      const cr = fakeCloudRun();
      cr.target = null;
      const h = harness(store, { cloudRun: cr.api });
      await h.loop.tick();
      const d = store.getDomain(dom.id);
      expect(d.mappingKept).toBe(true);
      expect(d.mappingRecords).toHaveLength(1);
      expect(d.warning).toContain(
        "NBO can't remove the old Cloud Run mapping for shop.example.com: this project has no Cloud Run environment",
      );
      expect(cr.calls).toEqual([]);
    });

    it("adds its warning to other warnings, keeps them across checks, and removes only its own text", async () => {
      const store = await edgeStore();
      const dom = await moved(store);
      store.updateDomain(dom.id, { behindCloudflare: true });
      const cr = fakeCloudRun();
      cr.removeError = new Error("permission denied");
      const h = harness(store, { cloudRun: cr.api });
      h.cf.flexible = "flexible";
      await h.loop.tick();
      expect(store.getDomain(dom.id).warning).toContain(flexibleWarning);
      expect(store.getDomain(dom.id).warning).toContain("permission denied");
      h.advance(MIN5);
      await h.loop.tick();
      expect(store.getDomain(dom.id).warning).toContain(flexibleWarning);
      expect(store.getDomain(dom.id).warning).toContain("permission denied");
      cr.removeError = null;
      h.advance(MIN5);
      await h.loop.tick();
      expect(store.getDomain(dom.id)).toMatchObject({ mappingKept: false, warning: flexibleWarning });
    });
  });
});

describe("createDomainLoop behind Cloudflare", () => {
  const host = "shop.example.com";
  const secret = certSecretName(host);
  const proxied = { [host]: ["104.16.1.1"] };
  const fx = (n: string): string =>
    readFileSync(fileURLToPath(new URL(`../../__tests__/fixtures/${n}`, import.meta.url)), "utf8");
  const blockedMessage = "Cloudflare is blocking shop.example.com";
  const blocked: ReachResult = { ok: false, code: "blocked", message: blockedMessage };

  async function cloudflareDomain(patch: Parameters<Store["updateDomain"]>[1] = {}) {
    const store = await edgeStore();
    store.updateServerSettings({ edgeVersion: EDGE_VERSION });
    const { domain } = project(store, "shop", host);
    store.updateDomain(domain.id, { behindCloudflare: true, ...patch });
    return { store, id: domain.id };
  }

  async function pastedDomain(daysLeft: number) {
    const notAfter = new Date(t0.getTime() + daysLeft * DAY).toISOString();
    const { store, id } = await cloudflareDomain({ status: "active", certSource: "pasted", certNotAfter: notAfter });
    store.setPastedCert(id, { certPem: "PASTED CERT", keyPem: "PASTED KEY", notAfter });
    return { store, id };
  }

  describe("reach check", () => {
    it("keeps waiting when DNS has no answer, publishing no token", async () => {
      const { store, id } = await cloudflareDomain();
      const h = harness(store, { a: {} });
      await h.loop.tick();
      const d = store.getDomain(id);
      expect(d.status).toBe("dns_pending");
      expect(d.lastError).toContain("does not point at the edge");
      expect(d.lastError).toContain("nothing");
      expect(h.pushes).toEqual([]);
      expect(h.cf.reachCalls).toEqual([]);
    });

    it("moves on when the token comes back: the token is gone again, then Let's Encrypt runs", async () => {
      const { store, id } = await cloudflareDomain();
      const h = harness(store, { a: proxied });
      await h.loop.tick();
      expect(h.cf.reachCalls).toHaveLength(1);
      const { token } = h.cf.reachCalls[0]!;
      expect(token).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      expect(h.challenges.snapshot()).toEqual({});
      const removedAt = h.pushes.findIndex((p, i) => i > 0 && token in h.pushes[i - 1]! && !(token in p));
      const acmeAt = h.pushes.findIndex((p) => "tok1" in p);
      expect(removedAt).toBeGreaterThan(-1);
      expect(removedAt).toBeLessThan(acmeAt);
      expect(h.acme.hosts).toEqual([host]);
      expect(store.getDomain(id)).toMatchObject({ status: "active", lastError: "" });
    });

    it("has the token published and served by the edge, on both replicas, before reaching through Cloudflare", async () => {
      const { store } = await cloudflareDomain();
      const h = harness(store, { a: proxied, probeResults: [false, true, true] });
      h.cf.reach = blocked;
      await h.loop.tick();
      const call = h.cf.reachCalls[0]!;
      expect(call.published).toBe(true);
      expect(call.probesBefore).toBe(3);
      expect(h.sleeps).toContain(6_000);
      expect(h.probes[0]).toBe(`${host} ${call.token} ${call.expected}`);
    });

    it("on failure stays in dns_pending with the check's message, retries after 5 minutes, and doesn't count against Let's Encrypt", async () => {
      const { store, id } = await cloudflareDomain();
      const h = harness(store, { a: proxied });
      h.cf.reach = blocked;
      await h.loop.tick();
      const d = store.getDomain(id);
      expect(d).toMatchObject({
        status: "dns_pending",
        lastError: blockedMessage,
        failures: 0,
        nextAttemptAt: new Date(t0.getTime() + 5 * 60_000).toISOString(),
      });
      expect(h.acme.hosts).toEqual([]);
      expect(h.challenges.snapshot()).toEqual({});

      const pushes = h.pushes.length;
      h.advance(4 * 60_000);
      await h.loop.tick();
      expect(h.cf.reachCalls).toHaveLength(1);
      expect(h.pushes).toHaveLength(pushes);
      expect(store.getDomain(id)).toEqual(d);

      await h.loop.checkNow(id);
      expect(h.cf.reachCalls).toHaveLength(2);

      h.cf.reach = { ok: true };
      h.advance(5 * 60_000);
      await h.loop.tick();
      expect(store.getDomain(id)).toMatchObject({ status: "active", failures: 0, nextAttemptAt: "" });
    });

    it("treats an edge that never serves the token as a failed check, not a Let's Encrypt failure", async () => {
      const { store, id } = await cloudflareDomain();
      const h = harness(store, { a: proxied, probe: false });
      await h.loop.tick();
      const d = store.getDomain(id);
      expect(d).toMatchObject({
        status: "dns_pending",
        failures: 0,
        nextAttemptAt: new Date(t0.getTime() + 5 * 60_000).toISOString(),
      });
      expect(d.lastError).toMatch(/did not serve/);
      expect(h.cf.reachCalls).toEqual([]);
      expect(h.challenges.snapshot()).toEqual({});
    });

    it("checks the path before retrying a failed domain, keeping its failures", async () => {
      const { store, id } = await cloudflareDomain({
        status: "failed",
        failures: 2,
        nextAttemptAt: new Date(t0.getTime() - 1).toISOString(),
      });
      const h = harness(store, { a: proxied });
      h.cf.reach = blocked;
      await h.loop.tick();
      expect(store.getDomain(id)).toMatchObject({ status: "dns_pending", failures: 2 });
      expect(h.acme.hosts).toEqual([]);
    });

    it("checks the path before ordering for a domain already waiting in cert_pending", async () => {
      const { store, id } = await cloudflareDomain({ status: "cert_pending" });
      const h = harness(store, { a: proxied });
      h.cf.reach = blocked;
      await h.loop.tick();
      expect(store.getDomain(id)).toMatchObject({ status: "dns_pending", failures: 0 });
      expect(h.acme.hosts).toEqual([]);
    });

    it("doesn't publish tokens every tick while the Let's Encrypt email is missing", async () => {
      const { store, id } = await cloudflareDomain({ status: "cert_pending" });
      store.updateServerSettings({ acmeEmail: "" });
      const h = harness(store, { a: proxied });
      await h.loop.tick();
      expect(h.cf.reachCalls).toEqual([]);
      expect(store.getDomain(id).lastError).toContain("Let's Encrypt email");
    });
  });

  it("with the switch off, says a Cloudflare answer looks proxied and to turn the switch on", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", host);
    const h = harness(store, { a: proxied });
    await h.loop.tick();
    const d = store.getDomain(domain.id);
    expect(d.status).toBe("dns_pending");
    expect(d.lastError).toContain("104.16.1.1");
    expect(d.lastError).toContain("looks proxied");
    expect(d.lastError).toContain("Behind Cloudflare");
    expect(h.cf.reachCalls).toEqual([]);
  });

  it("with the switch off, says nothing about Cloudflare for other addresses", async () => {
    const store = await edgeStore();
    const { domain } = project(store, "shop", host);
    const h = harness(store, { a: { [host]: ["5.6.7.8"] } });
    await h.loop.tick();
    expect(store.getDomain(domain.id).lastError).not.toContain("Cloudflare");
  });

  describe("renewal", () => {
    it("stays Active without ordering when the reach check fails", async () => {
      const { store, id } = await cloudflareDomain({
        status: "active",
        certNotAfter: new Date(t0.getTime() + 10 * DAY).toISOString(),
      });
      const h = harness(store, { a: proxied });
      h.cf.reach = blocked;
      await h.loop.tick();
      expect(store.getDomain(id)).toMatchObject({
        status: "active",
        lastError: blockedMessage,
        failures: 0,
        nextAttemptAt: new Date(t0.getTime() + 5 * 60_000).toISOString(),
      });
      expect(h.acme.hosts).toEqual([]);
    });

    it("renews when the reach check passes", async () => {
      const { store, id } = await cloudflareDomain({
        status: "active",
        certNotAfter: new Date(t0.getTime() + 10 * DAY).toISOString(),
      });
      const h = harness(store, { a: proxied });
      await h.loop.tick();
      expect(h.cf.reachCalls).toHaveLength(1);
      expect(h.acme.hosts).toEqual([host]);
      expect(store.getDomain(id)).toMatchObject({
        status: "active",
        certNotAfter: new Date(t0.getTime() + 90 * DAY).toISOString(),
      });
    });

    it("runs no reach check on a certificate with time left", async () => {
      const { store } = await cloudflareDomain({
        status: "active",
        certNotAfter: new Date(t0.getTime() + 60 * DAY).toISOString(),
      });
      const h = harness(store, { a: proxied });
      await h.loop.tick();
      expect(h.cf.reachCalls).toEqual([]);
    });
  });

  describe("pasted certificates in the daily pass", () => {
    it.each([10, -3])("never orders, and warns with the expiry date (%i days left)", async (days) => {
      const { store, id } = await pastedDomain(days);
      const h = harness(store, { a: proxied });
      await h.loop.tick();
      await h.loop.checkNow(id);
      const d = store.getDomain(id);
      expect(h.acme.hosts).toEqual([]);
      expect(h.cf.reachCalls).toEqual([]);
      expect(d.status).toBe("active");
      expect(d.warning).toContain(d.certNotAfter.slice(0, 10));
    });

    it("has no warning with more than 30 days left", async () => {
      const { store, id } = await pastedDomain(31);
      const h = harness(store, { a: proxied });
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe("");
      h.advance(2 * DAY);
      await h.loop.tick();
      expect(store.getDomain(id).warning).not.toBe("");
    });

    it("writes the Secret again from the sealed copy once per 24 h, not every tick", async () => {
      const { store } = await pastedDomain(90);
      const h = harness(store, { a: proxied });
      await h.loop.tick();
      expect(h.written).toEqual([{ name: secret, certPem: "PASTED CERT", keyPem: "PASTED KEY" }]);
      h.advance(60_000);
      await h.loop.tick();
      h.advance(DAY - 120_000);
      await h.loop.tick();
      expect(h.written).toHaveLength(1);
      h.advance(60_000);
      await h.loop.tick();
      expect(h.written).toHaveLength(2);
    });

    it("tries a failed rewrite again after 1 hour, not on the next tick, keeping the domain Active", async () => {
      const { store, id } = await pastedDomain(90);
      const h = harness(store, { a: proxied });
      const attempts = (): number => h.events.filter((e) => e === "write").length;
      h.state.writeFails = 1;
      await h.loop.tick();
      const d = store.getDomain(id);
      expect(d.status).toBe("active");
      expect(d.lastError).toContain("forbidden");
      expect(attempts()).toBe(1);

      h.advance(60_000);
      await h.loop.tick();
      h.advance(HOUR - 61_000);
      await h.loop.tick();
      expect(attempts()).toBe(1);

      h.advance(1_000);
      await h.loop.tick();
      expect(attempts()).toBe(2);
      expect(h.written).toHaveLength(1);
      expect(store.getDomain(id).lastError).toBe("");

      // A successful write goes back to daily.
      h.advance(HOUR);
      await h.loop.tick();
      expect(attempts()).toBe(2);
      h.advance(DAY - HOUR);
      await h.loop.tick();
      expect(attempts()).toBe(3);
    });

    it("keeps both the Flexible and the expiry warning", async () => {
      const { store, id } = await pastedDomain(10);
      const h = harness(store, { a: proxied });
      h.cf.flexible = "flexible";
      await h.loop.tick();
      h.advance(60_000);
      await h.loop.tick();
      const d = store.getDomain(id);
      expect(d.warning).toContain(flexibleWarning);
      expect(d.warning).toContain(d.certNotAfter.slice(0, 10));
      h.cf.flexible = "fine";
      h.advance(DAY);
      await h.loop.tick();
      expect(store.getDomain(id).warning).not.toContain(flexibleWarning);
      expect(store.getDomain(id).warning).toContain(d.certNotAfter.slice(0, 10));
    });
  });

  describe("Flexible check", () => {
    const longCert = { status: "active" as const, certNotAfter: new Date(t0.getTime() + 60 * DAY).toISOString() };

    it("warns on an active domain and leaves it Active; unknown leaves it; fine clears it", async () => {
      const { store, id } = await cloudflareDomain(longCert);
      const h = harness(store, { a: proxied });
      h.cf.flexible = "flexible";
      await h.loop.tick();
      expect(store.getDomain(id)).toMatchObject({ status: "active", warning: flexibleWarning });

      h.cf.flexible = "unknown";
      h.advance(DAY);
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe(flexibleWarning);

      h.cf.flexible = "fine";
      h.advance(DAY);
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe("");
      expect(h.cf.flexibleCalls).toHaveLength(3);
    });

    it("runs at most once per 24 h from ticks, and at once from checkNow", async () => {
      const { store, id } = await cloudflareDomain(longCert);
      const h = harness(store, { a: proxied });
      await h.loop.tick();
      h.advance(60_000);
      await h.loop.tick();
      expect(h.cf.flexibleCalls).toHaveLength(1);
      await h.loop.checkNow(id);
      expect(h.cf.flexibleCalls).toHaveLength(2);
      h.advance(DAY - 1);
      await h.loop.tick();
      expect(h.cf.flexibleCalls).toHaveLength(2);
      h.advance(1);
      await h.loop.tick();
      expect(h.cf.flexibleCalls).toHaveLength(3);
    });

    it("runs on activation, one edge poll after the table is pushed", async () => {
      const { store, id } = await cloudflareDomain();
      const h = harness(store, { a: proxied });
      h.cf.flexible = "flexible";
      await h.loop.tick();
      expect(store.getDomain(id)).toMatchObject({ status: "active", warning: flexibleWarning });
      expect(h.cf.flexibleCalls).toEqual([host]);
      expect(h.sleeps[h.sleeps.length - 1]).toBe(6_000);
    });

    it("doesn't run while the domain isn't Active", async () => {
      const { store } = await cloudflareDomain();
      const h = harness(store, { a: proxied });
      h.cf.reach = blocked;
      await h.loop.tick();
      expect(h.cf.flexibleCalls).toEqual([]);
    });

    it("never runs on a domain without the switch", async () => {
      const store = await edgeStore();
      const { domain } = project(store, "shop", host);
      store.updateDomain(domain.id, longCert);
      const h = harness(store);
      await h.loop.tick();
      await h.loop.checkNow(domain.id);
      expect(h.cf.flexibleCalls).toEqual([]);
    });
  });

  describe("a site that is Active but broken", () => {
    const longCert = { status: "active" as const, certNotAfter: new Date(t0.getTime() + 60 * DAY).toISOString() };

    it.each([526, 525, 521])(
      "warns on a Let's Encrypt domain about a %i, keeps it through ticks, and clears it when fixed",
      async (status) => {
        const { store, id } = await cloudflareDomain(longCert);
        const h = harness(store, { a: proxied });
        h.cf.flexible = { kind: "broken", status };
        await h.loop.tick();
        expect(store.getDomain(id)).toMatchObject({ status: "active", warning: brokenWarning(status) });

        h.advance(60_000);
        await h.loop.tick();
        expect(store.getDomain(id).warning).toBe(brokenWarning(status));
        expect(h.cf.flexibleCalls).toHaveLength(1);

        h.cf.flexible = "fine";
        h.advance(DAY);
        await h.loop.tick();
        expect(store.getDomain(id).warning).toBe("");
      },
    );

    it("keeps a broken warning through an unknown result, as it does Flexible's", async () => {
      const { store, id } = await cloudflareDomain(longCert);
      const h = harness(store, { a: proxied });
      h.cf.flexible = { kind: "broken", status: 526 };
      await h.loop.tick();
      h.cf.flexible = "unknown";
      h.advance(DAY);
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe(brokenWarning(526));
    });

    it("replaces Flexible with broken rather than showing both", async () => {
      const { store, id } = await cloudflareDomain(longCert);
      const h = harness(store, { a: proxied });
      h.cf.flexible = "flexible";
      await h.loop.tick();
      h.cf.flexible = { kind: "broken", status: 525 };
      h.advance(DAY);
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe(brokenWarning(525));
    });

    it("warns a pasted domain too, alongside its expiry warning", async () => {
      const { store, id } = await pastedDomain(10);
      const h = harness(store, { a: proxied });
      h.cf.flexible = { kind: "broken", status: 526 };
      await h.loop.tick();
      h.advance(60_000);
      await h.loop.tick();
      const d = store.getDomain(id);
      expect(d.status).toBe("active");
      expect(d.warning).toContain(brokenWarning(526));
      expect(d.warning).toContain(d.certNotAfter.slice(0, 10));
    });

    it("retries an unknown result after 1 hour, not a day", async () => {
      const { store } = await cloudflareDomain(longCert);
      const h = harness(store, { a: proxied });
      h.cf.flexible = "unknown";
      await h.loop.tick();
      h.advance(HOUR - 1);
      await h.loop.tick();
      expect(h.cf.flexibleCalls).toHaveLength(1);
      h.advance(1);
      h.cf.flexible = "flexible";
      await h.loop.tick();
      expect(h.cf.flexibleCalls).toHaveLength(2);
      h.advance(HOUR);
      await h.loop.tick();
      expect(h.cf.flexibleCalls).toHaveLength(2);
    });

    it("keeps a broken result daily", async () => {
      const { store } = await cloudflareDomain(longCert);
      const h = harness(store, { a: proxied });
      h.cf.flexible = { kind: "broken", status: 526 };
      await h.loop.tick();
      h.advance(HOUR);
      await h.loop.tick();
      expect(h.cf.flexibleCalls).toHaveLength(1);
    });

    it("says nothing about an unknown result on a Let's Encrypt domain", async () => {
      const { store, id } = await cloudflareDomain(longCert);
      const h = harness(store, { a: { [host]: ["5.6.7.8"] } });
      h.cf.flexible = "unknown";
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe("");
    });

    it("on a pasted domain, says when the host can't be reached and clears it when it can", async () => {
      const { store, id } = await pastedDomain(90);
      const h = harness(store, { a: proxied });
      h.cf.flexible = "unknown";
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe(hostUnreachableWarning(host));
      h.advance(60_000);
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe(hostUnreachableWarning(host));
      h.cf.flexible = "fine";
      h.advance(HOUR);
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe("");
    });

    it("on a pasted domain, warns when DNS isn't Cloudflare's, keeps it through ticks and clears it once proxied", async () => {
      const { store, id } = await pastedDomain(90);
      const a: Record<string, string[]> = { [host]: ["34.1.2.3"] };
      const h = harness(store, { a });
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe(notProxiedWarning(host));
      h.advance(60_000);
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe(notProxiedWarning(host));
      a[host] = ["104.16.1.1"];
      h.advance(DAY);
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe("");
    });

    it("on a pasted domain, warns when only some answers are Cloudflare's", async () => {
      const { store, id } = await pastedDomain(90);
      const h = harness(store, { a: { [host]: ["104.16.1.1", "34.1.2.3"] } });
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe(notProxiedWarning(host));
    });

    it("on a pasted domain, tells you to create the record when DNS has no answer", async () => {
      const { store, id } = await pastedDomain(90);
      const h = harness(store, { a: {} });
      await h.loop.tick();
      expect(store.getDomain(id).warning).toBe(noRecordWarning(host));
    });

    it("leaves the DNS warning as it was when the lookup fails", async () => {
      const { store, id } = await pastedDomain(90);
      let down = false;
      const a: Record<string, string[]> = {
        get [host](): string[] {
          if (down) throw new Error("SERVFAIL");
          return ["34.1.2.3"];
        },
      };
      const h = harness(store, { a });
      await h.loop.tick();
      down = true;
      h.advance(DAY);
      await h.loop.tick();
      expect(store.getDomain(id)).toMatchObject({ status: "active", warning: notProxiedWarning(host) });
    });

    it("composes every warning on a pasted domain", async () => {
      const { store, id } = await pastedDomain(10);
      const h = harness(store, { a: { [host]: ["34.1.2.3"] } });
      h.cf.flexible = "unknown";
      await h.loop.tick();
      const d = store.getDomain(id);
      expect(d.warning).toContain(hostUnreachableWarning(host));
      expect(d.warning).toContain(notProxiedWarning(host));
      expect(d.warning).toContain(d.certNotAfter.slice(0, 10));
    });

    it("checks a pasted domain's DNS at paste time", async () => {
      const { store, id } = await cloudflareDomain();
      const h = harness(store, { a: { [host]: ["34.1.2.3"] } });
      h.advance(3 * DAY);
      expect(await h.loop.pasteCert(id, fx("good.crt"), fx("good.key"))).toMatchObject({
        status: "active",
        warning: notProxiedWarning(host),
      });
    });
  });

  describe("range refresh", () => {
    it("runs at most once per 24 h and pushes the table only when the list changed", async () => {
      const store = await edgeStore();
      const h = harness(store);
      await h.loop.tick();
      expect(h.cf.refreshes).toBe(1);
      expect(h.pushes).toEqual([]);

      h.advance(DAY - 1);
      h.cf.refresh = true;
      await h.loop.tick();
      expect(h.cf.refreshes).toBe(1);

      h.advance(1);
      await h.loop.tick();
      expect(h.cf.refreshes).toBe(2);
      expect(h.pushes).toHaveLength(1);
    });

    it("keeps working through the domains when the refresh fails, and doesn't retry until tomorrow", async () => {
      const store = await edgeStore();
      const { domain } = project(store, "shop", host);
      const h = harness(store);
      h.cf.refresh = new Error("network down");
      await h.loop.tick();
      expect(store.getDomain(domain.id).status).toBe("active");
      h.advance(60_000);
      await h.loop.tick();
      expect(h.cf.refreshes).toBe(1);
    });

    it("doesn't run while no edge is installed", async () => {
      const store = await openTestStore();
      const h = harness(store);
      await h.loop.tick();
      expect(h.cf.refreshes).toBe(0);
    });
  });

  describe("a kept certificate", () => {
    const kept = (days: number) => ({
      certPem: "KEPT CERT",
      keyPem: "KEPT KEY",
      notAfter: new Date(t0.getTime() + days * DAY).toISOString(),
    });

    it.each([
      ["cert_pending", {}],
      ["failed", { nextAttemptAt: new Date(t0.getTime() - 1).toISOString(), failures: 1 }],
    ] as const)("writes it from %s without a reach check: no order is placed", async (status, patch) => {
      const { store, id } = await cloudflareDomain({ status, ...patch });
      store.setPendingCert(id, kept(60));
      const h = harness(store, { a: proxied });
      h.cf.reach = blocked;
      await h.loop.tick();
      expect(h.cf.reachCalls).toEqual([]);
      expect(h.acme.hosts).toEqual([]);
      expect(h.written).toEqual([{ name: secret, certPem: "KEPT CERT", keyPem: "KEPT KEY" }]);
      expect(store.getDomain(id).status).toBe("active");
    });

    it("writes it on a renewal without a reach check", async () => {
      const { store, id } = await cloudflareDomain({
        status: "active",
        certNotAfter: new Date(t0.getTime() + 10 * DAY).toISOString(),
      });
      store.setPendingCert(id, kept(60));
      const h = harness(store, { a: proxied });
      h.cf.reach = blocked;
      await h.loop.tick();
      expect(h.cf.reachCalls).toEqual([]);
      expect(store.getDomain(id).certNotAfter).toBe(kept(60).notAfter);
    });

    it("still runs the check when the kept certificate is too old to use", async () => {
      const { store, id } = await cloudflareDomain({ status: "cert_pending" });
      store.setPendingCert(id, kept(20));
      const h = harness(store, { a: proxied });
      h.cf.reach = blocked;
      await h.loop.tick();
      expect(h.cf.reachCalls).toHaveLength(1);
      expect(h.acme.hosts).toEqual([]);
    });
  });

  describe("the Always Use HTTPS message", () => {
    const pendingMessage = "Always Use HTTPS is on in Cloudflare and NBO has no certificate for shop.example.com yet.";
    const alwaysHttps: ReachResult = { ok: false, code: "always_https", message: pendingMessage };

    it("is the check's own for a pending domain", async () => {
      const { store, id } = await cloudflareDomain();
      const h = harness(store, { a: proxied });
      h.cf.reach = alwaysHttps;
      await h.loop.tick();
      expect(store.getDomain(id).lastError).toBe(pendingMessage);
    });

    it("talks about the renewal on an Active domain, which does have a certificate", async () => {
      const { store, id } = await cloudflareDomain({
        status: "active",
        certNotAfter: new Date(t0.getTime() + 10 * DAY).toISOString(),
      });
      const h = harness(store, { a: proxied });
      h.cf.reach = alwaysHttps;
      await h.loop.tick();
      expect(store.getDomain(id).lastError).toBe(renewalAlwaysHttpsMessage(host));
    });
  });

  describe("setBehindCloudflare", () => {
    async function plain(patch: Parameters<Store["updateDomain"]>[1] = {}) {
      const { store, id } = await cloudflareDomain({ behindCloudflare: false, ...patch });
      return { store, id, h: harness(store, { a: proxied }) };
    }

    it("refuses to turn on with an older edge", async () => {
      const { store, id, h } = await plain();
      store.updateServerSettings({ edgeVersion: "1" });
      const err = await h.loop.setBehindCloudflare(id, true).catch((e: Error) => e);
      expect(err).toBeInstanceOf(ErrConflict);
      expect((err as Error).message).toBe("Reinstall the edge first");
      expect(store.getDomain(id).behindCloudflare).toBe(false);
      expect(h.pushes).toEqual([]);
    });

    it("refuses default domains", async () => {
      const { store, id, h } = await plain({ kind: "default" });
      await expect(h.loop.setBehindCloudflare(id, true)).rejects.toBeInstanceOf(ErrConflict);
      expect(store.getDomain(id).behindCloudflare).toBe(false);
    });

    it("turns on, returns a failed domain to dns_pending with failures and backoff cleared, and pushes", async () => {
      const { id, h } = await plain({
        status: "failed",
        failures: 3,
        nextAttemptAt: new Date(t0.getTime() + DAY).toISOString(),
        lastError: "old",
      });
      const d = await h.loop.setBehindCloudflare(id, true);
      expect(d).toMatchObject({
        behindCloudflare: true,
        status: "dns_pending",
        failures: 0,
        nextAttemptAt: "",
        lastError: "",
      });
      expect(h.pushes).toHaveLength(1);
    });

    it.each(["dns_pending", "cert_pending"] as const)(
      "clears the old message when turned on from %s",
      async (status) => {
        const { id, h } = await plain({
          status,
          lastError: "This record looks proxied by Cloudflare: turn on Behind Cloudflare",
        });
        expect(await h.loop.setBehindCloudflare(id, true)).toMatchObject({ status, lastError: "" });
      },
    );

    it("leaves an Active domain's message alone when turned on", async () => {
      const { id, h } = await plain({
        status: "active",
        certNotAfter: new Date(t0.getTime() + 10 * DAY).toISOString(),
        lastError: "rate limited",
      });
      expect((await h.loop.setBehindCloudflare(id, true)).lastError).toBe("rate limited");
    });

    it("keeps an Active domain Active when turned on", async () => {
      const { id, h } = await plain({
        status: "active",
        certNotAfter: new Date(t0.getTime() + 60 * DAY).toISOString(),
      });
      expect(await h.loop.setBehindCloudflare(id, true)).toMatchObject({ behindCloudflare: true, status: "active" });
    });

    it("changes nothing when the switch is already where it was asked to be", async () => {
      const { store, id } = await cloudflareDomain({
        status: "failed",
        failures: 3,
        nextAttemptAt: new Date(t0.getTime() + DAY).toISOString(),
      });
      const h = harness(store, { a: proxied });
      const before = store.getDomain(id);
      expect(await h.loop.setBehindCloudflare(id, true)).toEqual(before);
      expect(h.pushes).toEqual([]);
    });

    it("turned off with Let's Encrypt: warning cleared, certificate kept", async () => {
      const certNotAfter = new Date(t0.getTime() + 60 * DAY).toISOString();
      const { store, id } = await cloudflareDomain({ status: "active", certNotAfter, warning: flexibleWarning });
      const h = harness(store, { a: proxied });
      const d = await h.loop.setBehindCloudflare(id, false);
      expect(d).toMatchObject({
        behindCloudflare: false,
        status: "active",
        certSource: "letsencrypt",
        certNotAfter,
        warning: "",
      });
      expect(h.deleted).toEqual([]);
      expect(h.pushes).toHaveLength(1);
    });

    it("turned off with a pasted certificate: same as removing it", async () => {
      const { store, id } = await pastedDomain(90);
      const h = harness(store, { a: proxied });
      const d = await h.loop.setBehindCloudflare(id, false);
      expect(d).toMatchObject({
        behindCloudflare: false,
        status: "dns_pending",
        certSource: "letsencrypt",
        certNotAfter: "",
        warning: "",
      });
      expect(store.getPastedCert(id)).toBeUndefined();
      expect(h.events).toEqual(["push", "delete"]);
      expect(h.deleted).toEqual([secret]);
    });

    it("turned off while waiting out a reach retry: the plain path isn't held back by it", async () => {
      const { store, id } = await cloudflareDomain({
        nextAttemptAt: new Date(t0.getTime() + 5 * 60_000).toISOString(),
      });
      const h = harness(store, { a: { [host]: ["34.1.2.3"] } });
      await h.loop.setBehindCloudflare(id, false);
      await h.loop.tick();
      expect(store.getDomain(id).status).toBe("active");
    });
  });

  describe("pasteCert", () => {
    // The fixtures became valid on 2026-11-06.
    const afterFixtures = 3 * DAY;

    it("refuses unless the switch is on", async () => {
      const { store, id } = await cloudflareDomain({ behindCloudflare: false });
      const h = harness(store, { a: proxied });
      h.advance(afterFixtures);
      await expect(h.loop.pasteCert(id, fx("good.crt"), fx("good.key"))).rejects.toBeInstanceOf(ErrConflict);
      expect(h.written).toEqual([]);
    });

    it("leaves the row and the Secret alone on a bad pair", async () => {
      const { store, id } = await cloudflareDomain();
      const h = harness(store, { a: proxied });
      h.advance(afterFixtures);
      const before = store.getDomain(id);
      await expect(h.loop.pasteCert(id, fx("good.crt"), fx("unrelated.key"))).rejects.toBeInstanceOf(ErrInvalid);
      expect(store.getDomain(id)).toEqual(before);
      expect(store.getPastedCert(id)).toBeUndefined();
      expect(h.written).toEqual([]);
    });

    it("writes the Secret first, drops a pending Let's Encrypt certificate, ends Active and pushes", async () => {
      const { store, id } = await cloudflareDomain({
        status: "failed",
        failures: 2,
        lastError: "old",
        nextAttemptAt: new Date(t0.getTime() + DAY).toISOString(),
      });
      store.setPendingCert(id, {
        certPem: "LE",
        keyPem: "LEKEY",
        notAfter: new Date(t0.getTime() + 60 * DAY).toISOString(),
      });
      const h = harness(store, { a: proxied });
      h.advance(afterFixtures);
      const notAfter = new Date(new X509Certificate(fx("good.crt")).validTo).toISOString();

      const d = await h.loop.pasteCert(id, fx("good.crt"), fx("good.key"));

      expect(h.events.slice(0, 2)).toEqual(["write", "push"]);
      expect(h.written).toEqual([{ name: secret, certPem: fx("good.crt"), keyPem: fx("good.key") }]);
      expect(d).toMatchObject({
        status: "active",
        certSource: "pasted",
        certNotAfter: notAfter,
        failures: 0,
        lastError: "",
        nextAttemptAt: "",
      });
      expect(store.getPastedCert(id)).toEqual({ certPem: fx("good.crt"), keyPem: fx("good.key"), notAfter });
      expect(store.getPendingCert(id)).toBeUndefined();
      expect(h.cf.flexibleCalls).toEqual([host]);

      // The Secret was just written: the daily pass isn't due.
      await h.loop.tick();
      expect(h.written).toHaveLength(1);
      expect(h.acme.hosts).toEqual([]);
    });

    it("leaves the row unchanged when the Secret write fails, with no key in the error", async () => {
      const { store, id } = await cloudflareDomain();
      const h = harness(store, { a: proxied });
      h.advance(afterFixtures);
      h.state.writeFails = 1;
      h.state.writeError = `kubectl failed: ${fx("good.key")}`;
      const before = store.getDomain(id);
      const err = await h.loop.pasteCert(id, fx("good.crt"), fx("good.key")).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("kubectl failed");
      expect((err as Error).message).not.toContain("PRIVATE KEY");
      expect(store.getDomain(id)).toEqual(before);
      expect(store.getPastedCert(id)).toBeUndefined();
    });

    it("doesn't fail the paste when the Flexible check throws", async () => {
      const { store, id } = await cloudflareDomain();
      const h = harness(store, { a: proxied });
      h.advance(afterFixtures);
      h.cf.flexible = new Error("network down");
      expect(await h.loop.pasteCert(id, fx("good.crt"), fx("good.key"))).toMatchObject({
        status: "active",
        warning: hostUnreachableWarning(host),
      });
    });
  });

  describe("removePastedCert", () => {
    it("goes back to Let's Encrypt, table pushed before the Secret is deleted", async () => {
      const { store, id } = await pastedDomain(10);
      store.updateDomain(id, { warning: "old" });
      const h = harness(store, { a: proxied });
      const d = await h.loop.removePastedCert(id);
      expect(d).toMatchObject({
        behindCloudflare: true,
        status: "dns_pending",
        certSource: "letsencrypt",
        certNotAfter: "",
        warning: "",
      });
      expect(store.getPastedCert(id)).toBeUndefined();
      expect(h.events).toEqual(["push", "delete"]);
      expect(h.deleted).toEqual([secret]);
    });

    it("refuses a domain with no pasted certificate, leaving its Let's Encrypt certificate alone", async () => {
      const { store, id } = await cloudflareDomain({
        status: "active",
        certNotAfter: new Date(t0.getTime() + 60 * DAY).toISOString(),
      });
      const h = harness(store, { a: proxied });
      await expect(h.loop.removePastedCert(id)).rejects.toBeInstanceOf(ErrConflict);
      expect(store.getDomain(id).status).toBe("active");
      expect(h.deleted).toEqual([]);
    });

    it("still finishes when deleting the Secret fails", async () => {
      const { store, id } = await pastedDomain(90);
      const h = harness(store, { a: proxied });
      h.state.deleteFails = true;
      expect(await h.loop.removePastedCert(id)).toMatchObject({ status: "dns_pending", certSource: "letsencrypt" });
    });
  });
});

describe("createAcmeClient", () => {
  function fakeLib(certPem: string) {
    const clients: { directoryUrl: string; accountKey: string }[] = [];
    const autos: Record<string, unknown>[] = [];
    let keys = 0;
    const lib: AcmeLib = {
      directory: {
        production: "https://acme-v02.api.letsencrypt.org/directory",
        staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
      },
      async createPrivateKey() {
        keys++;
        return Buffer.from(`ACCOUNT KEY ${keys}`);
      },
      async createCsr(data) {
        return [Buffer.from("CERT KEY"), Buffer.from(`CSR ${data.commonName}`)];
      },
      createClient(opts) {
        clients.push({ directoryUrl: opts.directoryUrl, accountKey: String(opts.accountKey) });
        return {
          async auto(o) {
            autos.push(o as unknown as Record<string, unknown>);
            const challenge = { type: "http-01", token: "abc", url: "", status: "pending" } as never;
            await o.challengeCreateFn({} as never, challenge, "abc.thumb");
            await o.challengeRemoveFn({} as never, challenge, "abc.thumb");
            return certPem;
          },
        };
      },
    };
    return { lib, clients, autos, keyCount: () => keys };
  }

  it("creates the account key once, seals it, and issues over HTTP-01", async () => {
    const store = await openTestStore();
    store.updateServerSettings({ acmeEmail: "ops@example.com", acmeDirectory: "staging" });
    const { certPem } = await createRelayCa(["34.1.2.3"]);
    const f = fakeLib(certPem);
    const acme = createAcmeClient(store, f.lib);
    const seen: string[] = [];

    const out = await acme.issue(
      "shop.example.com",
      async (t, k) => void seen.push(`create ${t} ${k}`),
      async (t) => void seen.push(`remove ${t}`),
    );
    await acme.issue(
      "shop.example.com",
      async () => {},
      async () => {},
    );

    expect(f.keyCount()).toBe(1);
    expect(store.getServerSecret("acme_account_key")).toBe("ACCOUNT KEY 1");
    expect(f.clients[0]).toEqual({
      directoryUrl: "https://acme-staging-v02.api.letsencrypt.org/directory",
      accountKey: "ACCOUNT KEY 1",
    });
    expect(f.autos[0]).toMatchObject({
      csr: Buffer.from("CSR shop.example.com"),
      email: "ops@example.com",
      termsOfServiceAgreed: true,
      challengePriority: ["http-01"],
    });
    expect(seen).toEqual(["create abc abc.thumb", "remove abc"]);
    expect(out).toEqual({
      certPem,
      keyPem: "CERT KEY",
      notAfter: new Date(new X509Certificate(certPem).validTo).toISOString(),
    });
  });
});

describe("createCertWriter", () => {
  it("applies the cert Secret in nbo-edge with the edge cluster's kubeconfig and deletes it", async () => {
    const store = await edgeStore();
    const calls: { args: string[]; input?: string }[] = [];
    const run: CommandRunner = async (_cmd, args, o) => {
      calls.push({ args, input: o?.input });
      if (calls.length === 3) throw new Error(`kubectl failed: ${o?.input}`);
      return "";
    };
    const kubeconfigs: string[] = [];
    const w = createCertWriter({ store, run, kubeconfigFor: async (id) => (kubeconfigs.push(id), "kc") });
    const name = certSecretName("shop.example.com");
    await w.writeCert(
      name,
      "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n",
      "-----BEGIN PRIVATE KEY-----\nSECRETKEY\n-----END PRIVATE KEY-----\n",
    );
    expect(kubeconfigs).toEqual([store.getServerSettings().edgeClusterId]);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["-n", "nbo-edge", "apply", "-f", "-"]));
    expect(calls[0]!.input).toContain(name);
    expect(calls[0]!.args.join(" ")).not.toContain("SECRETKEY");

    await w.deleteCert(name);
    expect(calls[1]!.args).toEqual(
      expect.arrayContaining(["-n", "nbo-edge", "delete", "secret", name, "--ignore-not-found"]),
    );

    const failKey = "-----BEGIN PRIVATE KEY-----\nFAILKEY\n-----END PRIVATE KEY-----\n";
    const err = await w.writeCert(name, "cert", failKey).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("kubectl failed");
    expect((err as Error).message).not.toContain(Buffer.from(failKey).toString("base64"));
  });
});

describe("wireV2 ACME challenges", () => {
  it("a reconcile keeps pending challenges in the route table it writes", async () => {
    const store = await edgeStore();
    project(store, "shop", "shop.example.com");
    let data: string | null = null;
    const run: CommandRunner = async (_cmd, args, o) => {
      const line = args.join(" ");
      if (line.includes("get configmap nbo-edge-routes")) {
        if (data === null) throw new Error('Error from server (NotFound): configmaps "nbo-edge-routes" not found');
        return JSON.stringify({ metadata: { resourceVersion: "1" }, data: { "routes.json": data } });
      }
      if (line.includes("create -f -")) {
        data = JSON.parse(/"?routes\.json"?: (.*)$/m.exec(o!.input!)![1]!) as string;
        return "";
      }
      if (line.includes("replace -f -")) {
        data = (JSON.parse(o!.input!) as { data: Record<string, string> }).data["routes.json"]!;
        return "";
      }
      throw new Error(`unexpected kubectl ${line}`);
    };
    const v2 = wireV2(store, {
      mode: "production",
      deploymentTrigger: fakeDeploymentTrigger(store),
      cloudSetup: fakeCloudSetup(),
      edgeAdminUrl: "http://127.0.0.1:1",
      edgePublicPort: 9443,
      googleConnect: fakeGoogleConnect(store),
      kubeConnect: fakeKubeConnect(store),
      run,
      kubeconfigFor: async () => "kc",
    });
    v2.challenges.set("tok_1", "tok_1.thumb");
    await v2.edgeSync.reconcile();
    expect((JSON.parse(data!) as RouteTable).challenges).toEqual({ tok_1: "tok_1.thumb" });
    expect(v2.domains).toBeDefined();
  });
});

describe("moving and removing mapped domains through the loop's queue", () => {
  function deferredGate() {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    return { promise, release };
  }
  const tick = () => new Promise<void>((r) => setTimeout(r, 20));

  it("a move requested during a describe waits, and its result is what stays", async () => {
    const store = await edgeStore();
    const dom = mapped(store);
    store.updateDomain(dom.id, { status: "cert_pending" });
    const cr = fakeCloudRun();
    cr.state = { records: cr.state!.records, ready: true, message: "" };
    const gate = deferredGate();
    cr.gate = gate.promise;
    const h = harness(store, { cloudRun: cr.api });
    const running = h.loop.tick();
    await tick();
    expect(cr.calls).toEqual(["describe shop.example.com"]);
    const moving = h.loop.moveToEdge(dom.id);
    await tick();
    // Still waiting behind the running pass.
    expect(store.getDomain(dom.id).serving).toBe("cloudrun");
    cr.gate = null;
    gate.release();
    await running;
    const moved = await moving;
    expect(moved).toMatchObject({ serving: "edge", status: "dns_pending", mappingKept: true });
    expect(store.getDomain(dom.id)).toMatchObject({ serving: "edge", status: "dns_pending", mappingKept: true });
    expect(cr.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
  });

  it("moveToEdge refuses a row that is no longer served by Cloud Run", async () => {
    const store = await edgeStore();
    const dom = mapped(store);
    const h = harness(store, { cloudRun: fakeCloudRun().api });
    await h.loop.moveToEdge(dom.id);
    await expect(h.loop.moveToEdge(dom.id)).rejects.toThrow(/already served by the edge/);
  });

  it("moveToEdge refuses without a Let's Encrypt email, since no certificate could be issued", async () => {
    const store = await edgeStore({ acmeEmail: "" });
    const dom = mapped(store);
    const h = harness(store, { cloudRun: fakeCloudRun().api });
    const err = await h.loop.moveToEdge(dom.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErrConflict);
    expect((err as Error).message).toBe(noEmailMessage);
    expect(store.getDomain(dom.id)).toMatchObject({ serving: "cloudrun", mappingKept: false });
  });

  it("moveToEdge refuses when the edge cluster's connection is gone", async () => {
    const store = await edgeStore();
    store.updateServerSettings({ edgeClusterId: "kc_gone" });
    const dom = mapped(store);
    const h = harness(store, { cloudRun: fakeCloudRun().api });
    const err = await h.loop.moveToEdge(dom.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErrConflict);
    expect((err as Error).message).toBe(edgeClusterGoneMessage);
    expect(store.getDomain(dom.id).serving).toBe("cloudrun");
  });

  it("a delete requested during a create waits, then removes the mapping the create made", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    const cr = fakeCloudRun();
    const gate = deferredGate();
    cr.gate = gate.promise;
    const h = harness(store, { cloudRun: cr.api });
    const running = h.loop.tick();
    await tick();
    const removing = h.loop.removeMapped(dom.id);
    await tick();
    expect(cr.calls).toEqual(["create shop.example.com"]);
    cr.gate = null;
    gate.release();
    await running;
    await removing;
    expect(cr.calls).toEqual(["create shop.example.com", "describe shop.example.com", "remove shop.example.com"]);
    expect(store.listDomains().some((d) => d.id === dom.id)).toBe(false);
  });

  it("a failed removal keeps the row and throws", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    const cr = fakeCloudRun();
    cr.removeError = new Error("gcloud exploded");
    const h = harness(store, { cloudRun: cr.api });
    await expect(h.loop.removeMapped(dom.id)).rejects.toThrow("gcloud exploded");
    expect(store.getDomain(dom.id).host).toBe("shop.example.com");
  });

  it("with no Cloud Run environment, removeMapped deletes the row and logs the host", async () => {
    const store = await openTestStore();
    const dom = mapped(store);
    const cr = fakeCloudRun();
    cr.target = null;
    const h = harness(store, { cloudRun: cr.api });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await h.loop.removeMapped(dom.id);
      expect(spy.mock.calls.some((c) => String(c[0]).includes("shop.example.com"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(store.listDomains().some((d) => d.id === dom.id)).toBe(false);
    expect(cr.calls).toEqual([]);
  });
});

describe("the ephemeral certificate cap (Review Focus 5)", () => {
  const base = "34-1-2-3.sslip.io";
  const prodHost = `shop.${base}`;
  const allAtEdge = (hosts: string[]) => Object.fromEntries(hosts.map((h) => [h, ["34.1.2.3"]]));

  // previewDomain: an ephemeral stage and its default domain row.
  function previewDomain(store: Store, projectId: string, branch: string) {
    const host = `${branch}--shop.${base}`;
    const p = store.createEphemeralStage(projectId, { branch, host, expiresAt: "", label: "" });
    return store.addDomain(projectId, host, "default", "edge", p.id);
  }

  function shop(store: Store) {
    const p = store.createProject("shop");
    store.updateProject(p.id, { edgeHost: prodHost });
    const env = store.createEnvironment(
      p.id,
      "cloudrun",
      "cloudrun",
      JSON.stringify({ project: "g", region: "r", arRepo: "a" }),
    );
    const d = store.createDeployment(env.id);
    store.completeDeployment(d.id, "sha256:x", "https://shop.a.run.app");
    store.setTrafficWeights(p.id, { [env.id]: 100 });
    return p;
  }

  it("registeredDomainOf drops the host's first label", () => {
    expect(registeredDomainOf(`feat--shop.${base}`)).toBe(base);
    expect(registeredDomainOf("feat--shop.example.dev")).toBe("example.dev");
  });

  it("after 20 preview orders in 7 days the 21st waits with the warning while Production's default host is still ordered", async () => {
    const store = await edgeStore();
    const p = shop(store);
    const previews = Array.from({ length: 21 }, (_, i) => previewDomain(store, p.id, `b${i + 10}`));
    const prod = store.addDomain(p.id, prodHost, "default");
    const h = harness(store, { a: allAtEdge([prodHost, ...previews.map((d) => d.host)]) });

    await h.loop.tick();

    expect(h.acme.hosts).toHaveLength(21);
    expect(h.acme.hosts).toContain(prodHost);
    expect(store.getDomain(prod.id).status).toBe("active");
    for (const d of previews.slice(0, 20)) expect(store.getDomain(d.id).status).toBe("active");
    const last = store.getDomain(previews[20]!.id);
    expect(last).toMatchObject({
      status: "cert_pending",
      warning: ephemeralCertCapWarning,
      nextAttemptAt: new Date(t0.getTime() + 7 * DAY).toISOString(),
    });
    expect(h.acme.hosts).not.toContain(last.host);
    expect(ephemeralCertCapReached(store, base, t0)).toBe(true);
    expect(store.countEphemeralCertOrders(base, new Date(t0.getTime() - 7 * DAY).toISOString())).toBe(20);
    // Production's order is not a preview order.
    expect(store.countEphemeralCertOrders(base, "")).toBe(20);

    // Still within the window: nothing ordered.
    h.advance(DAY);
    await h.loop.tick();
    expect(h.acme.hosts).toHaveLength(21);

    // Once the oldest order leaves the window, it gets its certificate and loses the warning.
    h.advance(6 * DAY);
    await h.loop.tick();
    expect(h.acme.hosts).toHaveLength(22);
    expect(store.getDomain(last.id)).toMatchObject({ status: "active", warning: "" });
  });

  it("the cap is per registered domain", async () => {
    const store = await edgeStore();
    const p = shop(store);
    for (let i = 0; i < 20; i++)
      store.recordEphemeralCertOrder("example.dev", `x${i}--shop.example.dev`, t0.toISOString());
    const d = previewDomain(store, p.id, "feat");
    const h = harness(store, { a: allAtEdge([d.host]) });
    await h.loop.tick();
    expect(store.getDomain(d.id).status).toBe("active");
    expect(store.countEphemeralCertOrders(base, "")).toBe(1);
  });

  it("a renewal of a preview host counts too: over the cap it waits, still Active, with the warning", async () => {
    const store = await edgeStore();
    const p = shop(store);
    const d = previewDomain(store, p.id, "feat");
    store.updateDomain(d.id, { status: "active", certNotAfter: new Date(t0.getTime() + 10 * DAY).toISOString() });
    for (let i = 0; i < 20; i++)
      store.recordEphemeralCertOrder(base, `x${i}--shop.${base}`, new Date(t0.getTime() - DAY).toISOString());
    const h = harness(store, { a: allAtEdge([d.host]) });

    await h.loop.tick();
    expect(h.acme.hosts).toEqual([]);
    expect(store.getDomain(d.id)).toMatchObject({
      status: "active",
      warning: ephemeralCertCapWarning,
      nextAttemptAt: new Date(t0.getTime() + 6 * DAY).toISOString(),
    });

    h.advance(6 * DAY);
    await h.loop.tick();
    expect(h.acme.hosts).toEqual([d.host]);
    expect(store.getDomain(d.id)).toMatchObject({
      status: "active",
      warning: "",
      certNotAfter: new Date(t0.getTime() + 6 * DAY + 90 * DAY).toISOString(),
    });
    expect(store.countEphemeralCertOrders(base, new Date(t0.getTime() - 2 * DAY).toISOString())).toBe(21);
  });

  it("an order counts only when ACME is really called: a kept certificate places none, even over the cap", async () => {
    const store = await edgeStore();
    const p = shop(store);
    const d = previewDomain(store, p.id, "feat");
    store.updateDomain(d.id, { status: "cert_pending" });
    store.setPendingCert(d.id, {
      certPem: "CERT kept",
      keyPem: "KEY kept",
      notAfter: new Date(t0.getTime() + 80 * DAY).toISOString(),
    });
    for (let i = 0; i < 20; i++) store.recordEphemeralCertOrder(base, `x${i}--shop.${base}`, t0.toISOString());
    const h = harness(store, { a: allAtEdge([d.host]) });
    await h.loop.tick();
    expect(h.acme.hosts).toEqual([]);
    expect(store.getDomain(d.id).status).toBe("active");
    expect(store.countEphemeralCertOrders(base, "")).toBe(20);
  });

  it("orders older than 7 days are pruned, and deleting the project keeps its orders", async () => {
    const store = await edgeStore();
    const p = shop(store);
    store.recordEphemeralCertOrder(base, `old--shop.${base}`, new Date(t0.getTime() - 8 * DAY).toISOString());
    store.recordEphemeralCertOrder(base, `new--shop.${base}`, t0.toISOString());
    expect(store.countEphemeralCertOrders(base, "")).toBe(1);
    store.deleteProject(p.id);
    expect(store.countEphemeralCertOrders(base, "")).toBe(1);
  });
});
