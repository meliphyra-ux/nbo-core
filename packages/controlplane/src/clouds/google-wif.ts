// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Keyless Google connections (workload identity federation): the connection
// code the setup command prints, the credential every Google caller uses, and
// the self-check of the project's trust setup.
import { type CommandRunner, type GoogleCredential, type ToolContext } from "@nbo/deploy";
import type { Store } from "../store/store.js";
import { cliMessage } from "./cloud-setup.js";
import { googleAudience, googleIdentity, signGoogleToken } from "./google-identity.js";

export const POOL = "nbo-cores";
export const NOT_A_CODE = "That isn't a connection code from the setup command.";
export const OTHER_CORE = "This connection code was made for another core.";
export const NOT_TRUSTED =
  "the provider doesn't trust this core's key: re-run the setup command shown in the dashboard";
export const PULLER_NOTE =
  "Clusters can't pull from Artifact Registry under this project's key policy; give a cluster another registry";
// oldKeyNote: a key of the replaced connection that is still valid in Google.
export function oldKeyNote(keyId: string, email: string): string {
  return `Delete the old ${email.split("@")[0]} key ${keyId} in the Google console`;
}

const PREFIX = "nbo-gcp1.";

export interface ConnectionCode {
  project: string;
  projectNumber: string;
  pool: string;
  provider: string;
  serviceAccount: string;
  issuer: string;
}

