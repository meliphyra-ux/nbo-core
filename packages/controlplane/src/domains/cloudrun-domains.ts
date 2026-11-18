// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { redact, withGoogleCredentials, type CommandRunner } from "@nbo/deploy";
import type { Store } from "../store/store.js";
import { googleCredential } from "../clouds/google-wif.js";
import type { MappingRecord } from "./domains.js";
import { deployAppName, googleSecrets } from "../deploys/deploy.js";

export interface MappingState {
  records: MappingRecord[];
  ready: boolean;
  message: string;
}

export interface MappingTarget {
  project: string;
  region: string;
  service: string;
}

// Thrown by create when Google says the domain is not verified for the
// connected account.
export class MappingNotVerifiedError extends Error {}

export interface CloudRunDomains {
  // The project's Cloud Run environment as a mapping target, or null.
  targetFor(projectId: string): MappingTarget | null;
  describe(target: MappingTarget, host: string): Promise<MappingState | null>;
  create(target: MappingTarget, host: string): Promise<void>; // throws MappingNotVerifiedError
  remove(target: MappingTarget, host: string): Promise<void>;
}

// The GA group is Anthos-only and refuses --region: managed Cloud Run needs beta.
export const mappingCommand = ["beta", "run", "domain-mappings"];

// A hung gcloud must not hold the domain loop's queue.
const commandTimeoutMs = 120_000;

// Matchers are narrow on purpose: an error we do not recognise must throw.
const notFound = /domain ?mappings?\b[^\n]*(not found|could not be found)|cannot find domain ?mapping/i;
const alreadyExists = /already exists|ALREADY_EXISTS/i;
// gcloud's own refusal, and the server's, which may arrive as a PERMISSION_DENIED.
const notVerified = /does not appear to be verified|not authorized to administer the domain/i;

export const listMappingsArgs = (where: string[]): string[] => [
  ...mappingCommand,
  "list",
  ...where,
  "--format=value(metadata.name)",
];

// mappingMissing says whether a failed describe or delete means Google has no
// such mapping. Google's 404 wording isn't known, so text the matcher doesn't
// recognise is settled by listing: a host that isn't listed is gone. A failed
// list proves nothing, so that is false. message must be gcloud's own text,
// not one of our wrappers, which say "domain mapping" themselves.
export async function mappingMissing(message: string, host: string, list: () => Promise<string>): Promise<boolean> {
  if (notFound.test(message)) return true;
  let listed: string;
  try {
    listed = await list();
  } catch {
    return false;
  }
  return !listed.split(/\r?\n/).some((line) => line.trim() === host);
}

// A failure of the domain-mappings command itself, as opposed to credential
// setup. Only these are matched against the patterns above.
class CommandFailure extends Error {}

// gcloud runners return stdout and stderr merged, so pull the JSON object out
// from between any warning lines.
function extractJson(output: string): string | null {
  const a = output.indexOf("{");
  const b = output.lastIndexOf("}");
  return a >= 0 && b > a ? output.slice(a, b + 1) : null;
}

interface RawMapping {
  status?: {
    resourceRecords?: { type?: string; name?: string; rrdata?: string }[];
    conditions?: { type?: string; status?: string; message?: string }[];
  };
}

// parseMapping reads the DNS records Cloud Run wants, whether the mapping is
// ready, and the first failing condition's message.
export function parseMapping(json: string): MappingState {
  const text = extractJson(json);
  if (!text) throw new Error("gcloud returned an unexpected domain mapping");
  const raw = JSON.parse(text) as RawMapping;
  const status = raw.status ?? {};
  const conditions = status.conditions ?? [];
  return {
    records: (status.resourceRecords ?? []).map((r) => ({
      type: r.type ?? "",
      name: r.name ?? "",
      value: r.rrdata ?? "",
    })),
    ready: conditions.some((c) => c.type === "Ready" && c.status === "True"),
    message: conditions.find((c) => c.status === "False")?.message ?? "",
  };
}

export function createCloudRunDomains(deps: { store: Store; run: CommandRunner }): CloudRunDomains {
  const { store, run } = deps;

  // gcloud runs inside the connection's credentials; anything it throws is
  // scrubbed of the key text before it leaves.
  async function gcloud(target: MappingTarget, args: string[]): Promise<string> {
    const keys = store.getGoogleSecrets();
    try {
      return await withGoogleCredentials(googleCredential(store), target.region, run, async (ctx) => {
        try {
          return await run("gcloud", args, { env: ctx.env, timeoutMs: commandTimeoutMs });
        } catch (err) {
          throw new CommandFailure(err instanceof Error ? err.message : String(err));
        }
      });
    } catch (err) {
      if (err instanceof CommandFailure) throw new CommandFailure(redact(err.message, googleSecrets(keys)));
      // eslint-disable-next-line preserve-caught-error -- the original error may carry key material
      throw new Error(redact(err instanceof Error ? err.message : String(err), googleSecrets(keys)));
    }
  }
  const where = (t: MappingTarget): string[] => ["--project", t.project, "--region", t.region];
  // Credential setup failures are never a missing mapping.
  const gone = async (err: unknown, target: MappingTarget, host: string): Promise<boolean> =>
    err instanceof CommandFailure &&
    (await mappingMissing(err.message, host, () => gcloud(target, listMappingsArgs(where(target)))));

  return {
    targetFor(projectId) {
      const env = store.listEnvironments(projectId).find((e) => e.target === "cloudrun");
      if (!env) return null;
      let cfg: { project?: string; region?: string };
      try {
        cfg = JSON.parse(env.config) as { project?: string; region?: string };
      } catch {
        return null;
      }
      if (!cfg.project || !cfg.region) return null;
      return { project: cfg.project, region: cfg.region, service: deployAppName(env) };
    },

    async describe(target, host) {
      try {
        const out = await gcloud(target, [
          ...mappingCommand,
          "describe",
          "--domain",
          host,
          ...where(target),
          "--format=json",
        ]);
        return parseMapping(out);
      } catch (err) {
        if (await gone(err, target, host)) return null;
        throw err;
      }
    },

    async create(target, host) {
      try {
        await gcloud(target, [
          ...mappingCommand,
          "create",
          "--service",
          target.service,
          "--domain",
          host,
          ...where(target),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!(err instanceof CommandFailure)) throw err;
        if (alreadyExists.test(msg)) return;
        if (notVerified.test(msg)) throw new MappingNotVerifiedError(msg);
        throw err;
      }
    },

    async remove(target, host) {
      try {
        await gcloud(target, [...mappingCommand, "delete", "--domain", host, ...where(target), "--quiet"]);
      } catch (err) {
        if (await gone(err, target, host)) return;
        throw err;
      }
    },
  };
}
