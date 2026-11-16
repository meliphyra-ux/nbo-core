// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { redact, withGoogleCredentials, type CommandRunner } from "@nbo/deploy";
import type { GoogleConnection } from "./connections.js";
import type { Store } from "../store/store.js";
import { connectTimeoutMs, partialConnectNote } from "./cloud-setup.js";

export interface GoogleDetection {
  found: boolean;
  account: string | null;
  project: string | null;
  reason: string | null;
}

export interface GoogleConnect {
  detect(): Promise<GoogleDetection>;
  connectFromMachine(req: { project: string; region: string }): Promise<GoogleConnection>;
  connectWithKey(req: { keyJson: string; region: string }): Promise<GoogleConnection>;
  test(): Promise<GoogleConnection>;
  plan(req: { source: "machine" | "key"; project: string; region: string }): string[];
}

export const deployerRoles: readonly string[] = [
  "roles/run.admin",
  "roles/artifactregistry.admin",
  "roles/iam.serviceAccountUser",
  "roles/iam.serviceAccountAdmin",
  "roles/serviceusage.serviceUsageAdmin",
  // Secret variables live in Secret Manager: the deployer creates their
  // secrets, adds versions and grants each service read access.
  "roles/secretmanager.admin",
];

const apis = [
  "run.googleapis.com",
  "artifactregistry.googleapis.com",
  "iam.googleapis.com",
  "secretmanager.googleapis.com",
];
const DEPLOYER = "nbo-deployer";
const PULLER = "nbo-puller";
const REPO = "nbo";

const saEmail = (name: string, project: string): string => `${name}@${project}.iam.gserviceaccount.com`;

// Raised by step(); marks errors that are already redacted and name their step.
class StepError extends Error {}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Every form of a key we must never let into a message: the raw JSON, the
// private key, and the private key as it appears inside JSON (newlines as
// backslash-n), which redact() does not cover on its own.
function secretForms(keyJson: string): string[] {
  const forms = [keyJson];
  try {
    const pk = (JSON.parse(keyJson) as { private_key?: unknown }).private_key;
    if (typeof pk === "string" && pk) forms.push(pk, JSON.stringify(pk).slice(1, -1));
  } catch {
    // not JSON; the raw text is still redacted
  }
  return forms;
}

function parseKey(keyJson: string): { project: string; email: string } {
  const bad = new Error(
    "That does not look like a service-account key: expected JSON with project_id and client_email.",
  );
  let k: { project_id?: unknown; client_email?: unknown };
  try {
    k = JSON.parse(keyJson) as typeof k;
  } catch {
    throw bad;
  }
  if (typeof k?.project_id !== "string" || !k.project_id || typeof k.client_email !== "string" || !k.client_email)
    throw bad;
  return { project: k.project_id, email: k.client_email };
}

