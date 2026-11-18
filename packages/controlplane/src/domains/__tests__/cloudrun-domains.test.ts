// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRunner } from "@nbo/deploy";
import { createStore, type Store } from "../../store/store.js";
import { createCloudRunDomains, mappingMissing, parseMapping, MappingNotVerifiedError } from "../cloudrun-domains.js";
import { deployAppName } from "../../deploys/deploy.js";
import { saveWifConnection } from "../../clouds/__tests__/google-wif-fixture.js";

const KEY = JSON.stringify({
  type: "service_account",
  client_email: "d@p.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nSECRETBODY\n-----END PRIVATE KEY-----\n",
});

async function setup(): Promise<{
  store: Store;
  calls: string[][];
  domainCalls: string[][];
  domainTimeouts: (number | undefined)[];
  project: string;
  mk(
    fail?: (args: string[]) => Error | string | null,
    authFail?: string,
    listed?: string,
  ): ReturnType<typeof createCloudRunDomains>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-crd-"));
  const store = createStore(join(dir, "t.db"), { secretKey: randomBytes(32) });
  store.saveGoogleConnection(
    {
      project: "p",
      region: "r",
      arRepo: "r-docker.pkg.dev/p/nbo",
      deployer: "d@p.iam.gserviceaccount.com",
      puller: "u@p.iam.gserviceaccount.com",
    },
    { deployerKey: KEY, pullerKey: "{}" },
  );
  const project = store.createProject("shop");
  const calls: string[][] = [];
  const domainCalls: string[][] = [];
  const domainTimeouts: (number | undefined)[] = [];
  return {
    store,
    calls,
    domainCalls,
    domainTimeouts,
    project: project.id,
    mk(fail, authFail, listed = "") {
      const run: CommandRunner = async (cmd, args, opts) => {
        calls.push([cmd, ...args]);
        if (authFail && args[0] === "auth" && args[1] === "activate-service-account") throw new Error(authFail);
        // The GA group is Anthos-only and refuses --region, so only beta counts.
        if (args[0] === "run" && args[1] === "domain-mappings")
          throw new Error("ERROR: (gcloud.run.domain-mappings.describe) unrecognized arguments: --region us-central1");
        if (args[0] === "beta" && args[1] === "run" && args[2] === "domain-mappings") {
          domainCalls.push(args);
          domainTimeouts.push(opts?.timeoutMs);
          const f = fail?.(args);
          if (f) throw f instanceof Error ? f : new Error(f);
          return args[3] === "list" ? listed : "";
        }
        return "";
      };
      return createCloudRunDomains({ store, run });
    },
  };
}

const target = { project: "p", region: "r", service: "svc" };

describe("the image", () => {
  it("installs gcloud's beta component before the installer's backup is removed", () => {
    const dockerfile = readFileSync(fileURLToPath(new URL("../../../../../Dockerfile", import.meta.url)), "utf8");
    const extract = dockerfile.indexOf("tar -xzf gcloud.tgz");
    const install = dockerfile.indexOf("google-cloud-sdk/bin/gcloud components install beta --quiet");
    const cleanup = dockerfile.indexOf("rm -rf google-cloud-sdk/.install/.backup");
    expect(extract).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(extract);
    expect(cleanup).toBeGreaterThan(install);
  });
});

describe("command timeouts", () => {
  it("gives every domain-mappings command an explicit 120 s timeout", async () => {
    const t = await setup();
    const api = t.mk();
    await api.describe(target, "a.example.com").catch(() => undefined);
    await api.create(target, "a.example.com");
    await api.remove(target, "a.example.com");
    expect(t.domainTimeouts).toEqual([120_000, 120_000, 120_000]);
  });
});

