// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createStore, type Store } from "../../store/store.js";
import { stageRowName, type Stage } from "../stages.js";
import { deployAppName } from "../../deploys/deploy.js";
import { certSecretName } from "../../edge/edge-manifests.js";
import { createCloudTeardown, type CloudTeardown, type TeardownTarget } from "../../clouds/cloud-teardown.js";
import type { EdgeSync } from "../../edge/edge-sync.js";
import type { CommandRunner } from "@nbo/deploy";
import { expiryPass, removeStage, type ExpiryDeps } from "../stage-expiry.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const t0 = new Date("2026-11-12T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

interface World {
  store: Store;
  dbPath: string;
  dir: string;
  projectId: string;
  prefix: string;
  clusterId: string;
}

// world: a production store with an edge cluster and a project whose
// Production runs on Kubernetes ("k8s") and Cloud Run ("cloudrun").
async function world(): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-stage-expiry-"));
  const dbPath = join(dir, "t.db");
  const key = randomBytes(32);
  const store = createStore(dbPath, { secretKey: key });
  cleanups.push(async () => {
    try {
      store.close();
    } catch {
      // closed by the test
    }
    await rm(dir, { recursive: true, force: true });
  });
  const clusterId = store.saveKubernetesConnection(
    {
      name: "prod",
      server: "https://k8s.example:6443",
      registry: { kind: "custom", server: "ghcr.io", username: "bot" },
    },
    { kubeconfig: "apiVersion: v1\nusers:\n- user:\n    token: KUBE-TOKEN-SECRET\n", registryPassword: "pw" },
  ).id;
  store.updateServerSettings({ edgeClusterId: clusterId, edgeAddress: "34.1.2.3", acmeEmail: "ops@example.com" });
  const project = store.createProject("shop");
  store.updateProject(project.id, { edgeHost: "shop.example.dev" });
  store.addDomain(project.id, "shop.example.dev", "default");
  store.createEnvironment(project.id, "k8s", "kubernetes", JSON.stringify({ clusterId }));
  store.createEnvironment(
    project.id,
    "cloudrun",
    "cloudrun",
    JSON.stringify({ project: "my-proj-1", region: "us-east1" }),
  );
  return { store, dbPath, dir, projectId: project.id, prefix: `p${project.id.split("_")[1]!.slice(0, 8)}`, clusterId };
}

function rename(w: World, stageId: string, name: string): void {
  const db = new DatabaseSync(w.dbPath);
  try {
    db.prepare("UPDATE stages SET name = ? WHERE id = ?").run(name, stageId);
  } finally {
    db.close();
  }
}

function addEphemeral(
  w: World,
  label: string,
  opts: { expiresAt?: string; target?: "kubernetes" | "cloudrun"; name?: string } = {},
) {
  const host = `${label}--shop.example.dev`;
  let stage: Stage = w.store.createEphemeralStage(w.projectId, {
    branch: `feature/${label}`,
    host,
    expiresAt: opts.expiresAt ?? iso(t0.getTime() + DAY),
    label: `branch ${label}`,
  });
  if (opts.name) {
    rename(w, stage.id, opts.name);
    stage = w.store.getStage(stage.id);
  }
  const target = opts.target ?? "kubernetes";
  const config = target === "kubernetes" ? { clusterId: w.clusterId } : { project: "my-proj-1", region: "us-east1" };
  const env = w.store.createEnvironment(
    w.projectId,
    stageRowName(stage, target === "kubernetes" ? { target, clusterId: w.clusterId } : { target }),
    target,
    JSON.stringify(config),
    stage.id,
  );
  const domain = w.store.addDomain(w.projectId, host, "default", "edge", stage.id);
  return { stage, env, host, domain };
}

function addCustom(w: World, name: string) {
  const host = `${name}--shop.example.dev`;
  const created = w.store.createStage(w.projectId, { name: "staging", branch: `branch-${name}`, host });
  rename(w, created.id, name);
  const stage = w.store.getStage(created.id);
  const env = w.store.createEnvironment(
    w.projectId,
    stageRowName(stage, { target: "cloudrun" }),
    "cloudrun",
    JSON.stringify({ project: "my-proj-1", region: "us-east1" }),
    stage.id,
  );
  const domain = w.store.addDomain(w.projectId, host, "default", "edge", stage.id);
  return { stage, env, host, domain };
}