function permissionOf(text: string): string | null {
  if (!/PERMISSION_DENIED|does not have .*permission/i.test(text)) return null;
  const re = /[a-z]+\.[a-zA-Z]+\.[a-zA-Z]+/g;
  const quoted = /['"`]([a-z]+\.[a-zA-Z]+\.[a-zA-Z]+)['"`]/.exec(text);
  if (quoted) return quoted[1]!;
  for (const m of text.matchAll(re)) if (!m[0].startsWith("gcloud.")) return m[0];
  return "";
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const bindDelays = [2000, 4000, 8000, 16000];
const testDelays = [5000, 10000, 15000, 20000, 40000]; // 90s total

// gcloud runners return stdout and stderr merged, so pull the JSON object out
// from between any progress lines.
function extractJson(output: string): string | null {
  const a = output.indexOf("{");
  const b = output.lastIndexOf("}");
  return a >= 0 && b > a ? output.slice(a, b + 1) : null;
}

interface KeyRef {
  id: string;
  email: string;
}

// keyRef names a stored service-account key by its id and account, so it
// can be deleted later; null when the JSON lacks either.
function keyRef(keyJson: string): KeyRef | null {
  try {
    const k = JSON.parse(keyJson) as { private_key_id?: unknown; client_email?: unknown };
    return typeof k.private_key_id === "string" &&
      k.private_key_id &&
      typeof k.client_email === "string" &&
      k.client_email
      ? { id: k.private_key_id, email: k.client_email }
      : null;
  } catch {
    return null;
  }
}

function cleanKey(output: string, email: string): string {
  const bad = new Error("gcloud returned an unexpected key format");
  const text = extractJson(output);
  if (!text) throw bad;
  try {
    const k = JSON.parse(text) as { type?: unknown; client_email?: unknown; private_key?: unknown };
    if (k.type !== "service_account" || k.client_email !== email || typeof k.private_key !== "string" || !k.private_key)
      throw bad;
  } catch {
    throw bad;
  }
  return text;
}

export function createGoogleConnect(deps: {
  store: Store;
  run: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
}): GoogleConnect {
  const { store, run } = deps;
  const sleep = deps.sleep ?? defaultSleep;

  async function retryOn<T>(pattern: RegExp, delays: number[], fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i >= delays.length || !pattern.test(errText(err))) throw err;
        await sleep(delays[i]!);
      }
    }
  }
  const notYet = /Service account .*does not exist|does not exist.*service account/i;

  // Runs one named step; failures become errors that name the step (and the
  // missing permission, when there is one) with key material redacted.
  async function step<T>(name: string, secrets: string[], fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StepError) throw err;
      const text = redact(errText(err), secrets);
      const perm = permissionOf(text);
      if (perm !== null)
        throw new StepError(`Google Cloud denied ${name}${perm ? `: missing permission ${perm}` : ""}. ${text}`);
      throw new StepError(`Google Cloud failed while ${name}: ${text}`);
    }
  }

  async function tolerateExists(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (!/already exists|ALREADY_EXISTS/.test(errText(err))) throw err;
    }
  }

  // The shared provisioning sequence. env is undefined for the machine's own
  // gcloud, or a private CLOUDSDK_CONFIG when running under a pasted key.
  async function provision(opts: {
    project: string;
    region: string;
    env?: Record<string, string>;
    createDeployer: boolean;
    deployer: string;
    bindRoles: boolean;
    secrets: string[];
  }): Promise<{ deployerKey?: string; pullerKey: string }> {
    const { project, region, env, deployer, secrets } = opts;
    const puller = saEmail(PULLER, project);
    const gc = (args: string[]): Promise<string> =>
      run(
        "gcloud",
        [...args, "--project", project],
        env ? { env, timeoutMs: connectTimeoutMs } : { timeoutMs: connectTimeoutMs },
      );
    const keysCreate = (email: string): Promise<string> =>
      retryOn(notYet, bindDelays, () => gc(["iam", "service-accounts", "keys", "create", "-", "--iam-account", email]));

    await step("enabling the Run, Artifact Registry, IAM and Secret Manager APIs", secrets, () =>
      gc(["services", "enable", ...apis]),
    );
    await step(`creating the ${REPO} Artifact Registry repository`, secrets, () =>
      tolerateExists(() =>
        gc(["artifacts", "repositories", "create", REPO, "--repository-format", "docker", "--location", region]),
      ),
    );
    if (opts.createDeployer) {
      await step(`creating the ${DEPLOYER} service account`, secrets, () =>
        tolerateExists(() => gc(["iam", "service-accounts", "create", DEPLOYER, "--display-name", "NBO deployer"])),
      );
    }
    await step(`creating the ${PULLER} service account`, secrets, () =>
      tolerateExists(() => gc(["iam", "service-accounts", "create", PULLER, "--display-name", "NBO image puller"])),
    );
    for (const role of opts.bindRoles ? deployerRoles : []) {
      await step(`granting ${role} to the deployer`, secrets, () =>
        retryOn(notYet, bindDelays, () =>
          gc([
            "projects",
            "add-iam-policy-binding",
            project,
            "--member",
            `serviceAccount:${deployer}`,
            "--role",
            role,
            "--condition=None",
          ]),
        ),
      );
    }
    await step(`granting the puller read access to the ${REPO} repository`, secrets, () =>
      retryOn(notYet, bindDelays, () =>
        gc([
          "artifacts",
          "repositories",
          "add-iam-policy-binding",
          REPO,
          "--location",
          region,
          "--member",
          `serviceAccount:${puller}`,
          "--role",
          "roles/artifactregistry.reader",
        ]),
      ),
    );

    const result: { deployerKey?: string; pullerKey: string } = { pullerKey: "" };
    if (opts.createDeployer) {
      result.deployerKey = await step(`creating a key for the ${DEPLOYER} service account`, secrets, async () =>
        cleanKey(await keysCreate(deployer), deployer),
      );
      secrets.push(...secretForms(result.deployerKey));
    }
    try {
      result.pullerKey = await step(`creating a key for the ${PULLER} service account`, secrets, async () =>
        cleanKey(await keysCreate(puller), puller),
      );
    } catch (err) {
      // Nothing will store the deployer key just made; don't leave it valid.
      if (result.deployerKey) await deleteKeys(project, env, [keyRef(result.deployerKey)]);
      throw err;
    }
    secrets.push(...secretForms(result.pullerKey));
    return result;
  }

  // deleteKeys removes service-account keys, best effort: one already gone
  // (NOT_FOUND) is the goal anyway, and a leftover old key must not fail a
  // connection that is already saved. env is the identity that made them.
  async function deleteKeys(
    project: string,
    env: Record<string, string> | undefined,
    refs: (KeyRef | null)[],
  ): Promise<void> {
    for (const k of refs) {
      if (!k) continue;
      try {
        await run(
          "gcloud",
          [
            "iam",
            "service-accounts",
            "keys",
            "delete",
            k.id,
            "--iam-account",
            k.email,
            "--quiet",
            "--project",
            project,
          ],
          env ? { env, timeoutMs: connectTimeoutMs } : { timeoutMs: connectTimeoutMs },
        );
      } catch {
        // see above
      }
    }
  }

  // The stored key that a reconnect may delete: the nbo-deployer key NBO's
  // own connect created. Never a pasted key (even of nbo-deployer), and never
  // the nbo-puller key: every Kubernetes deploy copies it into the project's
  // nbo-pull image-pull Secret, which nothing refreshes on reconnect, so
  // deleting it would break already-deployed sites at the next pod reschedule.
  function storedPrunableKeys(project: string): KeyRef[] {
    if (store.getGoogleConnection()?.project !== project) return [];
    let s;
    try {
      s = store.getGoogleSecrets();
    } catch {
      return [];
    }
    if (!s.deployerKeyMadeByNbo) return [];
    const k = keyRef(s.deployerKey);
    return k && k.email === saEmail(DEPLOYER, project) ? [k] : [];
  }

  // Saves the connection, then deletes the replaced keys listed in previous. If the save
  // fails, the keys made for it are deleted instead.
  async function saveAndPrune(opts: {
    project: string;
    env?: Record<string, string>;
    save: () => void;
    created: string[];
    kept: string[];
    previous: KeyRef[];
  }): Promise<void> {
    try {
      opts.save();
    } catch (err) {
      await deleteKeys(opts.project, opts.env, opts.created.map(keyRef));
      // Store errors carry no key material (they never echo the secrets).
      throw new StepError(`NBO could not save the connection: ${errText(err)}`);
    }
    const keep = new Set(opts.kept.map((k) => keyRef(k)?.id));
    await deleteKeys(
      opts.project,
      opts.env,
      opts.previous.filter((k) => !keep.has(k.id)),
    );
  }

  const withNote = (err: unknown): never => {
    if (err instanceof StepError) throw new StepError(`${err.message} ${partialConnectNote}`);
    throw err;
  };

  const connection = (
    project: string,
    region: string,
    deployer: string,
  ): Parameters<Store["saveGoogleConnection"]>[0] => ({
    project,
    region,
    arRepo: `${region}-docker.pkg.dev/${project}/${REPO}`,
    deployer,
    puller: saEmail(PULLER, project),
  });

  // After saving, the new keys may not have propagated yet; retry the check
  // for up to 90s, then return the saved connection (connected or failing).
  async function settle(): Promise<GoogleConnection> {
    const transient = /invalid_grant|Invalid JWT Signature|PERMISSION_DENIED|denied|403/i;
    for (let i = 0; ; i++) {
      try {
        return await self.test();
      } catch (err) {
        if (i >= testDelays.length || !transient.test(errText(err))) return store.getGoogleConnection()!;
        await sleep(testDelays[i]!);
      }
    }
  }

  const self: GoogleConnect = {
    async detect() {
      try {
        const out = await run("gcloud", ["config", "list", "--format=json"]);
        const core =
          (JSON.parse(extractJson(out) ?? "") as { core?: { account?: string; project?: string } }).core ?? {};
        const account = core.account || null;
        const project = core.project || null;
        if (!account)
          return {
            found: false,
            account: null,
            project,
            reason: "gcloud has no active account; run gcloud auth login",
          };
        return { found: true, account, project, reason: null };
      } catch (err) {
        const text = errText(err);
        const missing = (err as { code?: unknown })?.code === "ENOENT" || /ENOENT|not found/i.test(text);
        return {
          found: false,
          account: null,
          project: null,
          reason: missing
            ? "gcloud is not installed in the NBO container"
            : `could not read the gcloud configuration: ${text}`,
        };
      }
    },

    async connectFromMachine({ project, region }) {
      const deployer = saEmail(DEPLOYER, project);
      const secrets: string[] = [];
      const previous = storedPrunableKeys(project);
      const keys = await provision({ project, region, createDeployer: true, deployer, bindRoles: true, secrets }).catch(
        withNote,
      );
      const stored = { deployerKey: keys.deployerKey!, pullerKey: keys.pullerKey, deployerKeyMadeByNbo: true };
      await saveAndPrune({
        project,
        save: () => store.saveGoogleConnection(connection(project, region, deployer), stored),
        created: [stored.deployerKey, stored.pullerKey],
        kept: [stored.deployerKey, stored.pullerKey],
        previous,
      });
      return settle();
    },

    async connectWithKey({ keyJson, region }) {
      const { project, email } = parseKey(keyJson);
      const secrets = secretForms(keyJson);
      const previous = storedPrunableKeys(project);
      // Save and prune inside the credentials scope, so the pasted identity
      // is the one that deletes (a key path stores no NBO-made deployer key).
      await withGoogleCredentials(keyJson, region, run, async (ctx) => {
        const keys = await provision({
          project,
          region,
          env: ctx.env,
          createDeployer: false,
          deployer: email,
          bindRoles: false,
          secrets,
        });
        await saveAndPrune({
          project,
          env: ctx.env,
          save: () =>
            store.saveGoogleConnection(connection(project, region, email), {
              deployerKey: keyJson,
              pullerKey: keys.pullerKey,
            }),
          created: [keys.pullerKey],
          kept: [keyJson, keys.pullerKey],
          previous,
        });
      })
        .catch((err: unknown) => {
          if (err instanceof StepError) throw err;
          throw new StepError(
            `Google Cloud failed while activating the service-account key: ${redact(errText(err), secrets)}`,
          );
        })
        .catch(withNote);
      return settle();
    },

    async test() {
      const conn = store.getGoogleConnection();
      if (!conn) throw new Error("Google Cloud is not connected.");
      const { deployerKey, pullerKey } = store.getGoogleSecrets();
      const secrets = [...secretForms(deployerKey), ...secretForms(pullerKey)];
      try {
        await withGoogleCredentials(deployerKey, conn.region, run, async (ctx) => {
          const gc = (args: string[]): Promise<string> => run("gcloud", args, { env: ctx.env });
          await step("listing Cloud Run services", secrets, () =>
            gc(["run", "services", "list", "--project", conn.project, "--region", conn.region, "--limit", "1"]),
          );
          await step(`reading the ${REPO} Artifact Registry repository`, secrets, () =>
            gc(["artifacts", "repositories", "describe", REPO, "--location", conn.region, "--project", conn.project]),
          );
        });
      } catch (err) {
        const message =
          err instanceof StepError
            ? err.message
            : `Google Cloud failed while activating the service-account key: ${redact(errText(err), secrets)}`;
        store.recordConnectionCheck("google", message);
        // eslint-disable-next-line preserve-caught-error -- the original error may carry unredacted key material
        throw new Error(message);
      }
      store.recordConnectionCheck("google", null);
      return store.getGoogleConnection()!;
    },

    plan({ source, project, region }) {
      if (source === "key") {
        return [
          `Enable 4 APIs in ${project}: Cloud Run, Artifact Registry, IAM and Secret Manager.`,
          `Create an Artifact Registry repository named ${REPO} in ${region}.`,
          `Create one service account, ${saEmail(PULLER, project)} (pulls images), with read access to the ${REPO} repository only.`,
          "Create a key for the puller and store it, and the key you pasted, encrypted in NBO. Your pasted account is not given any new roles.",
        ];
      }
      return [
        `Enable 4 APIs in ${project}: Cloud Run, Artifact Registry, IAM and Secret Manager.`,
        `Create an Artifact Registry repository named ${REPO} in ${region}.`,
        `Create two service accounts, ${saEmail(DEPLOYER, project)} (deploys services) and ${saEmail(PULLER, project)} (pulls images).`,
        `Grant the deployer ${deployerRoles.length} project roles and the puller read access to the ${REPO} repository only.`,
        "Create one key for each service account and store them encrypted in NBO.",
      ];
    },
  };
  return self;
}
