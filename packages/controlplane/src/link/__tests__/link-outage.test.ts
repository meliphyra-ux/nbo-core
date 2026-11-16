// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../store/store.js";
import { createDispatcher } from "../dispatch.js";
import { startLinkClient, type LinkClient } from "../client.js";
import { defaultWebSocket } from "../transport.js";
import { pollOnce } from "../../git/poller.js";
import { tick as cronTick } from "../../deploys/scheduler.js";
import { createChallengeStore, createDomainLoop, type AcmeClient } from "../../domains/certs.js";
import type { EdgeSync } from "../../edge/edge-sync.js";
import type { Resolver } from "../../domains/dns-check.js";
import { expiryPass } from "../../stages/stage-expiry.js";
import { stageRowName } from "../../stages/stages.js";
import { startHarness, deployedProject, staticSetup, type Harness } from "../../__tests__/v2-harness.js";
import { keyGate, sshRepo } from "../../__tests__/key-gate-fixture.js";
import { makeLinkTestKeys, noSecrets, pinLink, type LinkTestKeys } from "../../__tests__/link-keys-fixture.js";

// The anti-goal: sites never go down because the platform is down. With the
// link pointed at an address that refuses (nothing listens) or one that
// hangs (a documentation address nobody routes), the things core does for
// its sites all still complete: a push is built and deployed, a certificate
// near its end is renewed, a due cron fires, an expired ephemeral stage is
// removed, and main() starts and answers /healthz at once. The client's
// status stays "connecting" throughout, so the link really was down.
//
// Real certificate renewal can't run on kind, so this test is where the
// certificate path is proven with the link down (the ACME client, resolver
// and certificate writer are the fakes certs.test.ts uses).