describe("parseMapping", () => {
  it("reads records, readiness and the first False condition message", () => {
    const json = JSON.stringify({
      status: {
        resourceRecords: [
          { type: "CNAME", name: "www", rrdata: "ghs.googlehosted.com." },
          { type: "A", rrdata: "216.239.32.21" },
        ],
        conditions: [
          { type: "Ready", status: "False", message: "waiting" },
          { type: "CertificateProvisioned", status: "False", message: "later" },
        ],
      },
    });
    expect(parseMapping(json)).toEqual({
      records: [
        { type: "CNAME", name: "www", value: "ghs.googlehosted.com." },
        { type: "A", name: "", value: "216.239.32.21" },
      ],
      ready: false,
      message: "waiting",
    });
  });
  it("is ready only when the Ready condition is True", () => {
    const ok = JSON.stringify({ status: { conditions: [{ type: "Ready", status: "True" }] } });
    expect(parseMapping(ok)).toEqual({ records: [], ready: true, message: "" });
    const other = JSON.stringify({ status: { conditions: [{ type: "CertificateProvisioned", status: "True" }] } });
    expect(parseMapping(other).ready).toBe(false);
  });
  it("parses output with a leading warning line", () => {
    const out = `WARNING: something\n${JSON.stringify({ status: { conditions: [{ type: "Ready", status: "True" }] } })}\n`;
    expect(parseMapping(out).ready).toBe(true);
  });
});

describe("describe", () => {
  it("runs gcloud beta run domain-mappings describe", async () => {
    const s = await setup();
    const crd = s.mk();
    // empty output has no JSON, so it must not be treated as a mapping
    await expect(crd.describe(target, "a.acme.com")).rejects.toThrow();
    expect(s.domainCalls[0]).toEqual([
      "beta",
      "run",
      "domain-mappings",
      "describe",
      "--domain",
      "a.acme.com",
      "--project",
      "p",
      "--region",
      "r",
      "--format=json",
    ]);
  });
  it("returns null when the mapping is not found, rethrows others", async () => {
    const s = await setup();
    for (const msg of [
      "Domain mapping [a] could not be found",
      "ERROR: Cannot find domain mapping for domain name [a]",
    ]) {
      expect(await s.mk(() => msg).describe(target, "a.acme.com")).toBeNull();
    }
    await expect(s.mk(() => "permission denied").describe(target, "a.acme.com")).rejects.toThrow(/permission denied/);
  });
  it.each([
    "Project 'x' not found or permission denied",
    "Cloud Run service foo not found",
    "gcloud: command not found",
  ])("does not read %j as a missing mapping", async (msg) => {
    const s = await setup();
    await expect(s.mk(() => msg).describe(target, "a.acme.com")).rejects.toThrow();
    await expect(s.mk(() => msg).remove(target, "a.acme.com")).rejects.toThrow();
  });
  it("a credential setup failure is never a missing mapping", async () => {
    const s = await setup();
    await expect(s.mk(undefined, "key file not found").describe(target, "a.acme.com")).rejects.toThrow(/not found/);
    await expect(s.mk(undefined, "key file not found").remove(target, "a.acme.com")).rejects.toThrow(/not found/);
    await expect(s.mk(undefined, "already exists").create(target, "a.acme.com")).rejects.toThrow(/already exists/);
    await expect(
      s.mk(undefined, "does not appear to be verified").create(target, "a.acme.com"),
    ).rejects.not.toBeInstanceOf(MappingNotVerifiedError);
  });
  it("returns the parsed state", async () => {
    const s = await setup();
    const store = s.store;
    const run: CommandRunner = async (_c, args) =>
      args[2] === "domain-mappings"
        ? `WARNING: x\n${JSON.stringify({ status: { conditions: [{ type: "Ready", status: "True" }] } })}`
        : "";
    const crd = createCloudRunDomains({ store, run });
    expect(await crd.describe(target, "a.acme.com")).toEqual({ records: [], ready: true, message: "" });
  });
});

