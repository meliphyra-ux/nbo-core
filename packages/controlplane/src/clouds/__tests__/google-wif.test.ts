// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CommandRunner } from "@nbo/deploy";
import { createStore, type Store } from "../../store/store.js";
import { createGoogleConnect } from "../google-connect.js";
import { googleIdentity } from "../google-identity.js";
import { googleCredential, googleWords, parseConnectionCode } from "../google-wif.js";
import { createKubeConnect } from "../kube-connect.js";
import {
  FIXTURE_CODE,
  FIXTURE_ISSUER,
  FIXTURE_PROVIDER,
  pinIdentity,
  saveWifConnection,
} from "./google-wif-fixture.js";

const open: Store[] = [];
afterEach(() => {
  for (const s of open.splice(0)) {
    try {
      s.close();
    } catch {
      // closed
    }
  }
});

async function openStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-wif-"));
  const s = createStore(join(dir, "t.db"), { secretKey: randomBytes(32) });
  open.push(s);
  return s;
}

const NOT_A_CODE = "That isn't a connection code from the setup command.";
const OTHER_CORE = "This connection code was made for another core.";
const NOT_TRUSTED = "the provider doesn't trust this core's key: re-run the setup command shown in the dashboard";
const PULLER_NOTE =
  "Clusters can't pull from Artifact Registry under this project's key policy; give a cluster another registry";
const OLD_KEY_NOTE = "Delete the old nbo-deployer key dep-old in the Google console";
const SA = "nbo-deployer@acme.iam.gserviceaccount.com";
const NUMBER = "123456789012";
const ownPrincipal = (sub: string) =>
  `principal://iam.googleapis.com/projects/${NUMBER}/locations/global/workloadIdentityPools/nbo-cores/subject/${sub}`;

function code(fields: Record<string, unknown>): string {
  return "nbo-gcp1." + Buffer.from(JSON.stringify(fields)).toString("base64url");
}
const good = {
  project: "acme",
  projectNumber: NUMBER,
  pool: "nbo-cores",
  provider: FIXTURE_PROVIDER,
  serviceAccount: SA,
  issuer: FIXTURE_ISSUER,
};

type Call = { cmd: string; args: string[]; env?: Record<string, string> };

// An error the way the real runner (builds/run.ts) rejects: its own header
// line, then the command's output.
const runnerError = (call: Call, output: string): Error =>
  new Error(`${call.cmd} ${call.args.join(" ")} failed with exit code 1:\n${output}`);

const providerOf = (id: string, over: Record<string, unknown> = {}) => ({
  name: `projects/${NUMBER}/locations/global/workloadIdentityPools/nbo-cores/providers/${id}`,
  state: "ACTIVE",
  attributeCondition: `assertion.sub=='${id}'`,
  attributeMapping: { "google.subject": "assertion.sub" },
  ...over,
});
type Handler = (call: Call) => string | Error | undefined;

// A Google project as the setup command leaves it: the provider holds the
// core's own key, the deployer's policy trusts only this core.
function fakeGoogle(store: Store, handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    const call = { cmd, args, env: opts?.env };
    calls.push(call);
    const custom = handler(call);
    if (custom instanceof Error) throw custom;
    if (custom !== undefined) return custom;
    const line = args.join(" ");
    const m = /keys create - --iam-account (\S+)/.exec(line);
    if (m)
      return JSON.stringify({
        type: "service_account",
        client_email: m[1],
        private_key_id: "puller-new",
        private_key: "-----BEGIN PRIVATE KEY-----\nNEWPULLER\n-----END PRIVATE KEY-----\n",
      });
    if (line.startsWith("iam workload-identity-pools providers list"))
      return JSON.stringify([providerOf(FIXTURE_PROVIDER)]);
    if (line.startsWith("iam workload-identity-pools providers describe"))
      return JSON.stringify({
        name: `projects/${NUMBER}/locations/global/workloadIdentityPools/nbo-cores/providers/${FIXTURE_PROVIDER}`,
        oidc: { issuerUri: FIXTURE_ISSUER, jwksJson: JSON.stringify(googleIdentity(store).jwks) },
      });
    if (line.startsWith("projects get-iam-policy"))
      return JSON.stringify({ bindings: [{ role: "roles/run.admin", members: [`serviceAccount:${SA}`] }] });
    if (line.startsWith("iam service-accounts get-iam-policy"))
      return JSON.stringify({
        bindings: [{ role: "roles/iam.workloadIdentityUser", members: [ownPrincipal(FIXTURE_PROVIDER)] }],
      });
    return "";
  };
  return { run, calls, lines: () => calls.map((c) => `${c.cmd} ${c.args.join(" ")}`) };
}

