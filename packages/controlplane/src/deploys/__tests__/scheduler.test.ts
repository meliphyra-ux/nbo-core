// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { getEventListeners } from "node:events";
import { createStore, type Store, type Environment } from "../../store/store.js";
import { signCron } from "../cron.js";
import { tick, run, schedulerConfig, type Scheduler } from "../scheduler.js";

const openStores: Store[] = [];
let server: Server | import("node:https").Server | undefined;

afterEach(async () => {
  for (const s of openStores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed by the test itself — fine
    }
  }
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-scheduler-"));
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

function startBackend(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

// startSelfSignedSslipBackend: a real HTTPS server on a real
// self-signed cert, reachable through a real *.127.0.0.1.sslip.io
// hostname (sslip.io's own wildcard DNS resolves any subdomain of
// that suffix to the literal 127.0.0.1 — the same convention every
// real cluster deploy in this repo already serves behind, via
// cert-manager's own selfsigned issuer). Exercises the real DNS +
// TLS path a plain fetch() would hit against the real cluster,
// unlike startBackend's own plain HTTP.
async function startSelfSignedSslipBackend(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-scheduler-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "pipe" },
  );
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  return new Promise((resolve) => {
    server = createHttpsServer({ key, cert }, handler);
    server.listen(0, () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`https://cron-scheduler-tls-test.127.0.0.1.sslip.io:${port}`);
    });
  });
}

async function newSchedulerTestEnv(envName: string, config?: string): Promise<{ store: Store; env: Environment }> {
  const store = await openTestStore();
  const proj = store.createProject("acme");
  const env = store.createEnvironment(proj.id, envName, "kubernetes", config);
  store.setCronSigningSecret(env.id, "test-secret");
  return { store, env };
}

function cronFixture(id: string, schedule: string) {
  return {
    id,
    schedule,
    target: { function: "ssr", path: `/api/cron/${id}`, method: "POST" },
    overlap: "skip",
    timeoutSec: 60,
  };
}

async function writeCronManifest(crons: Record<string, unknown>[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-scheduler-manifest-"));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0", crons }));
  return dir;
}

function waitForHits(getHits: () => number, want: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (getHits() >= want) return resolve();
      if (Date.now() > deadline)
        return reject(new Error(`expected at least ${want} hits within the timeout, got ${getHits()}`));
      setTimeout(check, 10);
    };
    check();
  });
}