describe("create", () => {
  it("passes the service and tolerates already exists", async () => {
    const s = await setup();
    await s.mk().create(target, "a.acme.com");
    expect(s.domainCalls[0]).toEqual([
      "beta",
      "run",
      "domain-mappings",
      "create",
      "--service",
      "svc",
      "--domain",
      "a.acme.com",
      "--project",
      "p",
      "--region",
      "r",
    ]);
    await s.mk(() => "ERROR: Domain mapping already exists").create(target, "a.acme.com");
    await s.mk(() => "ALREADY_EXISTS").create(target, "a.acme.com");
  });
  it("throws MappingNotVerifiedError when the domain is not verified", async () => {
    const s = await setup();
    // gcloud's own refusal, then the server's (which can arrive as a 403).
    for (const msg of [
      "ERROR: (gcloud.beta.run.domain-mappings.create) The provided domain does not appear to be verified for the current account. To verify it, run:\n  $ gcloud domains verify acme.com",
      "ERROR: (gcloud.beta.run.domain-mappings.create) Caller is not authorized to administer the domain acme.com.",
      "ERROR: (gcloud.beta.run.domain-mappings.create) PERMISSION_DENIED: Caller is not authorized to administer the domain acme.com.",
    ]) {
      await expect(s.mk(() => msg).create(target, "a.acme.com")).rejects.toBeInstanceOf(MappingNotVerifiedError);
    }
  });
  it.each([
    "PERMISSION_DENIED: caller lacks roles/owner",
    "contact the project owner",
    "verify the API is enabled",
    "domain is not verified",
    "Caller is not authorized",
  ])("treats %j as an ordinary error", async (msg) => {
    const s = await setup();
    const err = await s
      .mk(() => msg)
      .create(target, "a.acme.com")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MappingNotVerifiedError);
  });
  it("matches already exists case-insensitively", async () => {
    const s = await setup();
    await s.mk(() => "Domain mapping Already Exists").create(target, "a.acme.com");
  });
  it("rethrows other failures", async () => {
    const s = await setup();
    await expect(s.mk(() => "quota exceeded").create(target, "a.acme.com")).rejects.toThrow(/quota/);
  });
});

describe("remove", () => {
  it("passes --quiet and tolerates not found", async () => {
    const s = await setup();
    await s.mk().remove(target, "a.acme.com");
    expect(s.domainCalls[0]).toEqual([
      "beta",
      "run",
      "domain-mappings",
      "delete",
      "--domain",
      "a.acme.com",
      "--project",
      "p",
      "--region",
      "r",
      "--quiet",
    ]);
    await s.mk(() => "Domain mapping could not be found").remove(target, "a.acme.com");
    await expect(s.mk(() => "boom").remove(target, "a.acme.com")).rejects.toThrow(/boom/);
  });
});

describe("a failure no matcher recognises falls back to listing the mappings", () => {
  const unknownText = "ERROR: (gcloud.beta.run.domain-mappings.delete) HTTPError 404: the requested entity is gone";
  const failsUnlessList = (args: string[]): string | null => (args[3] === "list" ? null : unknownText);
  const listCall = [
    "beta",
    "run",
    "domain-mappings",
    "list",
    "--project",
    "p",
    "--region",
    "r",
    "--format=value(metadata.name)",
  ];

  it("counts a host that isn't listed as not found", async () => {
    const s = await setup();
    await s.mk(failsUnlessList, undefined, "other.acme.com\n").remove(target, "a.acme.com");
    expect(s.domainCalls[1]).toEqual(listCall);
    expect(await s.mk(failsUnlessList, undefined, "other.acme.com\n").describe(target, "a.acme.com")).toBeNull();
    // An empty project lists nothing, and a host is matched whole.
    await s.mk(failsUnlessList).remove(target, "a.acme.com");
    await s.mk(failsUnlessList, undefined, "aa.acme.com\na.acme.com.evil\n").remove(target, "a.acme.com");
  });

  it("throws the original error when the host is listed", async () => {
    const s = await setup();
    const listed = "other.acme.com\r\na.acme.com\r\n";
    await expect(s.mk(failsUnlessList, undefined, listed).remove(target, "a.acme.com")).rejects.toThrow(unknownText);
    await expect(s.mk(failsUnlessList, undefined, listed).describe(target, "a.acme.com")).rejects.toThrow(unknownText);
  });

  it("throws the original error when the list fails too", async () => {
    const s = await setup();
    const both = (args: string[]): string => (args[3] === "list" ? "list exploded" : unknownText);
    await expect(s.mk(both).remove(target, "a.acme.com")).rejects.toThrow(unknownText);
    await expect(s.mk(both).describe(target, "a.acme.com")).rejects.toThrow(unknownText);
  });

  it("never lists after a credential setup failure", async () => {
    const s = await setup();
    await expect(s.mk(undefined, "key file unreadable").remove(target, "a.acme.com")).rejects.toThrow(/key file/);
    await expect(s.mk(undefined, "key file unreadable").describe(target, "a.acme.com")).rejects.toThrow(/key file/);
    expect(s.domainCalls).toEqual([]);
  });

  it("does not list when the wording is recognised", async () => {
    const s = await setup();
    await s.mk(() => "Domain mapping [a.acme.com] could not be found").remove(target, "a.acme.com");
    expect(s.domainCalls).toHaveLength(1);
  });
});