// A clock that sleep moves forward.
function clock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

async function wifSetup(handler?: Handler) {
  const store = await openStore();
  pinIdentity(store);
  const g = fakeGoogle(store, handler);
  const c = clock();
  const connect = createGoogleConnect({ store, run: g.run, sleep: c.sleep, now: c.now });
  return { store, g, c, connect };
}

describe("parseConnectionCode", () => {
  it("reads the setup command's code", () => {
    expect(parseConnectionCode(FIXTURE_CODE)).toEqual(good);
  });

  it("a mangled code is refused", () => {
    const bad = [
      "",
      "nbo-gcp2." + code(good).slice("nbo-gcp1.".length),
      code(good).slice("nbo-gcp1.".length),
      "nbo-gcp1.!!!not base64!!!",
      "nbo-gcp1." + Buffer.from("not json").toString("base64url"),
      code({ ...good, pool: undefined }),
      code({ ...good, issuer: undefined }),
      code({ ...good, projectNumber: "12a4" }),
      code({ ...good, projectNumber: 123456789012 }),
      code({ ...good, serviceAccount: "someone@acme.iam.gserviceaccount.com" }),
      code({ ...good, serviceAccount: "nbo-deployer@other.iam.gserviceaccount.com" }),
      code({ ...good, pool: "other-pool" }),
      "nbo-gcp1." + Buffer.from("[1,2]").toString("base64url"),
    ];
    for (const c of bad) expect(() => parseConnectionCode(c), c).toThrow(NOT_A_CODE);
  });

  it("reads a code wrapped over several lines, as Cloud Shell copies it (M8)", () => {
    const wrapped = FIXTURE_CODE.replace(/(.{60})/g, "$1\n  ").replace("nbo-gcp1.", "nbo-gcp1.\r\n");
    expect(wrapped).toContain("\n");
    expect(parseConnectionCode(`\t${wrapped} \n`)).toEqual(good);
  });

  it("tolerates surrounding whitespace and base64 padding", () => {
    const padded = "nbo-gcp1." + Buffer.from(JSON.stringify(good)).toString("base64");
    expect(parseConnectionCode(`  ${padded}\n`)).toEqual(good);
  });
});

