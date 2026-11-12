// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cloud Run delivery of user variables with the real adapter-cloudrun
// argument building, Secret Manager and identity logic; only the local
// docker builds are stubbed and every gcloud/docker call goes through
// the fake runner carried by ctx.
vi.mock("@nbo/adapter-k8s", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nbo/adapter-k8s")>()),
  buildImage: vi.fn().mockResolvedValue(undefined),
  buildFunctionImage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../run.js", () => ({ run: vi.fn().mockResolvedValue("") }));

const { serviceIdentityId, secretId } = await import("@nbo/adapter-cloudrun");
const { createCloudRunTarget } = await import("../cloudrun-target.js");
import type { UserEnv } from "../env.js";

type Call = { cmd: string; args: string[]; env?: Record<string, string>; input?: string };

const env = { CLOUDSDK_CONFIG: "/tmp/g", DOCKER_CONFIG: "/tmp/d" };
const id = "sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1";
const app = "pabc-cloudrun";
const appSa = `${serviceIdentityId(app)}@acme.iam.gserviceaccount.com`;
const fnSa = `${serviceIdentityId(`${app}-fn-ssr`)}@acme.iam.gserviceaccount.com`;

function recorder(
  opts: {
    fail?: (args: string[]) => Error | undefined;
    labels?: (service: string) => Record<string, string>;
    containerEnv?: (service: string) => { name: string; value?: string; valueFrom?: unknown }[];
    answer?: (args: string[]) => string | undefined;
  } = {},
) {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], o?: { input?: string; env?: Record<string, string> }) => {
    calls.push({ cmd, args, env: o?.env, input: o?.input });
    const err = opts.fail?.(args);
    if (err) throw err;
    if (args[0] === "run" && args[2] === "describe") {
      const service = args[3]!;
      const labels = opts.labels?.(service) ?? {};
      return JSON.stringify({
        metadata: { labels },
        spec: { template: { spec: { containers: [{ image: "old", env: opts.containerEnv?.(service) ?? [] }] } } },
        status: { url: `https://${service}.run.app`, latestReadyRevisionName: "r", latestCreatedRevisionName: "r", conditions: [{ type: "Ready", status: "True" }] },
      });
    }
    return opts.answer?.(args) ?? "";
  };
  return { calls, run };
}

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cloudrun-env-prod-"));
  await mkdir(join(dir, "functions", "ssr", "bundle"), { recursive: true });
  await writeFile(join(dir, "functions", "ssr", "function.json"), JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));
  return dir;
}

const values = { PLAIN_A: "plain-aaa-value", TOKEN: "s3cret-token-value", KEY2: "s3cret-key2-value" };
const full: UserEnv = { vars: values, secretNames: ["TOKEN", "KEY2"], fingerprint: "f".repeat(32) };

