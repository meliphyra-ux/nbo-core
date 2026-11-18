// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, afterEach } from "vitest";
import { createTestMux } from "../../__tests__/test-mux.js";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const targetCalls: unknown[][] = [];
const targetObjs: { userEnv?: { secretHashes?: Record<string, string> } }[] = [];
let deployImpl: () => Promise<unknown> = async () => ({
  contentID: "sha256:" + "c".repeat(64),
  alreadyLive: false,
  url: "http://x",
  plan: "",
});
vi.mock("@nbo/deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nbo/deploy")>()),
  createCloudRunTarget: vi.fn((...args: unknown[]) => {
    targetCalls.push(args);
    const t = {
      deployer: { liveContentID: async () => ({ id: "", ok: false }), buildAndDeploy: async () => {} },
      extraEnv: {},
      appURL: "https://app.run.app",
    };
    targetObjs.push(t);
    return t;
  }),
  deploy: vi.fn(async () => deployImpl()),
}));

const { createStore } = await import("../../store/store.js");
const { triggerDeploy } = await import("../deploy.js");
const { createCloudTeardown } = await import("../../clouds/cloud-teardown.js");
const { serviceIdentityId } = await import("@nbo/deploy");
import type { Store } from "../../store/store.js";
import type { CommandRunner } from "@nbo/deploy";
import { saveWifConnection } from "../../clouds/__tests__/google-wif-fixture.js";

type Call = { cmd: string; args: string[]; env?: Record<string, string> };

function recorder(
  fail?: (cmd: string, args: string[]) => Error | undefined,
  answer?: (cmd: string, args: string[]) => string,
): CommandRunner & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (cmd: string, args: string[], opts?: { input?: string; env?: Record<string, string> }) => {
    calls.push({ cmd, args, env: opts?.env });
    const err = fail?.(cmd, args);
    if (err) throw err;
    return answer?.(cmd, args) ?? "";
  }) as CommandRunner & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const deployerKey = JSON.stringify({
  type: "service_account",
  private_key: "-----BEGIN PRIVATE KEY-----\nDEPLOYERPRIVATE\n-----END PRIVATE KEY-----\n",
});
const pullerKey = JSON.stringify({ type: "service_account", private_key: "PULLERPRIVATE" });
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  targetCalls.length = 0;
  targetObjs.length = 0;
  deployImpl = async () => ({ contentID: "sha256:" + "c".repeat(64), alreadyLive: false, url: "http://x", plan: "" });
});

async function openStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-deploy-prod-cr-"));
  const s = createStore(join(dir, "test.db"));
  s.setSecretKey(randomBytes(32));
  s.saveGoogleConnection(
    {
      project: "acme",
      region: "europe-west1",
      arRepo: "europe-west1-docker.pkg.dev/acme/nbo",
      deployer: "d@acme.iam.gserviceaccount.com",
      puller: "p@acme.iam.gserviceaccount.com",
    },
    { deployerKey, pullerKey },
  );
  stores.push(s);
  return s;
}
async function nboDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-deploy-prod-cr-nbo-"));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));
  return dir;
}
function cloudRunEnv(s: Store, region: string) {
  const p = s.createProject("shop");
  return s.createEnvironment(
    p.id,
    "cloudrun",
    "cloudrun",
    JSON.stringify({ project: "acme", region, arRepo: `${region}-docker.pkg.dev/acme/nbo` }),
  );
}