let keys: LinkTestKeys;
beforeAll(async () => {
  keys = await makeLinkTestKeys();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const DAY = 24 * 3_600_000;
const until = async (f: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

// down: a harness whose link is pinned to url and a client trying it.
async function down(url: string, harnessOpts: Parameters<typeof startHarness>[0] = {}) {
  const h: Harness = await startHarness({ secretKey: true, ...harnessOpts });
  cleanups.push(() => h.close());
  await pinLink(h.store, keys, { linkUrl: url, linkHost: new URL(url).host });
  const dispatcher = createDispatcher({ ...noSecrets, store: h.store, mux: h.mux });
  const ctl = new AbortController();
  // Count the client's connection attempts (WebSocket opens and HTTP
  // requests), so each test proves the link really tried and failed.
  let attempts = 0;
  const wsFactory = (u: string) => {
    attempts++;
    return defaultWebSocket(u);
  };
  const fetchFn: typeof fetch = (...a) => {
    attempts++;
    return fetch(...a);
  };
  const client: LinkClient = startLinkClient({
    store: h.store,
    dispatcher,
    signal: ctl.signal,
    random: () => 0.5,
    wsFactory,
    fetch: fetchFn,
  });
  cleanups.push(async () => {
    ctl.abort();
    await client.stop();
  });
  await until(() => client.status().connection === "connecting");
  await until(() => attempts > 0);
  return { h, client, attempts: () => attempts };
}

function describeOutage(label: string, url: string): void {
  describe(`the link is down: ${label}`, () => {
    it("a push is built and deployed", async () => {
      const { h, client, attempts } = await down(url);
      const id = await deployedProject(h);
      const next = await h.commit("second");
      await pollOnce({ store: h.store, queue: h.v2.queue, edgeSync: h.v2.edgeSync });
      await h.v2.queue.idle(id);
      const builds = h.store.listBuilds(id);
      expect(builds.map((b) => b.revision)).toEqual([h.head, next]);
      expect(builds[1]!.status).toBe("succeeded");
      expect(client.status().connection).toBe("connecting");
      expect(attempts()).toBeGreaterThan(0);
      // Two real git builds: ~1 s alone, 4-5 s when the whole suite runs in
      // parallel. Nothing here waits on the link (same time refused or hung).
    }, 15_000);

    it("a deploy-key project waiting for its key completes by the poll alone", async () => {
      const k = keyGate();
      const { h, client, attempts } = await down(url, { repoAliases: [sshRepo], v2: k.v2 });
      const res = await h.call(
        "POST",
        "/projects/setup",
        staticSetup({ repo: sshRepo, credential: { kind: "deploy-key" } }),
      );
      expect(res.status, res.text).toBe(201);
      const id = res.json.project.id as string;
      await h.v2.setup.settled(id);
      expect(h.store.getProject(id).setupStatus).toBe("waiting-for-key");
      k.gate.open = true;
      await pollOnce({
        store: h.store,
        queue: h.v2.queue,
        edgeSync: h.v2.edgeSync,
        poller: h.v2.poller,
        setup: h.v2.setup,
      });
      await h.v2.queue.idle(id);
      expect(h.store.getProject(id).setupStatus).toBe("ready");
      expect(h.store.listBuilds(id).map((b) => b.status)).toEqual(["succeeded"]);
      expect(client.status().connection).toBe("connecting");
      expect(attempts()).toBeGreaterThan(0);
    }, 15_000);

    it("a certificate with 29 days left is renewed", async () => {
      const { h, client, attempts } = await down(url);
      const store = h.store;
      const clusterId = store.saveKubernetesConnection(
        {
          name: "edge",
          server: "https://edge.example:6443",
          registry: { kind: "custom", server: "ghcr.io", username: "me" },
        },
        { kubeconfig: "edge-kubeconfig" },
      ).id;
      store.updateServerSettings({ edgeClusterId: clusterId, edgeAddress: "34.1.2.3", acmeEmail: "ops@example.com" });
      const p = store.createProject("shop");
      store.updateProject(p.id, { edgeHost: "shop.34-1-2-3.sslip.io" });
      const env = store.createEnvironment(
        p.id,
        "cloudrun",
        "cloudrun",
        JSON.stringify({ project: "g", region: "r", arRepo: "a" }),
      );
      const d = store.createDeployment(env.id);
      store.completeDeployment(d.id, "sha256:x", "https://shop.a.run.app");
      store.setTrafficWeights(p.id, { [env.id]: 100 });
      const domain = store.addDomain(p.id, "shop.example.com", "custom");
      const now = new Date("2026-11-04T10:00:00.000Z");
      store.updateDomain(domain.id, {
        status: "active",
        certNotAfter: new Date(now.getTime() + 29 * DAY).toISOString(),
      });

      const hosts: string[] = [];
      const acme: AcmeClient = {
        async issue(host, onChallenge, onCleanup) {
          hosts.push(host);
          await onChallenge("tok", "tok.thumb");
          await onCleanup("tok");
          return {
            certPem: `CERT ${host}`,
            keyPem: `KEY ${host}`,
            notAfter: new Date(now.getTime() + 90 * DAY).toISOString(),
          };
        },
      };
      const written: string[] = [];
      const resolver: Resolver = {
        async resolve4() {
          return ["34.1.2.3"];
        },
        async resolve6() {
          return [];
        },
        async resolveCname() {
          return [];
        },
      };
      const loop = createDomainLoop({
        store,
        resolver,
        acme,
        edgeSync: { async push() {} } as unknown as EdgeSync,
        challenges: createChallengeStore(),
        ranges: {
          isCloudflare: () => false,
          async refresh() {
            return false;
          },
        },
        writeCert: async (name) => void written.push(name),
        deleteCert: async () => {},
        now: () => now,
        sleep: async () => {},
        probe: async () => true,
      });
      await loop.tick();
      expect(hosts).toEqual(["shop.example.com"]);
      expect(written).toHaveLength(1);
      expect(store.getDomain(domain.id)).toMatchObject({
        status: "active",
        certNotAfter: new Date(now.getTime() + 90 * DAY).toISOString(),
      });
      expect(client.status().connection).toBe("connecting");
      expect(attempts()).toBeGreaterThan(0);
    }, 5000);

    it("a due cron fires", async () => {
      const { h, client, attempts } = await down(url);
      const store = h.store;
      const proj = store.createProject("acme");
      const env = store.createEnvironment(proj.id, "production", "kubernetes");
      store.setCronSigningSecret(env.id, "test-secret");
      const dep = store.createDeployment(env.id);
      store.completeDeployment(dep.id, "sha256:abc", "https://acme.example.test");
      const dir = await mkdtemp(join(tmpdir(), "nbo-outage-cron-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({
          specVersion: "1.0",
          crons: [
            {
              id: "a",
              schedule: "* * * * *",
              target: { function: "ssr", path: "/api/cron/a", method: "POST" },
              overlap: "skip",
              timeoutSec: 60,
            },
          ],
        }),
      );
      store.registerCronsFromManifest(env.id, dir);
      store.releaseCron(env.id, "a", new Date(), new Date(Date.now() - 60_000));
      const calls: string[] = [];
      const httpClient = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(null, { status: 200 });
      }) as typeof fetch;
      await cronTick({ store, httpClient }, new Date());
      await until(() => calls.length >= 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("/api/cron/a");
      expect(client.status().connection).toBe("connecting");
      expect(attempts()).toBeGreaterThan(0);
    }, 5000);

    it("an expired ephemeral stage is removed", async () => {
      const { h, client, attempts } = await down(url);
      const store = h.store;
      const p = store.createProject("shop");
      store.updateProject(p.id, { edgeHost: "shop.example.dev" });
      const host = "old--shop.example.dev";
      const now = new Date("2026-11-12T10:00:00.000Z");
      const stage = store.createEphemeralStage(p.id, {
        branch: "feature/old",
        host,
        expiresAt: new Date(now.getTime() - 60_000).toISOString(),
        label: "branch old",
      });
      const env = store.createEnvironment(
        p.id,
        stageRowName(stage, { target: "cloudrun" }),
        "cloudrun",
        JSON.stringify({ project: "my-proj-1", region: "us-east1" }),
        stage.id,
      );
      store.addDomain(p.id, host, "default", "edge", stage.id);
      const removed: string[] = [];
      await expiryPass({
        store,
        edgeSync: { async remove() {}, async push() {} } as unknown as EdgeSync,
        cloudTeardown: {
          async remove(t) {
            removed.push(t.appName);
          },
        },
        certs: { async deleteCert() {} },
        mode: "production",
        now: () => now,
      });
      expect(removed).toHaveLength(1);
      expect(store.getStage(stage.id)).toMatchObject({ removal: "removed" });
      expect(store.getEnvironment(env.id).archived).toBe(true);
      expect(client.status().connection).toBe("connecting");
      expect(attempts()).toBeGreaterThan(0);
    }, 5000);

    it("main starts and answers /healthz within 1 s while the link can't connect", async () => {
      const { main } = await import("../../main.js");
      const dir = await mkdtemp(join(tmpdir(), "nbo-outage-main-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
      const dbPath = join(dir, "nbo.db");
      const keyFile = join(dir, "nbo-secret.key");
      const secretKey = randomBytes(32);
      await writeFile(keyFile, secretKey);
      const s = createStore(dbPath, { secretKey });
      await pinLink(s, keys, { linkUrl: url, linkHost: new URL(url).host });
      s.close();
      const before = process.exitCode;
      const t0 = Date.now();
      const started = main({
        NBO_CONTROL_PLANE_DB: dbPath,
        NBO_SECRET_KEY_FILE: keyFile,
        NBO_CONTROL_PLANE_ADDR: "127.0.0.1:0",
        NBO_EDGE_ADMIN_URL: "http://127.0.0.1:9",
      });
      cleanups.push(async () => {
        process.exitCode = before;
        await started?.close();
      });
      expect(started).toBeDefined();
      const port = await started!.listening;
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(1000);
    }, 5000);
  });
}

describeOutage("connection refused", "http://127.0.0.1:1");
describeOutage("connect hangs", "https://192.0.2.1");