describe("tick", () => {
  it("fires a signed request for a due cron on production", async () => {
    let hits = 0;
    let gotAuth: string | undefined;
    let gotTS: string | undefined;
    let gotCronHeader: string | undefined;
    const backendURL = await startBackend((req, res) => {
      hits++;
      gotAuth = req.headers.authorization;
      gotTS = req.headers["x-nbo-cron-timestamp"] as string | undefined;
      gotCronHeader = req.headers["x-nbo-cron"] as string | undefined;
      res.end();
    });

    const { store, env } = await newSchedulerTestEnv("production");
    const dep = store.createDeployment(env.id);
    store.completeDeployment(dep.id, "sha256:abc", backendURL);

    const dir = await writeCronManifest([cronFixture("a", "* * * * *")]);
    store.registerCronsFromManifest(env.id, dir);
    // Force the cron due right now rather than waiting out a real minute.
    store.releaseCron(env.id, "a", new Date(), new Date(Date.now() - 60_000));

    const sched: Scheduler = { store };
    await tick(sched, new Date());
    await waitForHits(() => hits, 1);

    const ts = Number(gotTS);
    expect(Number.isInteger(ts)).toBe(true);
    expect(gotAuth).toBe(`Bearer ${signCron("test-secret", "a", ts)}`);
    expect(gotCronHeader).toBe("a");
  });

  // Real bug found running Slice 4's crons verify script for real
  // against the local kind cluster: every real deploy there is served
  // over HTTPS with cert-manager's own selfsigned issuer (every other
  // test in this file uses startBackend's plain HTTP, which never
  // exercises this at all) — confirmed directly that a plain fetch()
  // rejects a self-signed cert outright, and that rejection was
  // silently swallowed by invoke()'s own catch, so a cron never fired
  // against any real cluster deploy, ever, with totalAttempts staying
  // at 0 at the target the whole time. No injected httpClient here —
  // this exercises the real default path main.ts's own Scheduler
  // actually runs with.
  it("fires for real through a self-signed TLS cert on a real *.sslip.io hostname, with no httpClient override", async () => {
    let hits = 0;
    const backendURL = await startSelfSignedSslipBackend((_req, res) => {
      hits++;
      res.end();
    });

    const { store, env } = await newSchedulerTestEnv("production");
    const dep = store.createDeployment(env.id);
    store.completeDeployment(dep.id, "sha256:abc", backendURL);

    const dir = await writeCronManifest([cronFixture("a", "* * * * *")]);
    store.registerCronsFromManifest(env.id, dir);
    store.releaseCron(env.id, "a", new Date(), new Date(Date.now() - 60_000));

    const sched: Scheduler = { store };
    await tick(sched, new Date());
    await waitForHits(() => hits, 1);
  }, 15000);

  it("never fires on non-production without opt-in", async () => {
    let hits = 0;
    const backendURL = await startBackend((_req, res) => {
      hits++;
      res.end();
    });

    const { store, env } = await newSchedulerTestEnv("staging");
    const dep = store.createDeployment(env.id);
    store.completeDeployment(dep.id, "sha256:abc", backendURL);

    const dir = await writeCronManifest([cronFixture("a", "* * * * *")]);
    store.registerCronsFromManifest(env.id, dir);
    store.releaseCron(env.id, "a", new Date(), new Date(Date.now() - 60_000));

    const sched: Scheduler = { store };
    await tick(sched, new Date());
    // A real wait, not an instant check — firing is async, so an
    // instant check would pass trivially even if this were broken
    // and about to fire a moment later.
    await new Promise((r) => setTimeout(r, 300));
    expect(hits).toBe(0);
  });

  it("fires on non-production with opt-in", async () => {
    let hits = 0;
    const backendURL = await startBackend((_req, res) => {
      hits++;
      res.end();
    });

    const { store, env } = await newSchedulerTestEnv("staging", JSON.stringify({ cronsEnabled: true }));
    const dep = store.createDeployment(env.id);
    store.completeDeployment(dep.id, "sha256:abc", backendURL);

    const dir = await writeCronManifest([cronFixture("a", "* * * * *")]);
    store.registerCronsFromManifest(env.id, dir);
    store.releaseCron(env.id, "a", new Date(), new Date(Date.now() - 60_000));

    const sched: Scheduler = { store };
    await tick(sched, new Date());
    await waitForHits(() => hits, 1);
  });

  it("overlap: skip prevents a second concurrent fire of a still-running cron", async () => {
    let hits = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const backendURL = await startBackend((_req, res) => {
      hits++;
      released.then(() => res.end());
    });

    const { store, env } = await newSchedulerTestEnv("production");
    const dep = store.createDeployment(env.id);
    store.completeDeployment(dep.id, "sha256:abc", backendURL);

    const dir = await writeCronManifest([cronFixture("a", "* * * * *")]);
    store.registerCronsFromManifest(env.id, dir);
    store.releaseCron(env.id, "a", new Date(), new Date(Date.now() - 60_000));

    const sched: Scheduler = { store };
    void tick(sched, new Date());
    // Give the first tick time to claim and start its (hanging) request.
    await waitForHits(() => hits, 1);

    await tick(sched, new Date());
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(hits).toBe(1);
  });

  // Final-review finding I4: invoke() is fire-and-forget (`void
  // invoke(...)`); a throw from releaseCron/releaseNextRunOnly in its
  // own finally block — e.g. the store closing mid-flight during a
  // graceful shutdown — became an unhandled rejection that can crash
  // the whole process once this scheduler runs unsupervised.
  it("a release failure after invoke completes does not become an unhandled rejection", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const backendURL = await startBackend((_req, res) => {
      released.then(() => res.end());
    });

    const { store, env } = await newSchedulerTestEnv("production");
    const dep = store.createDeployment(env.id);
    store.completeDeployment(dep.id, "sha256:abc", backendURL);

    const dir = await writeCronManifest([cronFixture("a", "* * * * *")]);
    store.registerCronsFromManifest(env.id, dir);
    store.releaseCron(env.id, "a", new Date(), new Date(Date.now() - 60_000));

    const sched: Scheduler = { store };
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);

    try {
      await tick(sched, new Date());
      store.close();
      const idx = openStores.indexOf(store);
      if (idx !== -1) openStores.splice(idx, 1); // afterEach must not double-close
      release();
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
  });

  // Final-review finding M5: invoke() never reads or cancels the
  // response body, so a backend that sends headers and then streams
  // forever keeps its connection open indefinitely — the per-
  // invocation AbortController only covers waiting for headers.
  it("cancels the response body instead of leaving the connection open", async () => {
    let socketClosed = false;
    const backendURL = await startBackend((_req, res) => {
      res.writeHead(200);
      res.write("partial-data"); // deliberately never res.end()
      res.socket?.on("close", () => {
        socketClosed = true;
      });
    });

    const { store, env } = await newSchedulerTestEnv("production");
    const dep = store.createDeployment(env.id);
    store.completeDeployment(dep.id, "sha256:abc", backendURL);

    const dir = await writeCronManifest([cronFixture("a", "* * * * *")]);
    store.registerCronsFromManifest(env.id, dir);
    store.releaseCron(env.id, "a", new Date(), new Date(Date.now() - 60_000));

    const sched: Scheduler = { store };
    await tick(sched, new Date());
    await new Promise((r) => setTimeout(r, 500));
    expect(socketClosed).toBe(true);
  });
});

describe("run", () => {
  afterEach(() => {
    schedulerConfig.cronTickIntervalMs = 30_000;
  });

  // Final-review finding I5: run() awaited tick() with no catch, so
  // one bad row (any fireOne throw — an unknown environment, a
  // malformed config, a SQLite error) stopped every environment's
  // crons forever instead of just that tick.
  it("one tick error does not stop run() from ticking again", async () => {
    const { store } = await newSchedulerTestEnv("production");
    let calls = 0;
    const flakyStore = Object.create(store) as Store;
    flakyStore.dueCrons = (now: Date) => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return store.dueCrons(now);
    };
    const sched: Scheduler = { store: flakyStore };

    schedulerConfig.cronTickIntervalMs = 20;
    const controller = new AbortController();
    const runPromise = run(sched, controller.signal);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await expect(runPromise).resolves.toBeUndefined();

    expect(calls).toBeGreaterThan(1);
  });

  // Final-review finding M4: a {once:true} abort listener was added
  // every tick and only ever removed by the listener itself firing —
  // never by the timer path, leaking one closure per tick for the
  // life of the process.
  it("does not leak an abort listener per tick", async () => {
    const { store } = await newSchedulerTestEnv("production");
    const sched: Scheduler = { store };

    schedulerConfig.cronTickIntervalMs = 5;
    const controller = new AbortController();
    const runPromise = run(sched, controller.signal);
    await new Promise((r) => setTimeout(r, 60));
    expect(getEventListeners(controller.signal, "abort").length).toBeLessThanOrEqual(1);
    controller.abort();
    await runPromise;
  });
});