describe("triggerDeploy in production (Cloud Run)", () => {
  it("deploys with the deployer key's private credentials and per-service identities, then removes them", async () => {
    const s = await openStore();
    const env = cloudRunEnv(s, "europe-west1");
    const run = recorder();
    let keyFile = "";
    deployImpl = async () => {
      keyFile = run.calls[0]!.args[3]!;
      return { contentID: "sha256:" + "c".repeat(64), alreadyLive: false, url: "http://x", plan: "" };
    };
    const dep = await triggerDeploy({ store: s, mode: "production", run }, env.id, await nboDir());
    expect(dep.status).toBe("succeeded");
    expect(dep.url).toBe("https://app.run.app");
    expect(run.calls[0]!.args.slice(0, 2)).toEqual(["auth", "activate-service-account"]);
    expect(run.calls[1]!.args).toEqual(["auth", "configure-docker", "europe-west1-docker.pkg.dev", "--quiet"]);
    // Connection region: no repository creation.
    expect(run.calls.some((c) => c.args.includes("repositories"))).toBe(false);
    const [project, region, repo, opts] = targetCalls[0] as [
      string,
      string,
      string,
      { ctx: { env: Record<string, string>; run: unknown }; perServiceIdentity: boolean },
    ];
    expect([project, region, repo]).toEqual(["acme", "europe-west1", "europe-west1-docker.pkg.dev/acme/nbo"]);
    expect(opts.perServiceIdentity).toBe(true);
    expect(opts.ctx.env.CLOUDSDK_CONFIG).toBe(run.calls[0]!.env!.CLOUDSDK_CONFIG);
    expect(opts.ctx.run).toBe(run);
    expect(existsSync(keyFile)).toBe(false);
  });

  it("describes the repository first and creates it only when it is not found", async () => {
    const s = await openStore();
    const env = cloudRunEnv(s, "us-central1");
    const run = recorder((_cmd, args) =>
      args.includes("describe") && args.includes("repositories")
        ? new Error("NOT_FOUND: Requested entity was not found.")
        : undefined,
    );
    const dep = await triggerDeploy({ store: s, mode: "production", run }, env.id, await nboDir());
    expect(dep.status).toBe("succeeded");
    const repoCalls = run.calls.filter((c) => c.args.includes("repositories"));
    expect(repoCalls[0]!.args).toEqual([
      "artifacts",
      "repositories",
      "describe",
      "nbo",
      "--location",
      "us-central1",
      "--project",
      "acme",
    ]);
    expect(repoCalls[1]!.args).toEqual([
      "artifacts",
      "repositories",
      "create",
      "nbo",
      "--repository-format",
      "docker",
      "--location",
      "us-central1",
      "--project",
      "acme",
    ]);
    expect(repoCalls[1]!.env!.CLOUDSDK_CONFIG).toBeTruthy();
  });

  it("does not create the repository when describe finds it", async () => {
    const s = await openStore();
    const env = cloudRunEnv(s, "us-central1");
    const run = recorder();
    await triggerDeploy({ store: s, mode: "production", run }, env.id, await nboDir());
    const repoCalls = run.calls.filter((c) => c.args.includes("repositories"));
    expect(repoCalls.map((c) => c.args[2])).toEqual(["describe"]);
  });

  it("surfaces a redacted error when creating the repository is denied", async () => {
    const s = await openStore();
    const env = cloudRunEnv(s, "us-central1");
    const run = recorder((_cmd, args) => {
      if (!args.includes("repositories")) return undefined;
      return args.includes("describe") ? new Error("NOT_FOUND") : new Error(`PERMISSION_DENIED ${deployerKey}`);
    });
    const dep = await triggerDeploy({ store: s, mode: "production", run }, env.id, await nboDir());
    expect(dep.status).toBe("failed");
    expect(dep.error).toContain("PERMISSION_DENIED");
    expect(dep.error).not.toContain("DEPLOYERPRIVATE");
  });

  it("refuses an environment pointing at a different Google project, before creating a deployment", async () => {
    const s = await openStore();
    const p = s.createProject("other");
    const env = s.createEnvironment(
      p.id,
      "cloudrun",
      "cloudrun",
      JSON.stringify({
        project: "elsewhere",
        region: "us-central1",
        arRepo: "us-central1-docker.pkg.dev/elsewhere/nbo",
      }),
    );
    await expect(
      triggerDeploy({ store: s, mode: "production", run: recorder() }, env.id, await nboDir()),
    ).rejects.toThrow(/Google project elsewhere but NBO is connected to acme/);
    expect(s.listDeployments(env.id)).toHaveLength(0);
  });

  it("refuses without a Google connection, before creating a deployment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-deploy-prod-cr-none-"));
    const s = createStore(join(dir, "t.db"));
    s.setSecretKey(randomBytes(32));
    stores.push(s);
    const env = cloudRunEnv(s, "us-central1");
    await expect(
      triggerDeploy({ store: s, mode: "production", run: recorder() }, env.id, await nboDir()),
    ).rejects.toThrow(/Google Cloud/);
    expect(s.listDeployments(env.id)).toHaveLength(0);
  });

  it("records a failure with the key, its private key and their escaped forms redacted", async () => {
    const s = await openStore();
    const env = cloudRunEnv(s, "europe-west1");
    const privateKey = (JSON.parse(deployerKey) as { private_key: string }).private_key;
    deployImpl = async () => {
      throw new Error(`boom ${deployerKey} ${privateKey} ${JSON.stringify(privateKey).slice(1, -1)} ${pullerKey}`);
    };
    const dep = await triggerDeploy({ store: s, mode: "production", run: recorder() }, env.id, await nboDir());
    expect(dep.status).toBe("failed");
    expect(dep.error).toContain("boom");
    expect(dep.error).not.toContain("DEPLOYERPRIVATE");
    expect(dep.error).not.toContain("PULLERPRIVATE");
  });

  it("hands the target keyed hashes of the secret values and, for a pasted-key connection, the deployer", async () => {
    const s = await openStore();
    const env = cloudRunEnv(s, "europe-west1");
    s.setEnv({ projectId: env.projectId }, "TOKEN", "tok-value", true);
    s.setEnv({ projectId: env.projectId }, "PLAIN", "p", false);
    const resolved = s.resolveEnv(env.projectId);
    await triggerDeploy({ store: s, mode: "production", run: recorder() }, env.id, await nboDir(), {
      env: resolved,
      fingerprint: s.envFingerprintFor(resolved),
    });
    expect(targetObjs[0]!.userEnv!.secretHashes).toEqual(s.envSecretHashes(resolved));
    expect(Object.keys(targetObjs[0]!.userEnv!.secretHashes!)).toEqual(["TOKEN"]);
    // The stored connection's deployer (d@acme) is not NBO's own nbo-deployer: a pasted key.
    expect((targetCalls[0]![3] as { pastedKeyDeployer?: string }).pastedKeyDeployer).toBe(
      "d@acme.iam.gserviceaccount.com",
    );
  });

  it("a machine-path connection (nbo-deployer) passes no pasted-key deployer; no secrets, no hashes", async () => {
    const s = await openStore();
    s.saveGoogleConnection(
      {
        project: "acme",
        region: "europe-west1",
        arRepo: "europe-west1-docker.pkg.dev/acme/nbo",
        deployer: "nbo-deployer@acme.iam.gserviceaccount.com",
        puller: "p@acme.iam.gserviceaccount.com",
      },
      { deployerKey, pullerKey },
    );
    const env = cloudRunEnv(s, "europe-west1");
    await triggerDeploy({ store: s, mode: "production", run: recorder() }, env.id, await nboDir());
    expect("pastedKeyDeployer" in (targetCalls[0]![3] as object)).toBe(false);
    expect("secretHashes" in targetObjs[0]!.userEnv!).toBe(false);
  });

  it("dev mode builds the target exactly as before", async () => {
    const s = await openStore();
    const env = cloudRunEnv(s, "us-central1");
    const run = recorder();
    await triggerDeploy({ store: s, run }, env.id, await nboDir());
    expect(targetCalls[0]!.slice(0, 3)).toEqual(["acme", "us-central1", "us-central1-docker.pkg.dev/acme/nbo"]);
    expect(targetCalls[0]![3]).toBeUndefined();
    expect(run.calls).toHaveLength(0);
  });
});