// parseConnectionCode reads `nbo-gcp1.` + base64url(JSON). Nothing in it is
// secret; it is checked against this core's identity by the caller. All
// whitespace is dropped first: Cloud Shell wraps a long line when it is copied.
export function parseConnectionCode(code: string): ConnectionCode {
  const bad = () => new Error(NOT_A_CODE);
  const text = typeof code === "string" ? code.replace(/\s+/g, "") : "";
  if (!text.startsWith(PREFIX)) throw bad();
  const b64 = text.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_\-+/]+={0,2}$/.test(b64)) throw bad();
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(b64.replace(/\+/g, "-").replace(/\//g, "_"), "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad();
  const r = raw as Record<string, unknown>;
  const fields = ["project", "projectNumber", "pool", "provider", "serviceAccount", "issuer"] as const;
  for (const f of fields) if (typeof r[f] !== "string" || r[f] === "") throw bad();
  const c = Object.fromEntries(fields.map((f) => [f, r[f] as string])) as unknown as ConnectionCode;
  if (!/^[a-z][a-z0-9-]{0,28}[a-z0-9]$/.test(c.project)) throw bad();
  if (!/^\d+$/.test(c.projectNumber)) throw bad();
  if (c.pool !== POOL) throw bad();
  if (!/^[a-z0-9-]{4,32}$/.test(c.provider)) throw bad();
  if (c.serviceAccount !== `nbo-deployer@${c.project}.iam.gserviceaccount.com`) throw bad();
  if (!/^https:\/\/\S+$/.test(c.issuer)) throw bad();
  return c;
}

// wifCredential: the keyless credential for a provider and service account.
export function wifCredential(
  store: Store,
  conn: { projectNumber: string; provider: string; serviceAccount: string },
): GoogleCredential {
  const audience = googleAudience(conn.projectNumber, conn.provider);
  return {
    kind: "wif",
    audience,
    serviceAccount: conn.serviceAccount,
    signToken: () => signGoogleToken(store, audience),
  };
}

// googleCredential: how every caller signs in to Google Cloud as the saved
// connection's deployer — its stored key, or a token this core signs.
export function googleCredential(store: Store): GoogleCredential {
  const conn = store.getGoogleConnection();
  if (!conn) throw new Error("Google Cloud is not connected.");
  if (conn.auth === "wif") {
    if (!conn.projectNumber || !conn.provider)
      throw new Error("the keyless Google connection is incomplete: connect Google Cloud again");
    return wifCredential(store, {
      projectNumber: conn.projectNumber,
      provider: conn.provider,
      serviceAccount: conn.deployer,
    });
  }
  return { kind: "key", keyJson: store.getGoogleSecrets().deployerKey };
}

// googleWords: the first line of Google's own message (without the runner's
// "<cmd> failed with exit code N:" header), short enough for a warning.
// Never empty: with no output after the header, the header itself (which
// says "timed out after Nms" or the exit code), else "(no message)".
export function googleWords(err: unknown): string {
  const first = (text: string): string =>
    text
      .split(/\r?\n/)
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  const raw = err instanceof Error ? err.message : String(err);
  const line = first(cliMessage(err)) || first(raw) || "(no message)";
  return line.slice(0, 300);
}

function extractJson(output: string, open = "{", close = "}"): unknown {
  const a = output.indexOf(open);
  const b = output.lastIndexOf(close);
  if (a < 0 || b <= a) throw new Error("gcloud returned no JSON");
  return JSON.parse(output.slice(a, b + 1)) as unknown;
}

interface PoolProvider {
  name?: string;
  state?: string;
  disabled?: boolean;
  attributeCondition?: string;
  attributeMapping?: Record<string, string>;
}

interface Policy {
  bindings?: { role?: string; members?: string[] }[];
}

export interface SelfCheck {
  warnings: string[];
  otherCores: string[];
}

// selfCheck reads, as the deployer, the core's provider and the IAM policies
// of the project and of the deployer account. It warns on any key in the
// provider that isn't this core's, on any federated principal with a role
// there that isn't a core-* subject of this project's nbo-cores pool, and on
// every binding on the deployer account except a core-* subject's
// workloadIdentityUser (users, service accounts, groups, any other role). Other cores' principals are listed, not warned about. A read
// that fails is a warning too: the check never fails a connection.
export async function selfCheck(
  run: CommandRunner,
  ctx: ToolContext,
  store: Store,
  conn: { project: string; projectNumber: string; provider: string; serviceAccount: string },
): Promise<SelfCheck> {
  const own = googleIdentity(store);
  const warnings: string[] = [];
  const others = new Set<string>();
  const gc = (args: string[]): Promise<string> =>
    run("gcloud", [...args, "--project", conn.project, "--format=json"], { env: ctx.env });
  const read = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`NBO couldn't read ${what} for its self-check: ${googleWords(err)}`);
      return null;
    }
  };

  const provider = await read(`the provider ${conn.provider}`, async () => {
    const out = await gc([
      "iam",
      "workload-identity-pools",
      "providers",
      "describe",
      conn.provider,
      "--location",
      "global",
      "--workload-identity-pool",
      POOL,
    ]);
    const jwksJson = (extractJson(out) as { oidc?: { jwksJson?: unknown } }).oidc?.jwksJson;
    if (typeof jwksJson !== "string") throw new Error("the provider has no inline key set");
    const keys = (JSON.parse(jwksJson) as { keys?: { kid?: unknown }[] }).keys;
    if (!Array.isArray(keys)) throw new Error("the provider's key set has no keys");
    return keys.map((k) => (typeof k.kid === "string" ? k.kid : "(no key id)"));
  });
  for (const kid of provider ?? []) {
    if (kid !== own.keyId)
      warnings.push(
        `The provider ${conn.provider} trusts a key that isn't this core's: ${kid}. Remove it in Google Cloud.`,
      );
  }

  // Every subject principal of the pool is pool-wide: any active provider in
  // it could mint sub=core-<this core>. Each must be a core's own provider,
  // mapping google.subject from sub and admitting only its own sub.
  const providers = await read(`the providers of the ${POOL} pool`, async () => {
    const out = await gc([
      "iam",
      "workload-identity-pools",
      "providers",
      "list",
      "--workload-identity-pool",
      POOL,
      "--location",
      "global",
    ]);
    const list = extractJson(out, "[", "]");
    if (!Array.isArray(list)) throw new Error("gcloud returned no provider list");
    return list as PoolProvider[];
  });
  for (const p of providers ?? []) {
    // Fail closed: only a disabled or deleted provider can't mint tokens.
    if (p.disabled === true || p.state === "DELETED") continue;
    const id = (p.name ?? "").split("/").pop() ?? "";
    const isCore = /^core-[0-9a-f]{16}$/.test(id);
    const sound =
      isCore &&
      p.attributeCondition === `assertion.sub=='${id}'` &&
      p.attributeMapping?.["google.subject"] === "assertion.sub";
    if (!sound) {
      warnings.push(
        `The ${POOL} pool has a provider ${id || "(unnamed)"} that isn't a core's own (each must admit only assertion.sub=='<its id>'); it could act as any core. Remove it in Google Cloud.`,
      );
      continue;
    }
    if (id !== own.provider) others.add(id);
  }

  const corePrefix = `principal://iam.googleapis.com/projects/${conn.projectNumber}/locations/global/workloadIdentityPools/${POOL}/subject/`;
  const coreOf = (member: string): string | null => {
    if (!member.startsWith(corePrefix)) return null;
    const sub = member.slice(corePrefix.length);
    return /^core-[0-9a-f]{16}$/.test(sub) ? sub : null;
  };
  const federated = (m: string) => m.startsWith("principal://") || m.startsWith("principalSet://");

  const examine = (policy: Policy | null, where: string, onDeployer: boolean) => {
    for (const b of policy?.bindings ?? []) {
      const role = b.role ?? "";
      for (const m of b.members ?? []) {
        const core = coreOf(m);
        // A core only ever holds workloadIdentityUser on the deployer;
        // anything else a core subject holds is a warning.
        if (core !== null && onDeployer && role === "roles/iam.workloadIdentityUser") {
          if (core !== own.subject) others.add(core);
          continue;
        }
        if (core !== null) {
          warnings.push(
            `${role} on ${where} is granted to ${m}; a core only ever holds roles/iam.workloadIdentityUser on ${conn.serviceAccount}.`,
          );
          continue;
        }
        // On the deployer itself nothing but a core's workloadIdentityUser
        // belongs: any other binding can act as, or change, the deployer.
        if (federated(m) || onDeployer)
          warnings.push(`${role} on ${where} is granted to ${m}, which isn't a core of the ${POOL} pool.`);
      }
    }
  };
  examine(
    (await read(`the IAM policy of project ${conn.project}`, async () =>
      extractJson(await gc(["projects", "get-iam-policy", conn.project])),
    )) as Policy | null,
    `project ${conn.project}`,
    false,
  );
  examine(
    (await read(`the IAM policy of ${conn.serviceAccount}`, async () =>
      extractJson(await gc(["iam", "service-accounts", "get-iam-policy", conn.serviceAccount])),
    )) as Policy | null,
    conn.serviceAccount,
    true,
  );
  return { warnings, otherCores: [...others].sort() };
}
