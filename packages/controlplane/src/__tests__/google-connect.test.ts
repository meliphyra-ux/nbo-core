// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CommandRunner } from "@nbo/deploy";
import { createStore, type Store } from "../store.js";
import { createGoogleConnect, deployerRoles } from "../google-connect.js";

const noSleep = async (): Promise<void> => {};
const openStores: Store[] = [];
afterEach(() => {
  for (const s of openStores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
});

async function openStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-gc-"));
  const s = createStore(join(dir, "t.db"), { secretKey: randomBytes(32) });
  openStores.push(s);
  return s;
}

const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabcdef\n-----END PRIVATE KEY-----\n";
function keyJson(email: string, project = "acme"): string {
  return JSON.stringify({ type: "service_account", project_id: project, client_email: email, private_key: PRIVATE_KEY });
}

type Call = { cmd: string; args: string[]; env?: Record<string, string>; timeoutMs?: number };
type Handler = (call: Call) => string | Error | undefined;

function fakeRunner(handler: Handler = () => undefined): { run: CommandRunner; calls: Call[]; lines: () => string[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    const call = { cmd, args, env: opts?.env, timeoutMs: opts?.timeoutMs };
    calls.push(call);
    const custom = handler(call);
    if (custom instanceof Error) throw custom;
    if (custom !== undefined) return custom;
    const line = args.join(" ");
    const m = /keys create - --iam-account (\S+)/.exec(line);
    if (m) return keyJson(m[1]!);
    return "";
  };
  return { run, calls, lines: () => calls.map((c) => `${c.cmd} ${c.args.join(" ")}`) };
}