describe("triggerDeploy progress (Cloud Run)", () => {
  it("threads onProgress into deploy() and the target, redacting secrets", async () => {
    const s = await openStore();
    const env = cloudRunEnv(s, "europe-west1");
    const msgs: string[] = [];
    await triggerDeploy({ store: s, mode: "production", run: recorder() }, env.id, await nboDir(), {
      progress: (m) => msgs.push(m),
    });
    const { deploy } = await import("@nbo/deploy");
    const viaDeploy = vi.mocked(deploy).mock.calls.at(-1)![3] as { onProgress: (m: string) => void };
    viaDeploy.onProgress("validated in 0.1s");
    const viaTarget = targetCalls[0]![4] as { onProgress: (m: string) => void };
    viaTarget.onProgress("app: image pushed in 2.0s");
    viaTarget.onProgress("leak " + pullerKey);
    expect(msgs[0]).toBe("validated in 0.1s");
    expect(msgs[1]).toBe("app: image pushed in 2.0s");
    expect(msgs[2]).not.toContain("PULLERPRIVATE");
  });

  it("passes no progress when none is asked for", async () => {
    const s = await openStore();
    const env = cloudRunEnv(s, "europe-west1");
    await triggerDeploy({ store: s, mode: "production", run: recorder() }, env.id, await nboDir());
    expect(targetCalls[0]![4]).toBeUndefined();
  });
});