async function deployAll(userEnv: UserEnv | undefined, rec = recorder(), perServiceIdentity = true, pastedKeyDeployer?: string) {
  const dir = await fixture();
  try {
    const target = createCloudRunTarget("acme", "us-central1", "us-central1-docker.pkg.dev/acme/nbo", {
      ctx: { env, run: rec.run, sleep: async () => {} },
      perServiceIdentity,
      ...(pastedKeyDeployer ? { pastedKeyDeployer } : {}),
    });
    if (userEnv) target.userEnv = userEnv;
    await target.deployer.liveContentID(app);
    await target.deployer.deployFunctions!(dir, app, ["ssr"]);
    await target.deployer.buildAndDeploy(dir, app, id);
    return rec.calls;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const deploys = (calls: Call[]) => calls.filter((c) => c.args[0] === "run" && c.args[1] === "deploy");
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("Cloud Run target delivers user variables", () => {
  it("stores each secret once in Secret Manager, values only on stdin, and grants each runtime account per secret", async () => {
    const calls = await deployAll(full);
    const tok = secretId(app, "TOKEN");
    const key2 = secretId(app, "KEY2");

    const creates = calls.filter((c) => c.args[0] === "secrets" && c.args[1] === "create");
    expect(creates.map((c) => c.args[2]).sort()).toEqual([tok, key2].sort());
    for (const c of creates) expect(c.args).toContain("--replication-policy=automatic");
    const adds = calls.filter((c) => c.args[0] === "secrets" && c.args[2] === "add");
    expect(Object.fromEntries(adds.map((c) => [c.args[3], c.input]))).toEqual({ [tok]: values.TOKEN, [key2]: values.KEY2 });

    const grants = calls
      .filter((c) => c.args[0] === "secrets" && c.args[1] === "add-iam-policy-binding")
      .map((c) => `${c.args[2]} ${after(c.args, "--member")} ${after(c.args, "--role")}`);
    expect(grants.sort()).toEqual([tok, key2].flatMap((s) => [appSa, fnSa].map((sa) => `${s} serviceAccount:${sa} roles/secretmanager.secretAccessor`)).sort());

    // Secret Manager work happens before any deploy that mounts it.
    const firstDeploy = calls.findIndex((c) => c.args[0] === "run" && c.args[1] === "deploy");
    const isSetup = (c: Call) => c.args[0] === "secrets" && !(c.args[1] === "versions" && (c.args[2] === "list" || c.args[2] === "destroy"));
    const lastSecretCall = calls.map((c) => isSetup(c)).lastIndexOf(true);
    expect(lastSecretCall).toBeLessThan(firstDeploy);

    const ds = deploys(calls);
    expect(ds.map((d) => d.args[2])).toEqual([`${app}-fn-ssr`, app]);
    const mapping = [`KEY2=${key2}:latest`, `TOKEN=${tok}:latest`].join(",");
    for (const d of ds) {
      expect(after(d.args, "--set-secrets")).toBe(mapping);
      expect(d.args).toContain("--env-vars-file");
    }

    // No value anywhere in an argument list, never read back; every call carries the credential env.
    expect(calls.some((c) => c.args.includes("access"))).toBe(false);
    for (const c of calls) {
      for (const v of Object.values(values)) expect(c.args.join(" ")).not.toContain(v);
      expect(c.env).toEqual(env);
    }
  }, 30000);

  it("plain-only variables touch no Secret Manager and clear any mounted secrets", async () => {
    const calls = await deployAll({ vars: { PLAIN_A: "x" }, secretNames: [], fingerprint: "a".repeat(32) });
    expect(calls.some((c) => c.args[0] === "secrets")).toBe(false);
    for (const d of deploys(calls)) {
      expect(d.args).toContain("--clear-secrets");
      expect(d.args).not.toContain("--set-secrets");
    }
  }, 30000);

  it("a removed secret drops out of the mapping", async () => {
    const calls = await deployAll({ vars: { PLAIN_A: "x", TOKEN: "t0ken-value" }, secretNames: ["TOKEN"], fingerprint: "b".repeat(32) });
    for (const d of deploys(calls)) expect(after(d.args, "--set-secrets")).toBe(`TOKEN=${secretId(app, "TOKEN")}:latest`);
  }, 30000);

  it("an empty set makes exactly the calls a deploy without variables makes", async () => {
    const without = await deployAll(undefined);
    const empty = await deployAll({ vars: {}, secretNames: [], fingerprint: null });
    expect(empty.map((c) => [c.cmd, ...c.args])).toEqual(without.map((c) => [c.cmd, ...c.args]));
    expect(empty.some((c) => c.args[0] === "secrets")).toBe(false);
  }, 30000);

  it("clears the env of services that had variables when the set becomes empty", async () => {
    const rec = recorder({ labels: () => ({ "nbo-content-id": "0".repeat(32), "nbo-env": "c".repeat(32) }) });
    const calls = await deployAll({ vars: {}, secretNames: [], fingerprint: null }, rec);
    const ds = deploys(calls);
    expect(ds).toHaveLength(2);
    for (const d of ds) expect(d.args.slice(-2)).toEqual(["--clear-env-vars", "--clear-secrets"]);
    expect(calls.some((c) => c.args[0] === "secrets")).toBe(false);
  }, 30000);

  it("a disabled API asks to reconnect to enable it; a denied permission depends on how Google was connected", async () => {
    const disabled =
      "ERROR: (gcloud.secrets.create) [d@acme] does not have permission to access projects instance [acme] (or it may not exist): Secret Manager API has not been used in project acme before or it is disabled. reason: SERVICE_DISABLED";
    const denied = "ERROR: (gcloud.secrets.create) PERMISSION_DENIED: Permission 'secretmanager.secrets.create' denied";
    const failWith = (msg: string) => recorder({ fail: (args) => (args[0] === "secrets" && args[1] === "create" ? new Error(msg) : undefined) });
    const cases: [string, string | undefined, string][] = [
      [disabled, undefined, "reconnect Google Cloud (nbo-server connect google) to enable the Secret Manager API"],
      [disabled, "ci@acme.iam.gserviceaccount.com", "reconnect Google Cloud (nbo-server connect google) to enable the Secret Manager API"],
      [denied, undefined, "reconnect Google Cloud (nbo-server connect google) to grant Secret Manager access"],
      [denied, "ci@acme.iam.gserviceaccount.com", "grant roles/secretmanager.admin to ci@acme.iam.gserviceaccount.com"],
    ];
    for (const [msg, pasted, want] of cases) {
      const rec = failWith(msg);
      const err = (await deployAll(full, rec, true, pasted).catch((e: Error) => e)) as Error;
      expect(err.message, `${msg} ${pasted}`).toBe(want);
      expect(deploys(rec.calls)).toHaveLength(0);
    }
  }, 30000);

  it("adds a version only when the secret's value-hash label differs, then labels it", async () => {
    const hashes = { TOKEN: "1".repeat(32), KEY2: "2".repeat(32) };
    const tok = secretId(app, "TOKEN");
    const rec = recorder({
      answer: (args) => (args[0] === "secrets" && args[1] === "describe" ? (args[2] === tok ? `WARNING: x\n${hashes.TOKEN}\n` : "9".repeat(32)) : undefined),
    });
    const calls = await deployAll({ ...full, secretHashes: hashes }, rec);
    const adds = calls.filter((c) => c.args[0] === "secrets" && c.args[2] === "add");
    expect(adds.map((c) => c.args[3])).toEqual([secretId(app, "KEY2")]);
    const updates = calls.filter((c) => c.args[0] === "secrets" && c.args[1] === "update");
    expect(updates.map((c) => c.args)).toEqual([["secrets", "update", secretId(app, "KEY2"), `--update-labels=nbo-value-hash=${hashes.KEY2}`, "--project", "acme"]]);
    expect(calls.indexOf(updates[0]!)).toBeGreaterThan(calls.indexOf(adds[0]!));
    expect(calls.some((c) => c.args.includes("access"))).toBe(false);
  }, 30000);

  it("destroys superseded secret versions after a successful deploy", async () => {
    const rec = recorder({
      answer: (args) => (args[1] === "versions" && args[2] === "list" ? "projects/1/secrets/s/versions/4\nprojects/1/secrets/s/versions/2\n" : undefined),
    });
    const calls = await deployAll(full, rec);
    const lastDeploy = calls.lastIndexOf(deploys(calls).at(-1)!);
    const lists = calls.filter((c) => c.args[1] === "versions" && c.args[2] === "list");
    expect(lists.map((c) => c.args[3]).sort()).toEqual([secretId(app, "KEY2"), secretId(app, "TOKEN")].sort());
    const destroys = calls.filter((c) => c.args[1] === "versions" && c.args[2] === "destroy");
    expect(destroys.map((c) => `${after(c.args, "--secret")} ${c.args[3]}`).sort()).toEqual([`${secretId(app, "KEY2")} 2`, `${secretId(app, "TOKEN")} 2`].sort());
    for (const c of [...lists, ...destroys]) expect(calls.indexOf(c)).toBeGreaterThan(lastDeploy);
  }, 30000);

  it("does not destroy versions when the deploy fails", async () => {
    const rec = recorder({ fail: (args) => (args[0] === "run" && args[1] === "deploy" && args[2] === app ? new Error("deploy failed") : undefined) });
    await deployAll(full, rec).catch(() => {});
    expect(rec.calls.some((c) => c.args[1] === "versions" && (c.args[2] === "list" || c.args[2] === "destroy"))).toBe(false);
  }, 30000);

  it("clears a function's env when the set is empty and its live state cannot be read", async () => {
    // Only the first describe (the live-state read) fails; the one after the deploy works.
    let fnDescribes = 0;
    const rec = recorder({
      fail: (args) => (args[0] === "run" && args[2] === "describe" && args[3] === `${app}-fn-ssr` && fnDescribes++ === 0 ? new Error("ERROR: transient") : undefined),
    });
    const calls = await deployAll({ vars: {}, secretNames: [], fingerprint: null }, rec);
    const fn = deploys(calls).find((d) => d.args[2] === `${app}-fn-ssr`)!;
    expect(fn.args.slice(-2)).toEqual(["--clear-env-vars", "--clear-secrets"]);
  }, 30000);

  it("removes a live secret mount before deploying the same name as a plain value", async () => {
    const rec = recorder({
      containerEnv: () => [
        { name: "TOKEN", valueFrom: { secretKeyRef: { name: secretId(app, "TOKEN"), key: "latest" } } },
        { name: "OTHER", valueFrom: { secretKeyRef: { name: "x", key: "latest" } } },
        { name: "PLAIN_A", value: "old" },
      ],
    });
    const calls = await deployAll({ vars: { PLAIN_A: "a", TOKEN: "now-plain" }, secretNames: [], fingerprint: "d".repeat(32) }, rec);
    const updates = calls.filter((c) => c.args[0] === "run" && c.args[1] === "services" && c.args[2] === "update");
    expect(updates.map((c) => c.args)).toEqual(
      [`${app}-fn-ssr`, app].map((svc) => ["run", "services", "update", svc, "--region", "us-central1", "--project", "acme", "--remove-secrets", "TOKEN", "--quiet"]),
    );
    for (const u of updates) {
      const svc = u.args[3];
      expect(calls.indexOf(u)).toBeLessThan(calls.findIndex((c) => c.args[1] === "deploy" && c.args[2] === svc));
    }
  }, 30000);

  it("no live secret mount of a now-plain name: no update call", async () => {
    const calls = await deployAll({ vars: { PLAIN_A: "a" }, secretNames: [], fingerprint: "d".repeat(32) });
    expect(calls.some((c) => c.args[2] === "update")).toBe(false);
  }, 30000);

  it("redacts secret values from any other failure", async () => {
    const rec = recorder({ fail: (args) => (args[0] === "secrets" && args[2] === "add" ? new Error(`gcloud failed: bad payload ${values.TOKEN}`) : undefined) });
    const err = (await deployAll(full, rec).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain(values.TOKEN);
    expect(err.message).toContain("[redacted]");

    const rec2 = recorder({ fail: (args) => (args[0] === "run" && args[1] === "deploy" ? new Error(`deploy failed near ${values.KEY2}`) : undefined) });
    const err2 = (await deployAll(full, rec2).catch((e: Error) => e)) as Error;
    expect(err2.message).not.toContain(values.KEY2);
    expect(err2.message).toContain("[redacted]");
  }, 30000);

  it("without per-service identities grants the default compute account, once per secret", async () => {
    const rec = recorder();
    const base = rec.run;
    rec.run = async (cmd, args, o) =>
      args[0] === "projects" && args[1] === "describe" ? (await base(cmd, args, o), JSON.stringify({ projectNumber: "123" })) : base(cmd, args, o);
    const calls = await deployAll(full, rec, false);
    const grants = calls.filter((c) => c.args[1] === "add-iam-policy-binding" && c.args[0] === "secrets");
    expect(grants.map((c) => `${c.args[2]} ${after(c.args, "--member")}`).sort()).toEqual(
      [secretId(app, "TOKEN"), secretId(app, "KEY2")].map((s) => `${s} serviceAccount:123-compute@developer.gserviceaccount.com`).sort(),
    );
  }, 30000);
});