describe("mappingMissing", () => {
  const boom = async (): Promise<string> => {
    throw new Error("list failed");
  };
  it("is true for recognised wording without listing", async () => {
    expect(await mappingMissing("Domain mapping [a.acme.com] could not be found", "a.acme.com", boom)).toBe(true);
  });
  it("answers from the list otherwise, and is false when the list fails", async () => {
    expect(await mappingMissing("odd", "a.acme.com", async () => "b.acme.com\n")).toBe(true);
    expect(await mappingMissing("odd", "a.acme.com", async () => "a.acme.com\n")).toBe(false);
    expect(await mappingMissing("odd", "a.acme.com", boom)).toBe(false);
  });
});

describe("redaction", () => {
  it("never lets the key text out of an error", async () => {
    const s = await setup();
    const crd = s.mk(() => `failed with ${KEY}`);
    const err = await crd.create(target, "a.acme.com").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("SECRETBODY");
    expect((err as Error).message).not.toContain("private_key");
  });
});

describe("redaction of describe and remove", () => {
  it("scrubs the key", async () => {
    const s = await setup();
    for (const f of [
      (c: ReturnType<typeof s.mk>) => c.describe(target, "a.acme.com"),
      (c: ReturnType<typeof s.mk>) => c.remove(target, "a.acme.com"),
    ]) {
      const err = await f(s.mk(() => `failed with ${KEY}`)).catch((e: Error) => e);
      expect((err as Error).message).not.toContain("SECRETBODY");
    }
  });
});

describe("targetFor", () => {
  it("is null without a Cloud Run environment", async () => {
    const s = await setup();
    s.store.createEnvironment(s.project, "dev", "kubernetes", "{}");
    expect(s.mk().targetFor(s.project)).toBeNull();
  });
  it("names the Cloud Run service from the environment config", async () => {
    const s = await setup();
    const env = s.store.createEnvironment(
      s.project,
      "prod",
      "cloudrun",
      JSON.stringify({ project: "gp", region: "europe-west1", arRepo: "x" }),
    );
    expect(s.mk().targetFor(s.project)).toEqual({ project: "gp", region: "europe-west1", service: deployAppName(env) });
  });
});

describe("a keyless (wif) connection", () => {
  it("signs in with googleCredential's token exchange, never a key", async () => {
    const t = await setup();
    saveWifConnection(t.store, "p", "r");
    await t.mk().create(target, "a.example.com");
    const auth = t.calls.filter((c) => c[1] === "auth").map((c) => c.slice(1).join(" "));
    expect(auth.some((a) => a.startsWith("auth login --cred-file="))).toBe(true);
    expect(auth.some((a) => a.includes("activate-service-account"))).toBe(false);
  });
});