describe("connectWithWif", () => {
  it("a code for another core is refused before any gcloud call", async () => {
    for (const other of [
      { ...good, issuer: "https://core-ffffffffffffffff.nbo.invalid" },
      { ...good, provider: "core-ffffffffffffffff" },
    ]) {
      const { store, g, connect } = await wifSetup();
      await expect(connect.connectWithWif({ code: code(other), region: "europe-west1" })).rejects.toThrow(OTHER_CORE);
      expect(g.calls).toEqual([]);
      expect(store.getGoogleConnection()).toBeNull();
    }
  });

  it("a mangled code is refused before any gcloud call", async () => {
    const { store, g, connect } = await wifSetup();
    await expect(connect.connectWithWif({ code: "nbo-gcp1.xx", region: "europe-west1" })).rejects.toThrow(NOT_A_CODE);
    expect(g.calls).toEqual([]);
    expect(store.getGoogleConnection()).toBeNull();
  });

  it("connect provisions as the deployer and saves auth wif with an empty deployerKey", async () => {
    const { store, g, connect } = await wifSetup((c) => {
      const line = c.args.join(" ");
      if (line.startsWith("artifacts repositories create")) return new Error("ALREADY_EXISTS: the repository exists");
      if (line.startsWith("iam service-accounts create nbo-puller"))
        return new Error("ERROR: Service account nbo-puller already exists within project projects/acme.");
      return undefined;
    });
    const conn = await connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    expect(conn).toMatchObject({
      kind: "google",
      auth: "wif",
      project: "acme",
      projectNumber: NUMBER,
      pool: "nbo-cores",
      provider: FIXTURE_PROVIDER,
      deployer: SA,
      puller: "nbo-puller@acme.iam.gserviceaccount.com",
      arRepo: "europe-west1-docker.pkg.dev/acme/nbo",
      region: "europe-west1",
      status: "connected",
      warnings: [],
    });
    const secrets = store.getGoogleSecrets();
    expect(secrets.deployerKey).toBe("");
    expect(JSON.parse(secrets.pullerKey).client_email).toBe("nbo-puller@acme.iam.gserviceaccount.com");
    const lines = g.lines();
    // Signed in as the deployer through the token exchange, never with a key.
    expect(lines.some((l) => l.includes("auth login --cred-file="))).toBe(true);
    expect(lines.some((l) => l.includes("activate-service-account"))).toBe(false);
    // Never creates the deployer, its key or project role bindings: the setup command did.
    expect(lines.some((l) => l.includes("service-accounts create nbo-deployer"))).toBe(false);
    expect(lines.some((l) => l.includes(`keys create - --iam-account ${SA}`))).toBe(false);
    expect(lines.some((l) => l.includes("projects add-iam-policy-binding"))).toBe(false);
    for (const needle of [
      "artifacts repositories create nbo",
      "iam service-accounts create nbo-puller",
      "artifacts repositories add-iam-policy-binding nbo --location europe-west1 --member serviceAccount:nbo-puller@acme.iam.gserviceaccount.com",
      "keys create - --iam-account nbo-puller@acme.iam.gserviceaccount.com",
      `iam workload-identity-pools providers describe ${FIXTURE_PROVIDER} --location global --workload-identity-pool nbo-cores`,
      "projects get-iam-policy acme",
      `iam service-accounts get-iam-policy ${SA}`,
    ])
      expect(
        lines.some((l) => l.includes(needle)),
        needle,
      ).toBe(true);
    // Every gcloud call after sign-in runs under the private config.
    for (const c of g.calls) expect(c.env?.CLOUDSDK_CONFIG, c.args.join(" ")).toBeTruthy();
  });

  it("the repository step is retried while the deployer isn't visible yet (M1)", async () => {
    let tries = 0;
    const { connect } = await wifSetup((call) => {
      if (call.args.join(" ").startsWith("artifacts repositories create") && tries++ === 0)
        return runnerError(call, `ERROR: Service account ${SA} does not exist.`);
      return undefined;
    });
    const conn = await connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    expect(conn.status).toBe("connected");
    expect(tries).toBe(2);
  });

  it("the repository step is retried while the deployer's roles propagate (round 2)", async () => {
    let tries = 0;
    const { connect, c } = await wifSetup((call) => {
      if (call.args.join(" ").startsWith("artifacts repositories create") && tries++ < 2)
        return runnerError(
          call,
          "ERROR: (gcloud.artifacts.repositories.create) PERMISSION_DENIED: Permission 'artifactregistry.repositories.create' denied on resource '//artifactregistry.googleapis.com/projects/acme/locations/europe-west1' (or it may not exist).",
        );
      return undefined;
    });
    const conn = await connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    expect(conn.status).toBe("connected");
    expect(tries).toBe(3);
    expect(c.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
  });

  it("propagation errors are retried up to 5 minutes, then connected", async () => {
    let refusals = 0;
    const { store, c, connect } = await wifSetup((call) => {
      const line = call.args.join(" ");
      if (line.startsWith("auth print-access-token") && refusals < 2) {
        refusals++;
        return new Error(
          "ERROR: (gcloud.auth.print-access-token) Permission 'iam.serviceAccounts.getAccessToken' denied on resource",
        );
      }
      if (line.startsWith("auth login") && refusals === 0) {
        refusals++;
        return new Error('invalid_grant: {"error":"invalid_grant","error_description":"..."}');
      }
      return undefined;
    });
    const conn = await connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    expect(conn.auth).toBe("wif");
    expect(c.slept.length).toBe(2);
    expect(store.getGoogleConnection()?.status).toBe("connected");
  });

  it("persistent propagation errors give up after 5 minutes with the spec sentence, saving nothing", async () => {
    const { store, c, connect } = await wifSetup((call) =>
      call.args[0] === "auth" && call.args[1] === "print-access-token"
        ? new Error("ERROR: NOT_FOUND: Requested entity was not found. workloadIdentityPools/nbo-cores")
        : undefined,
    );
    await expect(connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" })).rejects.toThrow(NOT_TRUSTED);
    const total = c.slept.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(5 * 60_000);
    expect(total).toBeGreaterThan(4 * 60_000);
    expect(store.getGoogleConnection()).toBeNull();
  });

  it("a refusal that isn't propagation fails at once with the sentence and Google's own words", async () => {
    const { store, c, connect } = await wifSetup((call) =>
      call.args[0] === "auth" && call.args[1] === "print-access-token"
        ? runnerError(call, "ERROR: unauthorized_client: The given credential is rejected by the attribute condition.")
        : undefined,
    );
    const err = (await connect
      .connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain(NOT_TRUSTED);
    expect(err.message).toContain("Google said: ERROR: unauthorized_client: The given credential is rejected");
    expect(err.message).not.toContain("exit code");
    expect(c.slept).toEqual([]);
    expect(store.getGoogleConnection()).toBeNull();
  });

  it("puller key refused by policy → connected with the cluster note in warnings", async () => {
    const { store, connect } = await wifSetup((call) =>
      call.args.join(" ").startsWith("iam service-accounts keys create")
        ? new Error(
            "ERROR: (gcloud.iam.service-accounts.keys.create) FAILED_PRECONDITION: Key creation is not allowed on this service account. constraints/iam.managed.disableServiceAccountKeyCreation",
          )
        : undefined,
    );
    const conn = await connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    expect(conn.status).toBe("connected");
    expect(conn.warnings).toEqual([PULLER_NOTE]);
    expect(store.getGoogleSecrets().pullerKey).toBe("");
  });

  it("other puller key failures still fail the connect", async () => {
    const { store, connect } = await wifSetup((call) =>
      call.args.join(" ").startsWith("iam service-accounts keys create") ? new Error("INTERNAL: boom") : undefined,
    );
    await expect(connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" })).rejects.toThrow(/boom/);
    expect(store.getGoogleConnection()).toBeNull();
  });

  it("choosing artifact-registry for a cluster on that connection is refused", async () => {
    const store = await openStore();
    saveWifConnection(store, "acme", "europe-west1", "");
    const kube = createKubeConnect({ store, run: async () => "", sleep: async () => {} });
    await expect(
      kube.connect({
        source: { kind: "machine", context: "c" },
        name: "prod",
        registry: { kind: "artifact-registry" },
      }),
    ).rejects.toThrow(PULLER_NOTE);
    expect(store.listKubernetesConnections()).toEqual([]);
  });

  it("replacing a key connection keeps the old pullerKey when no new one can be made (Review Focus 5)", async () => {
    const { store, connect } = await wifSetup((call) =>
      call.args.join(" ").startsWith("iam service-accounts keys create")
        ? new Error("FAILED_PRECONDITION: iam.managed.disableServiceAccountKeyCreation")
        : undefined,
    );
    const oldPuller = JSON.stringify({
      type: "service_account",
      client_email: "nbo-puller@acme.iam.gserviceaccount.com",
      private_key_id: "puller-old",
      private_key: "OLDPULLER",
    });
    store.saveGoogleConnection(
      {
        project: "acme",
        region: "europe-west1",
        arRepo: "europe-west1-docker.pkg.dev/acme/nbo",
        deployer: SA,
        puller: "nbo-puller@acme.iam.gserviceaccount.com",
      },
      { deployerKey: '{"private_key_id":"dep-old"}', pullerKey: oldPuller },
    );
    const conn = await connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    expect(conn.auth).toBe("wif");
    expect(conn.warnings).toEqual([]);
    expect(store.getGoogleSecrets()).toMatchObject({ deployerKey: "", pullerKey: oldPuller });
  });

  it("never tries to delete the old NBO-made deployer key (the keyless deployer can't) and names it in a note (I2)", async () => {
    const { store, g, connect } = await wifSetup();
    const oldDeployer = JSON.stringify({ type: "service_account", client_email: SA, private_key_id: "dep-old" });
    store.saveGoogleConnection(
      {
        project: "acme",
        region: "europe-west1",
        arRepo: "europe-west1-docker.pkg.dev/acme/nbo",
        deployer: SA,
        puller: "nbo-puller@acme.iam.gserviceaccount.com",
      },
      { deployerKey: oldDeployer, pullerKey: "{}", deployerKeyMadeByNbo: true },
    );
    const conn = await connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    expect(g.lines().some((l) => l.includes("keys delete"))).toBe(false);
    expect(conn.status).toBe("connected");
    expect(conn.warnings).toEqual([OLD_KEY_NOTE]);
    expect(store.getGoogleConnection()?.warnings).toEqual([OLD_KEY_NOTE]);
  });

  it("a key connection to another project leaves no note: its key isn't this project's (I2)", async () => {
    const { store, g, connect } = await wifSetup();
    store.saveGoogleConnection(
      {
        project: "other",
        region: "europe-west1",
        arRepo: "europe-west1-docker.pkg.dev/other/nbo",
        deployer: "nbo-deployer@other.iam.gserviceaccount.com",
        puller: "nbo-puller@other.iam.gserviceaccount.com",
      },
      {
        deployerKey: JSON.stringify({
          client_email: "nbo-deployer@other.iam.gserviceaccount.com",
          private_key_id: "o",
        }),
        pullerKey: "{}",
        deployerKeyMadeByNbo: true,
      },
    );
    const conn = await connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    expect(g.lines().some((l) => l.includes("keys delete"))).toBe(false);
    expect(conn.warnings).toEqual([]);
  });
});

describe("replacing a pasted key (M3)", () => {
  it("never deletes a pasted deployer key and names it in a note", async () => {
    const { store, g, connect } = await wifSetup();
    store.saveGoogleConnection(
      {
        project: "acme",
        region: "europe-west1",
        arRepo: "europe-west1-docker.pkg.dev/acme/nbo",
        deployer: SA,
        puller: "nbo-puller@acme.iam.gserviceaccount.com",
      },
      { deployerKey: JSON.stringify({ client_email: SA, private_key_id: "pasted-1" }), pullerKey: "{}" },
    );
    const conn = await connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    expect(g.lines().some((l) => l.includes("keys delete"))).toBe(false);
    expect(conn.warnings).toEqual(["Delete the old nbo-deployer key pasted-1 in the Google console"]);
  });
});

describe("self-check", () => {
  const foreignKeyProvider = (store: Store) =>
    JSON.stringify({
      oidc: {
        jwksJson: JSON.stringify({
          keys: [...googleIdentity(store).jwks.keys, { kty: "RSA", kid: "someone-elses-key", n: "x", e: "AQAB" }],
        }),
      },
    });

  it("warns on a foreign key in the provider and on a federated principal outside nbo-cores core-*", async () => {
    const s = await wifSetup((call) => {
      const line = call.args.join(" ");
      if (line.startsWith("iam workload-identity-pools providers describe")) return foreignKeyProvider(s.store);
      if (line.startsWith("projects get-iam-policy"))
        return JSON.stringify({
          bindings: [
            {
              role: "roles/owner",
              members: [
                "user:owner@example.com",
                `principalSet://iam.googleapis.com/projects/${NUMBER}/locations/global/workloadIdentityPools/evil/*`,
              ],
            },
          ],
        });
      if (line.startsWith("iam service-accounts get-iam-policy"))
        return JSON.stringify({
          bindings: [
            {
              role: "roles/iam.workloadIdentityUser",
              members: [
                ownPrincipal(FIXTURE_PROVIDER),
                ownPrincipal("core-aaaaaaaaaaaaaaaa"),
                `principal://iam.googleapis.com/projects/${NUMBER}/locations/global/workloadIdentityPools/nbo-cores/subject/intruder`,
              ],
            },
            { role: "roles/iam.serviceAccountTokenCreator", members: ["user:mallory@example.com"] },
          ],
        });
      return undefined;
    });
    const conn = await s.connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    const text = conn.warnings.join("\n");
    expect(conn.warnings).toHaveLength(4);
    expect(text).toContain("someone-elses-key");
    expect(text).toContain("workloadIdentityPools/evil/*");
    expect(text).toContain("subject/intruder");
    expect(text).toContain("user:mallory@example.com");
    // The project owner and other cores aren't warned about; other cores are listed.
    expect(text).not.toContain("owner@example.com");
    expect(text).not.toContain("core-aaaaaaaaaaaaaaaa");
    expect(conn.otherCores).toEqual(["core-aaaaaaaaaaaaaaaa"]);
  });

  it("runs on test, replacing the earlier check's warnings and keeping connect notes", async () => {
    let foreign = false;
    const s = await wifSetup((call) => {
      const line = call.args.join(" ");
      if (line.startsWith("iam service-accounts keys create"))
        return new Error("FAILED_PRECONDITION: disableServiceAccountKeyCreation");
      if (foreign && line.startsWith("iam workload-identity-pools providers describe"))
        return foreignKeyProvider(s.store);
      return undefined;
    });
    expect((await s.connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" })).warnings).toEqual([
      PULLER_NOTE,
    ]);
    foreign = true;
    const tested = await s.connect.test();
    expect(tested.warnings).toHaveLength(2);
    expect(tested.warnings[0]).toBe(PULLER_NOTE);
    expect(tested.warnings[1]).toContain("someone-elses-key");
    expect(s.g.lines().filter((l) => l.includes("activate-service-account"))).toEqual([]);
    foreign = false;
    expect((await s.connect.test()).warnings).toEqual([PULLER_NOTE]);
  });

  it("a self-check that can't read Google warns instead of failing, in Google's words", async () => {
    const s = await wifSetup((call) =>
      call.args.join(" ").startsWith("projects get-iam-policy")
        ? runnerError(call, "ERROR: (gcloud.projects.get-iam-policy) PERMISSION_DENIED: no access")
        : undefined,
    );
    const conn = await s.connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    expect(conn.status).toBe("connected");
    expect(conn.warnings).toHaveLength(1);
    expect(conn.warnings[0]).toMatch(/couldn't/i);
    expect(conn.warnings[0]).toContain("PERMISSION_DENIED: no access");
    expect(conn.warnings[0]).not.toContain("exit code");
  });

  it("warns on a smuggled provider in the pool; other cores' providers are listed (I1)", async () => {
    const s = await wifSetup((call) =>
      call.args.join(" ").startsWith("iam workload-identity-pools providers list")
        ? JSON.stringify([
            providerOf(FIXTURE_PROVIDER),
            providerOf("core-aaaaaaaaaaaaaaaa"),
            // Anyone's JWKS, no condition: could mint sub=core-<this core>.
            providerOf("evil", { attributeCondition: undefined }),
            providerOf("core-bbbbbbbbbbbbbbbb", { attributeCondition: "true" }),
            providerOf("core-cccccccccccccccc", { attributeCondition: "assertion.sub=='core-0123456789abcdef'" }),
            providerOf("core-dddddddddddddddd", { attributeMapping: { "google.subject": "assertion.email" } }),
            // Disabled or deleted providers can't mint tokens.
            providerOf("gone", { state: "DELETED", attributeCondition: undefined }),
            providerOf("off", { disabled: true, attributeCondition: undefined }),
          ])
        : undefined,
    );
    const conn = await s.connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    expect(conn.status).toBe("connected");
    const text = conn.warnings.join("\n");
    expect(conn.warnings).toHaveLength(4);
    for (const bad of ["evil", "core-bbbbbbbbbbbbbbbb", "core-cccccccccccccccc", "core-dddddddddddddddd"])
      expect(text).toContain(bad);
    expect(text).not.toContain("gone");
    expect(text).not.toContain("off");
    expect(conn.otherCores).toEqual(["core-aaaaaaaaaaaaaaaa"]);
    expect(
      s.g
        .lines()
        .some((l) => l.includes("iam workload-identity-pools providers list --workload-identity-pool nbo-cores")),
    ).toBe(true);
  });
});

describe("self-check fails closed (round 2)", () => {
  it("warns on a core subject bound on the project, or with any role but workloadIdentityUser on the deployer", async () => {
    const s = await wifSetup((call) => {
      const line = call.args.join(" ");
      if (line.startsWith("projects get-iam-policy"))
        return JSON.stringify({
          bindings: [{ role: "roles/viewer", members: [ownPrincipal("core-aaaaaaaaaaaaaaaa")] }],
        });
      if (line.startsWith("iam service-accounts get-iam-policy"))
        return JSON.stringify({
          bindings: [
            {
              role: "roles/iam.workloadIdentityUser",
              members: [ownPrincipal(FIXTURE_PROVIDER), ownPrincipal("core-bbbbbbbbbbbbbbbb")],
            },
            { role: "roles/iam.serviceAccountTokenCreator", members: [ownPrincipal("core-eeeeeeeeeeeeeeee")] },
          ],
        });
      return undefined;
    });
    const conn = await s.connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    const text = conn.warnings.join("\n");
    expect(conn.warnings).toHaveLength(2);
    expect(text).toContain("roles/viewer");
    expect(text).toContain("subject/core-aaaaaaaaaaaaaaaa");
    expect(text).toContain("roles/iam.serviceAccountTokenCreator");
    expect(text).toContain("subject/core-eeeeeeeeeeeeeeee");
    expect(conn.otherCores).toEqual(["core-bbbbbbbbbbbbbbbb"]);
  });

  it("warns on every binding on the deployer except a core's workloadIdentityUser (M5)", async () => {
    const s = await wifSetup((call) => {
      const line = call.args.join(" ");
      if (line.startsWith("iam service-accounts get-iam-policy"))
        return JSON.stringify({
          bindings: [
            { role: "roles/iam.workloadIdentityUser", members: [ownPrincipal(FIXTURE_PROVIDER), "user:mallory@x.com"] },
            { role: "roles/iam.serviceAccountUser", members: ["serviceAccount:other@acme.iam.gserviceaccount.com"] },
            { role: "roles/viewer", members: ["group:ops@x.com"] },
          ],
        });
      return undefined;
    });
    const conn = await s.connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    const text = conn.warnings.join("\n");
    expect(conn.warnings).toHaveLength(3);
    expect(text).toContain("user:mallory@x.com");
    expect(text).toContain("roles/iam.serviceAccountUser");
    expect(text).toContain("serviceAccount:other@acme.iam.gserviceaccount.com");
    expect(text).toContain("group:ops@x.com");
    expect(conn.checkWarnings).toEqual(conn.warnings);
  });

  it("checkWarnings holds the self-check's findings only, without connect notes", async () => {
    const s = await wifSetup((call) =>
      call.args.join(" ").startsWith("iam service-accounts keys create")
        ? new Error("FAILED_PRECONDITION: iam.managed.disableServiceAccountKeyCreation")
        : undefined,
    );
    const conn = await s.connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    expect(conn.warnings).toEqual([PULLER_NOTE]);
    expect(conn.checkWarnings).toEqual([]);
    expect(conn.otherCores).toEqual([]);
  });

  it("checks a provider in any state but DELETED or disabled", async () => {
    const s = await wifSetup((call) =>
      call.args.join(" ").startsWith("iam workload-identity-pools providers list")
        ? JSON.stringify([
            providerOf(FIXTURE_PROVIDER),
            providerOf("odd1", { state: "STATE_UNSPECIFIED", attributeCondition: undefined }),
            providerOf("odd2", { state: undefined, attributeCondition: undefined }),
            providerOf("odd3", { state: "SOMETHING_NEW", attributeCondition: undefined }),
            providerOf("gone", { state: "DELETED", attributeCondition: undefined }),
            providerOf("off", { disabled: true, attributeCondition: undefined }),
          ])
        : undefined,
    );
    const conn = await s.connect.connectWithWif({ code: FIXTURE_CODE, region: "europe-west1" });
    const text = conn.warnings.join("\n");
    expect(conn.warnings).toHaveLength(3);
    for (const id of ["odd1", "odd2", "odd3"]) expect(text).toContain(`provider ${id} `);
    expect(text).not.toContain("provider gone");
    expect(text).not.toContain("provider off");
  });
});

describe("googleWords (round 2)", () => {
  it("is Google's line without the runner's header, and never empty", () => {
    expect(googleWords(new Error("gcloud x failed with exit code 1:\nERROR: denied\nmore"))).toBe("ERROR: denied");
    expect(googleWords(new Error("gcloud x failed with exit code 1:\n\n"))).toBe("gcloud x failed with exit code 1:");
    expect(googleWords(new Error("gcloud x timed out after 120000ms:\n"))).toBe("gcloud x timed out after 120000ms:");
    expect(googleWords(new Error(""))).toBe("(no message)");
    expect(googleWords("")).toBe("(no message)");
  });
});

describe("googleCredential", () => {
  it("is the stored key for key connections", async () => {
    const store = await openStore();
    store.saveGoogleConnection(
      { project: "p", region: "r", arRepo: "a", deployer: "d", puller: "u" },
      { deployerKey: "KEYJSON", pullerKey: "" },
    );
    expect(googleCredential(store)).toEqual({ kind: "key", keyJson: "KEYJSON" });
    expect(store.getGoogleConnection()).toMatchObject({ auth: "key", warnings: [] });
  });

  it("is a signed token exchange for wif connections", async () => {
    const store = await openStore();
    saveWifConnection(store, "acme");
    const cred = googleCredential(store);
    expect(cred.kind).toBe("wif");
    if (cred.kind !== "wif") return;
    expect(cred.audience).toBe(
      `//iam.googleapis.com/projects/${NUMBER}/locations/global/workloadIdentityPools/nbo-cores/providers/${FIXTURE_PROVIDER}`,
    );
    expect(cred.serviceAccount).toBe(SA);
    const claims = JSON.parse(Buffer.from(cred.signToken().split(".")[1]!, "base64url").toString()) as {
      aud: string;
      sub: string;
    };
    expect(claims.aud).toBe(cred.audience);
    expect(claims.sub).toBe(FIXTURE_PROVIDER);
  });

  it("throws when Google Cloud is not connected", async () => {
    const store = await openStore();
    expect(() => googleCredential(store)).toThrow(/not connected/);
  });
});