describe("cloud teardown in production (Cloud Run)", () => {
  const config = { project: "acme", region: "us-central1" };

  it("deletes the services and their service accounts under the deployer key, ignoring missing accounts", async () => {
    const s = await openStore();
    const run = recorder(
      (_c, args) =>
        args[1] === "service-accounts" &&
        args[0] === "iam" &&
        args.includes(`${serviceIdentityId("pabc-cloudrun-fn-ssr")}@acme.iam.gserviceaccount.com`)
          ? new Error("NOT_FOUND: Unknown service account")
          : undefined,
      (_c, args) => (args[2] === "list" ? "WARNING: x\npabc-cloudrun\npabc-cloudrun-fn-ssr\npother\n" : ""),
    );
    await createCloudTeardown(run, { mode: "production", store: s }).remove({
      target: "cloudrun",
      appName: "pabc-cloudrun",
      projectId: "proj_abc",
      config,
    });
    const lines = run.calls.slice(2).map((c) => [c.cmd, ...c.args].join(" "));
    expect(lines).toEqual([
      "gcloud run services list --project acme --region us-central1 --format=value(metadata.name)",
      "gcloud run services delete pabc-cloudrun --project acme --region us-central1 --quiet",
      `gcloud iam service-accounts delete ${serviceIdentityId("pabc-cloudrun")}@acme.iam.gserviceaccount.com --project acme --quiet`,
      "gcloud run services delete pabc-cloudrun-fn-ssr --project acme --region us-central1 --quiet",
      `gcloud iam service-accounts delete ${serviceIdentityId("pabc-cloudrun-fn-ssr")}@acme.iam.gserviceaccount.com --project acme --quiet`,
      "gcloud secrets list --filter=name~nbo-pabc-cloudrun- --format=value(name) --project acme",
    ]);
    for (const c of run.calls.slice(2)) expect(c.env!.CLOUDSDK_CONFIG).toBeTruthy();
  });

  it("redacts the key from a failed delete", async () => {
    const s = await openStore();
    const run = recorder((_c, args) =>
      args[0] === "run" && args[2] === "list" ? new Error(`denied ${deployerKey}`) : undefined,
    );
    const err = await createCloudTeardown(run, { mode: "production", store: s })
      .remove({ target: "cloudrun", appName: "pabc-cloudrun", projectId: "proj_abc", config })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain("denied");
    expect((err as Error).message).not.toContain("DEPLOYERPRIVATE");
  });
});