describe("google connect", () => {
  it("detect parses the machine's gcloud config", async () => {
    const f = fakeRunner((c) => (c.args.join(" ") === "config list --format=json" ? JSON.stringify({ core: { account: "me@x.com", project: "acme" } }) : undefined));
    const g = createGoogleConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    expect(await g.detect()).toEqual({ found: true, account: "me@x.com", project: "acme", reason: null });
    expect(f.calls[0]!.env).toBeUndefined();
  });

  it("detect reports a missing gcloud", async () => {
    const f = fakeRunner(() => Object.assign(new Error("spawn gcloud ENOENT"), { code: "ENOENT" }));
    const g = createGoogleConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    expect(await g.detect()).toEqual({ found: false, account: null, project: null, reason: "gcloud is not installed in the NBO container" });
  });

  it("connectFromMachine runs the steps in order and saves keys", async () => {
    const store = await openStore();
    const f = fakeRunner();
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    const conn = await g.connectFromMachine({ project: "acme", region: "europe-west1" });
    expect(conn.deployer).toBe("nbo-deployer@acme.iam.gserviceaccount.com");
    expect(conn.puller).toBe("nbo-puller@acme.iam.gserviceaccount.com");
    expect(conn.arRepo).toBe("europe-west1-docker.pkg.dev/acme/nbo");
    expect(conn.status).toBe("connected");
    expect(store.getGoogleSecrets().deployerKey).toBe(keyJson("nbo-deployer@acme.iam.gserviceaccount.com"));
    expect(store.getGoogleSecrets().pullerKey).toBe(keyJson("nbo-puller@acme.iam.gserviceaccount.com"));

    const lines = f.lines();
    const idx = (needle: string): number => {
      const i = lines.findIndex((l) => l.includes(needle));
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      idx("services enable run.googleapis.com artifactregistry.googleapis.com iam.googleapis.com secretmanager.googleapis.com"),
      idx("artifacts repositories create nbo"),
      idx("service-accounts create nbo-deployer"),
      idx("service-accounts create nbo-puller"),
      idx("projects add-iam-policy-binding acme"),
      idx(
        "artifacts repositories add-iam-policy-binding nbo --location europe-west1 --member serviceAccount:nbo-puller@acme.iam.gserviceaccount.com --role roles/artifactregistry.reader",
      ),
      idx("keys create - --iam-account nbo-deployer@"),
      idx("keys create - --iam-account nbo-puller@"),
      idx("run services list"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const role of deployerRoles) expect(lines.some((l) => l.includes(`--role ${role}`) && l.includes("projects add-iam"))).toBe(true);
    // Puller is not given project-level roles.
    expect(lines.some((l) => l.includes("projects add-iam") && l.includes("nbo-puller"))).toBe(false);
    // Machine path: own gcloud config, always --project.
    for (const c of f.calls.slice(0, 8)) {
      expect(c.env).toBeUndefined();
      expect(c.args).toContain("--project");
    }
    expect(store.getGoogleConnection()?.lastError).toBe("");
  });

  it("treats 'already exists' on create steps as success", async () => {
    const f = fakeRunner((c) => {
      const l = c.args.join(" ");
      if (l.includes("repositories create") || l.includes("service-accounts create")) return new Error("ERROR: Resource already exists in the project (ALREADY_EXISTS)");
      return undefined;
    });
    const g = createGoogleConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    await expect(g.connectFromMachine({ project: "acme", region: "us-central1" })).resolves.toMatchObject({ project: "acme" });
  });

  it("names the step and permission on PERMISSION_DENIED and saves nothing", async () => {
    const store = await openStore();
    const f = fakeRunner((c) =>
      c.args.join(" ").includes("service-accounts create nbo-deployer")
        ? new Error("ERROR: (gcloud.iam.service-accounts.create) PERMISSION_DENIED: Permission 'iam.serviceAccounts.create' denied on resource")
        : undefined,
    );
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    const err = await g.connectFromMachine({ project: "acme", region: "us-central1" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("iam.serviceAccounts.create");
    expect((err as Error).message).toContain("creating the nbo-deployer service account");
    expect(store.getGoogleConnection()).toBeNull();
  });

  it("names the failing step for non-permission errors and saves nothing", async () => {
    const store = await openStore();
    const f = fakeRunner((c) => (c.args.join(" ").includes("keys create - --iam-account nbo-puller") ? new Error("boom: quota exceeded") : undefined));
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    const err = (await g.connectFromMachine({ project: "acme", region: "us-central1" }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("creating a key for the nbo-puller service account");
    expect(err.message).toContain("quota exceeded");
    expect(store.getGoogleConnection()).toBeNull();
  });

  it("connectWithKey uses the pasted account as the deployer", async () => {
    const store = await openStore();
    const pasted = keyJson("ci@acme.iam.gserviceaccount.com", "acme");
    const f = fakeRunner();
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    const conn = await g.connectWithKey({ keyJson: pasted, region: "us-central1" });
    expect(conn).toMatchObject({ project: "acme", deployer: "ci@acme.iam.gserviceaccount.com", puller: "nbo-puller@acme.iam.gserviceaccount.com" });
    expect(store.getGoogleSecrets().deployerKey).toBe(pasted);
    const lines = f.lines();
    expect(lines.some((l) => l.includes("service-accounts create nbo-deployer"))).toBe(false);
    expect(lines.some((l) => l.includes("service-accounts create nbo-puller"))).toBe(true);
    expect(lines.some((l) => l.includes("keys create - --iam-account nbo-puller@"))).toBe(true);
    // Runs under a private CLOUDSDK_CONFIG.
    const create = f.calls.find((c) => c.args.join(" ").includes("service-accounts create nbo-puller"))!;
    expect(create.env?.CLOUDSDK_CONFIG).toBeTruthy();
  });

  it("connectWithKey rejects a key that is not a service-account key", async () => {
    const g = createGoogleConnect({ store: await openStore(), run: fakeRunner().run, sleep: noSleep });
    await expect(g.connectWithKey({ keyJson: "{}", region: "us-central1" })).rejects.toThrow(/service-account key/);
    await expect(g.connectWithKey({ keyJson: "not json", region: "us-central1" })).rejects.toThrow(/service-account key/);
  });

  it("plan describes what connect creates", async () => {
    const g = createGoogleConnect({ store: await openStore(), run: fakeRunner().run, sleep: noSleep });
    const text = g.plan({ source: "machine", project: "acme", region: "europe-west1" }).join("\n");
    expect(text).toContain("Enable 4 APIs in acme: Cloud Run, Artifact Registry, IAM and Secret Manager.");
    expect(text).toContain("nbo");
    expect(text).toContain("europe-west1");
    expect(text).toMatch(/two service accounts/i);
  });

  it("redacts the private key in errors, including the JSON-escaped form", async () => {
    const escaped = JSON.stringify(PRIVATE_KEY).slice(1, -1);
    for (const leak of [PRIVATE_KEY, escaped]) {
      const store = await openStore();
      const f = fakeRunner((c) => (c.args.join(" ").includes("keys create - --iam-account nbo-puller") ? new Error(`weird failure ${leak} end`) : undefined));
      const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
      const err = (await g.connectFromMachine({ project: "acme", region: "us-central1" }).catch((e: Error) => e)) as Error;
      expect(err.message).not.toContain("MIIEvQIBADANBg");
      expect(err.message).toContain("[redacted]");
    }
  });

  it("redacts the pasted key when a connectWithKey step fails", async () => {
    const pasted = keyJson("ci@acme.iam.gserviceaccount.com");
    const f = fakeRunner((c) => (c.args.join(" ").includes("service-accounts create nbo-puller") ? new Error(`bad ${JSON.stringify(PRIVATE_KEY).slice(1, -1)}`) : undefined));
    const g = createGoogleConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    const err = (await g.connectWithKey({ keyJson: pasted, region: "us-central1" }).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain("MIIEvQIBADANBg");
  });

  it("test records success and failure", async () => {
    const store = await openStore();
    let fail = false;
    const f = fakeRunner((c) =>
      fail && c.args.join(" ").startsWith("run services list") ? new Error("ERROR: PERMISSION_DENIED: Permission 'run.services.list' denied") : undefined,
    );
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    await g.connectFromMachine({ project: "acme", region: "us-central1" });
    await g.test();
    expect(store.getGoogleConnection()).toMatchObject({ status: "connected", lastError: "" });
    expect(store.getGoogleConnection()!.lastChecked).not.toBe("");
    fail = true;
    await expect(g.test()).rejects.toThrow(/run\.services\.list/);
    const c = store.getGoogleConnection()!;
    expect(c.status).toBe("failing");
    expect(c.lastError).toContain("run.services.list");
  });

  it("key-path plan lists only what that path creates", async () => {
    const g = createGoogleConnect({ store: await openStore(), run: fakeRunner().run, sleep: noSleep });
    const text = g.plan({ source: "key", project: "acme", region: "europe-west1" }).join("\n");
    expect(text).toContain("nbo-puller@acme.iam.gserviceaccount.com");
    expect(text).not.toContain("nbo-deployer");
    expect(text).not.toMatch(/project roles/i);
    expect(text).toContain("Enable 4 APIs in acme: Cloud Run, Artifact Registry, IAM and Secret Manager.");
    expect(text).toContain("europe-west1");
  });

  it("connectWithKey does not bind project roles to the pasted account", async () => {
    const f = fakeRunner();
    const g = createGoogleConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    await g.connectWithKey({ keyJson: keyJson("ci@acme.iam.gserviceaccount.com"), region: "us-central1" });
    const lines = f.lines();
    expect(lines.some((l) => l.includes("projects add-iam-policy-binding"))).toBe(false);
    expect(lines.some((l) => l.includes("services enable"))).toBe(true);
    expect(lines.some((l) => l.includes("repositories create nbo"))).toBe(true);
    expect(lines.some((l) => l.includes("repositories add-iam-policy-binding nbo") && l.includes("nbo-puller"))).toBe(true);
  });

  it("extracts key JSON from output that includes gcloud stderr lines", async () => {
    const store = await openStore();
    const f = fakeRunner((c) => {
      const m = /keys create - --iam-account (\S+)/.exec(c.args.join(" "));
      if (!m) return undefined;
      return `created key [abc123] of type [json] as [-] for [${m[1]}]\n${keyJson(m[1]!)}\nsome trailing note\n`;
    });
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    await g.connectFromMachine({ project: "acme", region: "us-central1" });
    const stored = store.getGoogleSecrets();
    expect(() => JSON.parse(stored.deployerKey)).not.toThrow();
    expect(stored.deployerKey).toBe(keyJson("nbo-deployer@acme.iam.gserviceaccount.com"));
    expect(stored.pullerKey).toBe(keyJson("nbo-puller@acme.iam.gserviceaccount.com"));
  });

  it("rejects a key with the wrong account and saves nothing", async () => {
    const store = await openStore();
    const f = fakeRunner((c) => (c.args.join(" ").includes("keys create - --iam-account nbo-deployer") ? keyJson("someone-else@acme.iam.gserviceaccount.com") : undefined));
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    const err = (await g.connectFromMachine({ project: "acme", region: "us-central1" }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("unexpected key format");
    expect(err.message).not.toContain("MIIEvQIBADANBg");
    expect(store.getGoogleConnection()).toBeNull();
  });

  it("detect tolerates stderr noise around the config JSON", async () => {
    const f = fakeRunner((c) =>
      c.args.join(" ") === "config list --format=json"
        ? `Your active configuration is: [default]\n${JSON.stringify({ core: { account: "me@x.com", project: "acme" } })}\n`
        : undefined,
    );
    const g = createGoogleConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    expect(await g.detect()).toMatchObject({ found: true, account: "me@x.com", project: "acme" });
  });

  it("retries role binding while a new service account propagates", async () => {
    let fails = 0;
    const sleeps: number[] = [];
    const f = fakeRunner((c) => {
      if (c.args.join(" ").includes("projects add-iam-policy-binding") && fails < 2) {
        fails++;
        return new Error("ERROR: Service account nbo-deployer@acme.iam.gserviceaccount.com does not exist.");
      }
      return undefined;
    });
    const g = createGoogleConnect({ store: await openStore(), run: f.run, sleep: async (ms) => void sleeps.push(ms) });
    await expect(g.connectFromMachine({ project: "acme", region: "us-central1" })).resolves.toMatchObject({ status: "connected" });
    expect(fails).toBe(2);
    expect(sleeps.slice(0, 2)).toEqual([2000, 4000]);
  });

  it("gives up on binding retries with a step-named error", async () => {
    const store = await openStore();
    const f = fakeRunner((c) => (c.args.join(" ").includes("projects add-iam-policy-binding") ? new Error("Service account x does not exist.") : undefined));
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    await expect(g.connectFromMachine({ project: "acme", region: "us-central1" })).rejects.toThrow(/granting roles\/run\.admin/);
    expect(store.getGoogleConnection()).toBeNull();
  });

  it("retries the post-save test through credential propagation", async () => {
    let n = 0;
    const f = fakeRunner((c) => {
      if (c.args.join(" ").startsWith("run services list") && n++ === 0) return new Error("ERROR: invalid_grant: Invalid JWT Signature.");
      return undefined;
    });
    const g = createGoogleConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    await expect(g.connectFromMachine({ project: "acme", region: "us-central1" })).resolves.toMatchObject({ status: "connected", lastError: "" });
    expect(n).toBeGreaterThan(1);
  });

  it("resolves with a failing connection when the post-save test keeps failing", async () => {
    const store = await openStore();
    const sleeps: number[] = [];
    const escaped = JSON.stringify(PRIVATE_KEY).slice(1, -1);
    const f = fakeRunner((c) => (c.args.join(" ").startsWith("run services list") ? new Error(`ERROR: invalid_grant PERMISSION_DENIED ${escaped}`) : undefined));
    const g = createGoogleConnect({ store, run: f.run, sleep: async (ms) => void sleeps.push(ms) });
    const conn = await g.connectFromMachine({ project: "acme", region: "us-central1" });
    expect(conn.status).toBe("failing");
    expect(conn.lastError).not.toContain("MIIEvQIBADANBg");
    expect(store.getGoogleConnection()?.status).toBe("failing");
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(90_000);
    expect(sleeps.length).toBeGreaterThan(0);
  });
});

describe("deployerRoles", () => {
  it("lets the deployer manage Secret Manager secrets for secret variables", () => {
    expect(deployerRoles).toContain("roles/secretmanager.admin");
  });

  it("lets the deployer create repositories in other regions (artifactregistry.admin, not writer)", () => {
    expect(deployerRoles).toContain("roles/artifactregistry.admin");
    expect(deployerRoles).not.toContain("roles/artifactregistry.writer");
  });

  it("does not let the deployer mint service-account keys", async () => {
    expect(deployerRoles).not.toContain("roles/iam.serviceAccountKeyAdmin");
    const g = createGoogleConnect({ store: await openStore(), run: fakeRunner().run, sleep: noSleep });
    expect(g.plan({ source: "machine", project: "acme", region: "us-central1" }).join("\n")).toContain("Grant the deployer 6 project roles");
  });
});

describe("google connect: partial failures and timeouts", () => {
  it("says a failed connect may have created resources and is safe to re-run", async () => {
    const f = fakeRunner((c) => (c.args.join(" ").includes("service-accounts create nbo-puller") ? new Error("boom") : undefined));
    const g = createGoogleConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    await expect(g.connectFromMachine({ project: "acme", region: "us-central1" })).rejects.toThrow(
      /nbo-puller service account: boom Steps before this one may have created resources; running Connect again is safe and reuses them\.$/,
    );
    const k = createGoogleConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    await expect(k.connectWithKey({ keyJson: keyJson("ci@acme.iam.gserviceaccount.com"), region: "us-central1" })).rejects.toThrow(
      /running Connect again is safe and reuses them\.$/,
    );
  });

  it("runs provisioning commands with the long connect timeout", async () => {
    const f = fakeRunner();
    const g = createGoogleConnect({ store: await openStore(), run: f.run, sleep: noSleep });
    await g.connectFromMachine({ project: "acme", region: "us-central1" });
    const provisioning = f.calls.filter((c) => c.env === undefined);
    expect(provisioning.length).toBeGreaterThan(5);
    for (const c of provisioning) expect(c.timeoutMs, c.args.join(" ")).toBe(5 * 60_000);
  });
});

describe("google connect: service-account keys do not pile up", () => {
  // Keys like gcloud prints them, with a private_key_id per key.
  function keyWithId(email: string, id: string): string {
    return JSON.stringify({ type: "service_account", project_id: "acme", private_key_id: id, client_email: email, private_key: PRIVATE_KEY });
  }
  function idRunner(extra: Handler = () => undefined) {
    let n = 0;
    return fakeRunner((c) => {
      const custom = extra(c);
      if (custom !== undefined) return custom;
      const m = /keys create - --iam-account (\S+)/.exec(c.args.join(" "));
      return m ? keyWithId(m[1]!, `key${++n}`) : undefined;
    });
  }
  const deletes = (lines: string[]) => lines.filter((l) => l.includes("keys delete"));
  const D = "nbo-deployer@acme.iam.gserviceaccount.com";
  const P = "nbo-puller@acme.iam.gserviceaccount.com";

  it("reconnecting from the machine deletes the old deployer key but keeps the puller key that clusters use", async () => {
    const store = await openStore();
    const f = idRunner();
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    await g.connectFromMachine({ project: "acme", region: "us-central1" });
    expect(deletes(f.lines())).toEqual([]);
    await g.connectFromMachine({ project: "acme", region: "us-central1" });
    expect(JSON.parse(store.getGoogleSecrets().deployerKey).private_key_id).toBe("key3");
    const del = f.calls.filter((c) => c.args.join(" ").includes("keys delete"));
    expect(del.map((c) => c.args.join(" "))).toEqual([`iam service-accounts keys delete key1 --iam-account ${D} --quiet --project acme`]);
    for (const c of del) expect(c.env).toBeUndefined();
  });

  it("ignores a key that is already gone", async () => {
    const store = await openStore();
    const f = idRunner((c) => (c.args.includes("delete") ? new Error("ERROR: NOT_FOUND: Service account key key1 does not exist") : undefined));
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    await g.connectFromMachine({ project: "acme", region: "us-central1" });
    await expect(g.connectFromMachine({ project: "acme", region: "us-central1" })).resolves.toMatchObject({ status: "connected" });
  });

  it("deletes the just-created deployer key when the puller key fails", async () => {
    const store = await openStore();
    const f = idRunner((c) => (c.args.join(" ").includes(`keys create - --iam-account ${P}`) ? new Error("quota exceeded") : undefined));
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    await expect(g.connectFromMachine({ project: "acme", region: "us-central1" })).rejects.toThrow(/quota exceeded/);
    expect(deletes(f.lines())).toEqual([`gcloud iam service-accounts keys delete key1 --iam-account ${D} --quiet --project acme`]);
    expect(store.getGoogleConnection()).toBeNull();
  });

  it("deletes both new keys when saving the connection fails", async () => {
    const store = await openStore();
    store.saveGoogleConnection = () => {
      throw new Error("disk full");
    };
    const f = idRunner();
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    await expect(g.connectFromMachine({ project: "acme", region: "us-central1" })).rejects.toThrow(/could not save the connection: disk full/);
    expect(deletes(f.lines())).toEqual([
      `gcloud iam service-accounts keys delete key1 --iam-account ${D} --quiet --project acme`,
      `gcloud iam service-accounts keys delete key2 --iam-account ${P} --quiet --project acme`,
    ]);
  });

  it("the key path never deletes the old puller key nor the pasted key", async () => {
    const store = await openStore();
    const f = idRunner();
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    const pasted = keyWithId("ci@acme.iam.gserviceaccount.com", "pasted1");
    await g.connectWithKey({ keyJson: pasted, region: "us-central1" });
    await g.connectWithKey({ keyJson: pasted, region: "us-central1" });
    expect(deletes(f.lines())).toEqual([]);
    expect(JSON.parse(store.getGoogleSecrets().pullerKey).private_key_id).toBe("key2");
  });

  it("never deletes a pasted nbo-deployer key on a later reconnect", async () => {
    const store = await openStore();
    const f = idRunner();
    const g = createGoogleConnect({ store, run: f.run, sleep: noSleep });
    const pasted = keyWithId(D, "pasted-deployer");
    await g.connectWithKey({ keyJson: pasted, region: "us-central1" });
    await g.connectFromMachine({ project: "acme", region: "us-central1" });
    await g.connectWithKey({ keyJson: pasted, region: "us-central1" });
    expect(deletes(f.lines()).filter((l) => l.includes("pasted-deployer"))).toEqual([]);
  });
});