interface Fakes {
  events: string[];
  teardowns: TeardownTarget[];
  teardown: CloudTeardown & { failWith: Error | null };
  deps: ExpiryDeps;
  advance(ms: number): void;
}

function fakes(w: World, extra: Partial<ExpiryDeps> = {}): Fakes {
  let now = t0;
  const events: string[] = [];
  const teardowns: TeardownTarget[] = [];
  const edgeSync = {
    async remove(host: string) {
      events.push(`edge.remove ${host}`);
    },
    async push() {
      events.push("edge.push");
    },
  } as unknown as EdgeSync;
  const teardown: Fakes["teardown"] = {
    failWith: null,
    async remove(t) {
      events.push(`teardown ${t.appName}`);
      teardowns.push(t);
      if (teardown.failWith) throw teardown.failWith;
    },
  };
  const deps: ExpiryDeps = {
    store: w.store,
    edgeSync,
    cloudTeardown: teardown,
    certs: {
      async deleteCert(name) {
        events.push(`cert.delete ${name}`);
      },
    },
    mode: "production",
    now: () => now,
    ...extra,
  };
  return {
    events,
    teardowns,
    teardown,
    deps,
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("expiryPass", () => {
  it("removes an expired ephemeral stage (its app, route and certificate) and leaves an unexpired one", async () => {
    const w = await world();
    const old = addEphemeral(w, "old", { expiresAt: iso(t0.getTime() - MIN) });
    const fresh = addEphemeral(w, "fresh", { expiresAt: iso(t0.getTime() + HOUR) });
    const f = fakes(w);

    await expiryPass(f.deps);

    expect(f.teardowns).toHaveLength(1);
    expect(f.teardowns[0]).toMatchObject({
      target: "kubernetes",
      appName: deployAppName(old.env),
      projectId: w.projectId,
      scope: "app",
    });
    // keep: every other cloud row of the project, Production's and the other stage's.
    expect([...f.teardowns[0]!.keep!].sort()).toEqual(
      [`${w.prefix}-cloudrun`, `${w.prefix}-k8s`, deployAppName(fresh.env)].sort(),
    );
    expect(f.events).toContain(`edge.remove ${old.host}`);
    expect(f.events).toContain(`cert.delete ${certSecretName(old.host)}`);
    expect(f.events.join("\n")).not.toContain(fresh.host);
    expect(w.store.getStage(old.stage.id)).toMatchObject({
      kind: "ephemeral",
      removal: "removed",
      removalAttempts: 0,
      removalError: "",
    });
    expect(w.store.getEnvironment(old.env.id).archived).toBe(true);
    expect(
      w.store
        .listDomains(w.projectId)
        .map((d) => d.host)
        .sort(),
    ).toEqual([fresh.host, "shop.example.dev"].sort());
    expect(w.store.getStage(fresh.stage.id)).toMatchObject({ removal: "", host: fresh.host });
    expect(w.store.getEnvironment(fresh.env.id).archived).toBe(false);
    // Production untouched.
    expect(w.store.listEnvironments(w.projectId).map((e) => e.name)).toEqual(["k8s", "cloudrun"]);

    // A second pass has nothing to do.
    const before = f.events.length;
    await expiryPass(f.deps);
    expect(f.events).toHaveLength(before);
  });

  it("an ephemeral stage with no expiry time is never removed by a pass", async () => {
    const w = await world();
    const a = addEphemeral(w, "a");
    w.store.updateStage(a.stage.id, { expiresAt: "" });
    const f = fakes(w);
    f.advance(365 * DAY);
    await expiryPass(f.deps);
    expect(f.teardowns).toHaveLength(0);
    expect(w.store.getStage(a.stage.id).removal).toBe("");
  });

  it("a failing teardown is removal-failed with a scrubbed error, retried after 10 minutes, then 1 h, then 6 h", async () => {
    const w = await world();
    const a = addEphemeral(w, "a", { expiresAt: iso(t0.getTime() - MIN) });
    const f = fakes(w);
    f.teardown.failWith = new Error(
      "Kubernetes: deleting failed: token KUBE-TOKEN-SECRET refused\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    );

    await expiryPass(f.deps);
    const s = w.store.getStage(a.stage.id);
    expect(s).toMatchObject({
      removal: "removal-failed",
      removalAttempts: 1,
      nextAttemptAt: iso(t0.getTime() + 10 * MIN),
    });
    expect(s.removalError).toContain("Kubernetes: deleting failed");
    expect(s.removalError).not.toContain("KUBE-TOKEN-SECRET");
    expect(s.removalError).not.toContain("BEGIN PRIVATE KEY");
    // The route stops at once: the stage no longer has an address of its own.
    expect(w.store.listDomains(w.projectId).filter((d) => d.stageId === a.stage.id)).toEqual([]);
    expect(w.store.getEnvironment(a.env.id).archived).toBe(false);

    f.advance(9 * MIN);
    await expiryPass(f.deps);
    expect(f.teardowns).toHaveLength(1);

    f.advance(MIN);
    await expiryPass(f.deps);
    expect(f.teardowns).toHaveLength(2);
    expect(w.store.getStage(a.stage.id)).toMatchObject({
      removal: "removal-failed",
      removalAttempts: 2,
      nextAttemptAt: iso(t0.getTime() + 10 * MIN + HOUR),
    });

    f.advance(HOUR);
    await expiryPass(f.deps);
    expect(w.store.getStage(a.stage.id)).toMatchObject({
      removalAttempts: 3,
      nextAttemptAt: iso(t0.getTime() + 10 * MIN + HOUR + 6 * HOUR),
    });

    f.advance(6 * HOUR);
    await expiryPass(f.deps);
    expect(w.store.getStage(a.stage.id)).toMatchObject({
      removalAttempts: 4,
      nextAttemptAt: iso(t0.getTime() + 10 * MIN + HOUR + 12 * HOUR),
    });

    f.teardown.failWith = null;
    f.advance(6 * HOUR);
    await expiryPass(f.deps);
    expect(w.store.getStage(a.stage.id)).toMatchObject({ removal: "removed", removalError: "", nextAttemptAt: "" });
    expect(w.store.getEnvironment(a.env.id).archived).toBe(true);
    // Every attempt deletes the certificate Secret again (the host is kept on the row).
    expect(f.events.filter((e) => e === `cert.delete ${certSecretName(a.host)}`).length).toBeGreaterThanOrEqual(2);
  });

  it("queued builds of the stage are skipped; a running one delays the removal to the next pass", async () => {
    const w = await world();
    const a = addEphemeral(w, "a", { expiresAt: iso(t0.getTime() - MIN) });
    const running = w.store.createQueuedBuild(w.projectId, "b".repeat(40), { stageId: a.stage.id });
    w.store.startBuild(running.id);
    const queued = w.store.createQueuedBuild(w.projectId, "d".repeat(40), { stageId: a.stage.id });
    const prod = w.store.createQueuedBuild(w.projectId, "c".repeat(40));
    const f = fakes(w);

    await expiryPass(f.deps);
    expect(w.store.getStage(a.stage.id).removal).toBe("removing");
    expect(w.store.getBuild(queued.id).status).toBe("skipped");
    expect(w.store.getBuild(prod.id).status).toBe("queued");
    expect(f.teardowns).toHaveLength(0);

    w.store.completeBuild(running.id, "succeeded");
    await expiryPass(f.deps);
    expect(w.store.getStage(a.stage.id).removal).toBe("removed");
    expect(f.teardowns).toHaveLength(1);
  });
});

describe("removeStage never touches what isn't the stage's", () => {
  function recorder(answer: (key: string) => string): CommandRunner & { calls: string[] } {
    const calls: string[] = [];
    const fn = (async (cmd: string, args: string[]) => {
      const i = args.indexOf("--kubeconfig");
      const rest = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
      const key = [cmd, ...rest].join(" ");
      calls.push(key);
      return answer(key);
    }) as CommandRunner & { calls: string[] };
    fn.calls = calls;
    return fn;
  }

  it("Cloud Run: removing pv-1a2b3c4d leaves pv-1a2b3c4e, a near-named custom environment and Production", async () => {
    const w = await world();
    const KEY = JSON.stringify({
      type: "service_account",
      client_email: "d@p.iam.gserviceaccount.com",
      private_key: "PRIVKEY",
    });
    w.store.saveGoogleConnection(
      {
        project: "p",
        region: "us-east1",
        arRepo: "r",
        deployer: "d@p.iam.gserviceaccount.com",
        puller: "u@p.iam.gserviceaccount.com",
      },
      { deployerKey: KEY, pullerKey: "{}" },
    );
    const a = addEphemeral(w, "a", { target: "cloudrun", name: "pv-1a2b3c4d" });
    const b = addEphemeral(w, "b", { target: "cloudrun", name: "pv-1a2b3c4e" });
    const near = addCustom(w, "pv-1a2b3c4d-cr-fn-x");
    const app = deployAppName(a.env);
    expect(app).toBe(`${w.prefix}-s-pv-1a2b3c4d-cr`);
    const services = [
      `${w.prefix}-cloudrun`,
      `${w.prefix}-cloudrun-fn-ssr`,
      app,
      `${app}-fn-ssr`,
      deployAppName(b.env),
      `${deployAppName(b.env)}-fn-ssr`,
      deployAppName(near.env),
      `${deployAppName(near.env)}-fn-ssr`,
    ];
    const run = recorder((key) => (key.startsWith("gcloud run services list") ? services.join("\n") : ""));
    const f = fakes(w, { cloudTeardown: createCloudTeardown(run, { mode: "production", store: w.store }) });

    await removeStage(f.deps, a.stage.id, "manual");

    expect(w.store.getStage(a.stage.id).removal).toBe("removed");
    expect(run.calls.filter((c) => c.startsWith("gcloud run services delete"))).toEqual([
      `gcloud run services delete ${app} --project my-proj-1 --region us-east1 --quiet`,
      `gcloud run services delete ${app}-fn-ssr --project my-proj-1 --region us-east1 --quiet`,
    ]);
    expect(w.store.getStage(near.stage.id).host).toBe(near.host);
    expect(w.store.getDomain(near.domain.id).host).toBe(near.host);
    expect(w.store.getEnvironment(near.env.id).archived).toBe(false);
    expect(f.events.filter((e) => e.startsWith("edge.remove") || e.startsWith("cert.delete"))).toEqual([
      `edge.remove ${a.host}`,
      `cert.delete ${certSecretName(a.host)}`,
    ]);
    expect(w.store.getStage(b.stage.id)).toMatchObject({ removal: "", host: b.host });
    expect(
      w.store
        .listDomains(w.projectId)
        .map((d) => d.host)
        .sort(),
    ).toEqual([b.host, near.host, "shop.example.dev"].sort());
    expect(w.store.listEnvironments(w.projectId).map((e) => e.name)).toEqual(["k8s", "cloudrun"]);
  });

  it("a host another stage now holds is neither taken off the edge nor has its certificate deleted", async () => {
    const w = await world();
    const a = addEphemeral(w, "a", { expiresAt: iso(t0.getTime() - MIN) });
    const f = fakes(w);
    f.teardown.failWith = new Error("boom");
    await expiryPass(f.deps);
    expect(w.store.getStage(a.stage.id).removal).toBe("removal-failed");
    // A new stage takes the same address meanwhile.
    const again = w.store.createEphemeralStage(w.projectId, {
      branch: "feature/a2",
      host: a.host,
      expiresAt: iso(t0.getTime() + DAY),
      label: "",
    });
    w.store.addDomain(w.projectId, a.host, "default", "edge", again.id);
    f.events.length = 0;
    f.teardown.failWith = null;
    f.advance(10 * MIN);
    await expiryPass(f.deps);
    expect(w.store.getStage(a.stage.id).removal).toBe("removed");
    expect(f.events).toEqual([`teardown ${deployAppName(a.env)}`]);
    expect(w.store.getStage(again.id)).toMatchObject({ removal: "", host: a.host });
  });
});

describe("previews made before the split become ephemeral stages", () => {
  // A database the earlier NBO wrote: a preview deployment stage with its
  // previews and preview_settings rows (tables core no longer creates).
  const previewTables = `
CREATE TABLE IF NOT EXISTS preview_settings (project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, branches TEXT NOT NULL DEFAULT '[]', without_pull_request INTEGER NOT NULL DEFAULT 1, expire_after_days INTEGER NOT NULL DEFAULT 7, delete_on_close INTEGER NOT NULL DEFAULT 1, max_active INTEGER NOT NULL DEFAULT 10, cloud TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS previews (stage_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch TEXT NOT NULL, host TEXT NOT NULL DEFAULT '', pr_number INTEGER NOT NULL DEFAULT 0, pr_state TEXT NOT NULL DEFAULT '', last_sha TEXT NOT NULL DEFAULT '', last_push_at TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', remove_reason TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL DEFAULT '', removed_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
`;

  function seedPreview(
    db: DatabaseSync,
    w: World,
    opts: {
      stageId: string;
      name: string;
      branch: string;
      host: string;
      stageHost?: string;
      createdAt: string;
      lastPushAt?: string;
      status?: string;
      prNumber?: number;
      attempts?: number;
      nextAttemptAt?: string;
      error?: string;
    },
  ) {
    db.prepare(
      "INSERT INTO stages (id, project_id, name, kind, branch, auto_deploy, host, created_at) VALUES (?, ?, ?, 'preview-deployment', ?, 1, ?, ?)",
    ).run(opts.stageId, w.projectId, opts.name, opts.branch, opts.stageHost ?? opts.host, opts.createdAt);
    db.prepare(
      "INSERT INTO previews (stage_id, project_id, branch, host, pr_number, last_push_at, status, attempts, next_attempt_at, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      opts.stageId,
      w.projectId,
      opts.branch,
      opts.host,
      opts.prNumber ?? 0,
      opts.lastPushAt ?? "",
      opts.status ?? "active",
      opts.attempts ?? 0,
      opts.nextAttemptAt ?? "",
      opts.error ?? "",
      opts.createdAt,
    );
  }

  it("an active preview made 9 days ago with a 7-day expiry migrates to ephemeral, already expired, and the first pass removes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-stage-expiry-mig-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const key = randomBytes(32);
    const path = join(dir, "t.db");
    const first = createStore(path, { secretKey: key });
    const project = first.createProject("shop");
    first.close();

    const db = new DatabaseSync(path);
    db.exec(previewTables);
    const w = { projectId: project.id } as World;
    const created = iso(t0.getTime() - 9 * DAY);
    seedPreview(db, w, {
      stageId: "stg_old1",
      name: "pv-0000aaaa",
      branch: "feature/x",
      host: "feature-x--shop.127.0.0.1.sslip.io",
      createdAt: created,
    });
    db.prepare("INSERT INTO preview_settings (project_id, enabled, expire_after_days) VALUES (?, 1, 7)").run(
      project.id,
    );
    db.prepare(
      "INSERT INTO environments (id, project_id, name, target, config, created_at, stage_id) VALUES ('env_pv', ?, 's-pv-0000aaaa-k8s', 'kubernetes', '{}', ?, 'stg_old1')",
    ).run(project.id, created);
    db.close();

    const store = createStore(path, { secretKey: key });
    cleanups.push(() => store.close());
    const stage = store.getStage("stg_old1");
    expect(stage).toMatchObject({
      kind: "ephemeral",
      removal: "",
      label: "feature/x",
      expiresAt: iso(t0.getTime() - 2 * DAY),
      host: "feature-x--shop.127.0.0.1.sslip.io",
    });
    // The old tables are only read.
    const raw = new DatabaseSync(path);
    expect(raw.prepare("SELECT status FROM previews WHERE stage_id = 'stg_old1'").get()).toEqual({ status: "active" });
    raw.close();

    const teardowns: TeardownTarget[] = [];
    const deps: ExpiryDeps = {
      store,
      edgeSync: { async remove() {}, async push() {} } as unknown as EdgeSync,
      cloudTeardown: {
        async remove(t) {
          teardowns.push(t);
        },
      },
      certs: { async deleteCert() {} },
      mode: "dev",
      now: () => t0,
    };
    await expiryPass(deps);
    expect(store.getStage("stg_old1").removal).toBe("removed");
    expect(teardowns.map((t) => [t.appName, t.scope])).toEqual([
      [deployAppName(store.getEnvironment("env_pv")), "app"],
    ]);
  });

  it("a removal-failed preview keeps its attempts, next attempt and error; its host comes back from the previews row; a pull request becomes the label", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-stage-expiry-mig-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const key = randomBytes(32);
    const path = join(dir, "t.db");
    const first = createStore(path, { secretKey: key });
    const project = first.createProject("shop");
    first.close();

    const db = new DatabaseSync(path);
    db.exec(previewTables);
    const w = { projectId: project.id } as World;
    const next = iso(t0.getTime() + HOUR);
    // Removal already cleared the stage's host; the previews row kept it.
    seedPreview(db, w, {
      stageId: "stg_fail",
      name: "pv-0000bbbb",
      branch: "feature/y",
      host: "feature-y--shop.127.0.0.1.sslip.io",
      stageHost: "",
      createdAt: iso(t0.getTime() - 3 * DAY),
      lastPushAt: iso(t0.getTime() - DAY),
      status: "removal-failed",
      prNumber: 4,
      attempts: 2,
      nextAttemptAt: next,
      error: "kubectl said no",
    });
    seedPreview(db, w, {
      stageId: "stg_gone",
      name: "pv-0000cccc",
      branch: "feature/z",
      host: "feature-z--shop.127.0.0.1.sslip.io",
      stageHost: "",
      createdAt: iso(t0.getTime() - 3 * DAY),
      status: "removed",
    });
    db.close();

    const store = createStore(path, { secretKey: key });
    cleanups.push(() => store.close());
    expect(store.getStage("stg_fail")).toMatchObject({
      kind: "ephemeral",
      removal: "removal-failed",
      removalAttempts: 2,
      nextAttemptAt: next,
      removalError: "kubectl said no",
      label: "pr #4",
      host: "feature-y--shop.127.0.0.1.sslip.io",
      // No preview_settings row: the default 7 days from the last push.
      expiresAt: iso(t0.getTime() - DAY + 7 * DAY),
    });
    expect(store.getStage("stg_gone")).toMatchObject({ kind: "ephemeral", removal: "removed" });
    // Hidden from the default list, as previews were; listed when asked for.
    expect(store.listStages(project.id).map((s) => s.kind)).toEqual(["production", "preview", "development"]);
    expect(store.listStages(project.id, { includeEphemeral: true }).map((s) => s.id)).toEqual(
      expect.arrayContaining(["stg_fail", "stg_gone"]),
    );

    // Opening again changes nothing (the migration ran once).
    store.updateStage("stg_fail", { removal: "removed", removalAttempts: 3 });
    store.close();
    const again = createStore(path, { secretKey: key });
    try {
      expect(again.getStage("stg_fail")).toMatchObject({ removal: "removed", removalAttempts: 3 });
    } finally {
      again.close();
    }
    cleanups.pop();
  });

  it("a fresh database has no preview tables", async () => {
    const w = await world();
    const db = new DatabaseSync(w.dbPath);
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
      ).map((r) => r.name);
      for (const t of ["previews", "preview_settings", "preview_branch_heads"]) expect(tables).not.toContain(t);
      expect(tables).toContain("preview_cert_orders");
    } finally {
      db.close();
    }
  });
});