describe("legacy deploy route resolves the project's variables", () => {
  it("POST /environments/{id}/deployments hands the target the resolved userEnv (vars, secret names, fingerprint, hashes)", async () => {
    const s = await openStore();
    const env = cloudRunEnv(s, "us-central1");
    s.setEnv({ projectId: env.projectId }, "TOKEN", "tok-value", true);
    s.setEnv({ projectId: env.projectId }, "PLAIN", "p", false);
    const o = { store: s, run: recorder() };
    const mux = createTestMux(s, { triggerDeploy: (id, dir, opts) => triggerDeploy(o, id, dir, opts) });
    const res = await mux(
      new Request(`http://x/environments/${env.id}/deployments`, {
        method: "POST",
        body: JSON.stringify({ nboDir: await nboDir() }),
      }),
    );
    expect(res.status).toBe(201);
    const resolved = s.resolveEnv(env.projectId);
    const userEnv = targetObjs[0]!.userEnv as {
      vars: Record<string, string>;
      secretNames: string[];
      fingerprint: string | null;
      secretHashes?: Record<string, string>;
    };
    expect(userEnv.vars).toEqual({ TOKEN: "tok-value", PLAIN: "p" });
    expect(userEnv.secretNames).toEqual(["TOKEN"]);
    expect(userEnv.fingerprint).not.toBeNull();
    expect(userEnv.fingerprint).toBe(s.envFingerprintFor(resolved));
    expect(userEnv.secretHashes).toEqual(s.envSecretHashes(resolved));
  });
});

describe("recorded deploy errors redact the snapshot's secret values", () => {
  it("a failed deploy never records a secret variable's value", async () => {
    const s = await openStore();
    const env = cloudRunEnv(s, "us-central1");
    s.setEnv({ projectId: env.projectId }, "TOKEN", "tok-secret-value", true);
    s.setEnv({ projectId: env.projectId }, "PLAIN", "plain-value", false);
    const resolved = s.resolveEnv(env.projectId);
    deployImpl = async () => {
      throw new Error("boom tok-secret-value plain-value");
    };
    const dep = await triggerDeploy({ store: s, run: recorder() }, env.id, await nboDir(), {
      env: resolved,
      fingerprint: s.envFingerprintFor(resolved),
    });
    expect(dep.status).toBe("failed");
    expect(dep.error).toContain("boom");
    expect(dep.error).not.toContain("tok-secret-value");
    expect(dep.error).toContain("plain-value");
  });

  it("names only: the runner's redaction list (plain values of 6+ characters) is kept out of the recorded error too", async () => {
    const s = await openStore();
    const env = cloudRunEnv(s, "us-central1");
    const resolved = {
      vars: { TOKEN: "tok-secret-value", PLAIN: "plain-value", SHORT: "prod" },
      secretNames: ["TOKEN"],
    };
    deployImpl = async () => {
      throw new Error("boom tok-secret-value plain-value prod");
    };
    const dep = await triggerDeploy({ store: s, run: recorder() }, env.id, await nboDir(), {
      env: resolved,
      fingerprint: null,
      redact: ["tok-secret-value", "plain-value"],
    });
    expect(dep.status).toBe("failed");
    expect(dep.error).toContain("boom");
    expect(dep.error).not.toContain("tok-secret-value");
    expect(dep.error).not.toContain("plain-value");
    expect(dep.error).toContain("prod");
  });
});

describe("a keyless (wif) connection: deploy and teardown use googleCredential", () => {
  const signedIn = (calls: Call[]) => ({
    credFile: calls.some((c) => c.args[0] === "auth" && c.args[1] === "login" && c.args[2]!.startsWith("--cred-file=")),
    activate: calls.some((c) => c.args.includes("activate-service-account")),
  });
  async function wifStore(): Promise<Store> {
    const s = await openStore();
    saveWifConnection(s, "acme", "europe-west1");
    return s;
  }

  it("deploy signs in with the token exchange, never a key", async () => {
    const s = await wifStore();
    const env = cloudRunEnv(s, "europe-west1");
    const run = recorder();
    const dep = await triggerDeploy({ store: s, mode: "production", run }, env.id, await nboDir());
    expect(dep.status).toBe("succeeded");
    expect(signedIn(run.calls)).toEqual({ credFile: true, activate: false });
  });

  it("teardown signs in with the token exchange, never a key", async () => {
    const s = await wifStore();
    const run = recorder();
    await createCloudTeardown(run, { mode: "production", store: s }).remove({
      target: "cloudrun",
      appName: "pabc-cloudrun",
      projectId: "proj_abc",
      config: { project: "acme", region: "us-central1" },
    });
    expect(signedIn(run.calls)).toEqual({ credFile: true, activate: false });
  });
});
