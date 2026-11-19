// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import {
  buildDeployArgs,
  contentIDLabel,
  isServiceNotFound,
  extractContentIDLabel,
  deleteService,
  serviceLabels,
  isIsrcacheServiceOf,
  isrcacheServiceLabels,
} from "../deploy.js";

describe("buildDeployArgs", () => {
  it("includes --memory and --timeout when resources are set", () => {
    const args = buildDeployArgs({
      serviceName: "svc",
      imageTag: "img",
      project: "p",
      region: "r",
      contentID: "sha256:aaaa111122223333444455556666777788889999000011112222333344445555",
      allowUnauthenticated: true,
      memoryMB: 1024,
      maxDurationSec: 120,
    });
    const joined = args.join(" ");
    expect(joined).toContain("--memory 1024Mi");
    expect(joined).toContain("--timeout 120");
  });

  it("omits --memory/--timeout flags when resources are not set", () => {
    const args = buildDeployArgs({
      serviceName: "svc",
      imageTag: "img",
      project: "p",
      region: "r",
      contentID: "sha256:aaaa111122223333444455556666777788889999000011112222333344445555",
      allowUnauthenticated: true,
    });
    const joined = args.join(" ");
    expect(joined).not.toContain("--memory");
    expect(joined).not.toContain("--timeout");
  });
});

describe("contentIDLabel", () => {
  it("strips the prefix and fits GCP's label limit", () => {
    const label = contentIDLabel("sha256:4b66654e468e0ed5a8fb3146fff2ca53131bafe78366b02e753b059ea5fca7d1");
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toBe("4b66654e468e0ed5a8fb3146fff2ca53");
    expect(label).toMatch(/^[a-z0-9]+$/);
  });

  it("is deterministic for the same input", () => {
    const a = contentIDLabel("sha256:aaaa111122223333444455556666777788889999000011112222333344445555");
    const b = contentIDLabel("sha256:aaaa111122223333444455556666777788889999000011112222333344445555");
    expect(a).toBe(b);
  });
});

describe("extractContentIDLabel", () => {
  it("returns the label and ok=true when it's present", () => {
    const got = extractContentIDLabel({ status: { url: "" }, metadata: { labels: { "nbo-content-id": "abc123" } } });
    expect(got).toEqual({ id: "abc123", ok: true });
  });

  it("returns ok=false, not a thrown error, when the service has no labels at all", () => {
    const got = extractContentIDLabel({ status: { url: "" }, metadata: {} });
    expect(got).toEqual({ id: "", ok: false });
  });
});

describe("isServiceNotFound", () => {
  it("matches gcloud's real pinned error text", () => {
    const real = "ERROR: (gcloud.run.services.describe) Cannot find service [next-app]\n";
    expect(isServiceNotFound(real)).toBe(true);
  });

  it("does not match an unrelated error", () => {
    const other = "ERROR: (gcloud.run.services.describe) PERMISSION_DENIED: some other failure";
    expect(isServiceNotFound(other)).toBe(false);
  });
});

describe("extractContentIDLabel fingerprint", () => {
  it("returns the nbo-env label as the fingerprint when present", () => {
    const got = extractContentIDLabel({
      status: { url: "" },
      metadata: { labels: { "nbo-content-id": "abc", "nbo-env": "f00d" } },
    });
    expect(got).toEqual({ id: "abc", ok: true, fingerprint: "f00d" });
  });

  it("omits the fingerprint when the label is absent", () => {
    const got = extractContentIDLabel({ status: { url: "" }, metadata: { labels: { "nbo-content-id": "abc" } } });
    expect(got.fingerprint).toBeUndefined();
  });
});

describe("buildDeployArgs scaling and cpu", () => {
  const base = {
    serviceName: "svc",
    imageTag: "img",
    project: "p",
    region: "r",
    contentID: "0123456789ab",
    allowUnauthenticated: false,
  };

  it("renders --min-instances, --max-instances, --concurrency and --cpu when set", () => {
    const args = buildDeployArgs({ ...base, minInstances: 0, maxInstances: 1, concurrency: 250, cpu: "1" });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("--min-instances")).toBe("0");
    expect(at("--max-instances")).toBe("1");
    expect(at("--concurrency")).toBe("250");
    expect(at("--cpu")).toBe("1");
  });

  it("opens a public service by turning off the invoker check, not by granting allUsers", () => {
    // Domain restricted sharing (on by default in new Google Workspace organisations) refuses an
    // allUsers grant, and gcloud still reports the deploy as done: the site then answers 403.
    const args = buildDeployArgs({ ...base, allowUnauthenticated: true });
    expect(args).toContain("--no-invoker-iam-check");
    expect(args).not.toContain("--allow-unauthenticated");
    expect(args).not.toContain("--no-allow-unauthenticated");
  });

  it("renders none of them when absent, so existing services' arguments don't change", () => {
    const args = buildDeployArgs(base);
    for (const flag of ["--min-instances", "--max-instances", "--concurrency", "--cpu", "--execution-environment"])
      expect(args).not.toContain(flag);
    expect(args).toEqual([
      "run",
      "deploy",
      "svc",
      "--image",
      "img",
      "--project",
      "p",
      "--region",
      "r",
      "--labels",
      "nbo-content-id=0123456789ab",
      "--quiet",
      "--no-allow-unauthenticated",
    ]);
  });
});

describe("deleteService", () => {
  it("deletes the named service quietly", async () => {
    const calls: string[][] = [];
    await deleteService("svc-isr", "p", "r", { run: async (_cmd, args) => (calls.push(args), "") });
    expect(calls).toEqual([["run", "services", "delete", "svc-isr", "--project", "p", "--region", "r", "--quiet"]]);
  });

  it("treats a service that is already gone as deleted", async () => {
    const run = async (): Promise<string> => {
      throw new Error("ERROR: (gcloud.run.services.delete) Cannot find service [svc-isr]");
    };
    await expect(deleteService("svc-isr", "p", "r", { run })).resolves.toBeUndefined();
  });

  it("passes any other failure through", async () => {
    const run = async (): Promise<string> => {
      throw new Error("ERROR: PERMISSION_DENIED");
    };
    await expect(deleteService("svc-isr", "p", "r", { run })).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

describe("ISR cache labels and execution environment", () => {
  const base = {
    serviceName: "a-isr",
    imageTag: "img",
    project: "p",
    region: "r",
    contentID: "0123456789ab",
    allowUnauthenticated: false,
  };

  it("renders --execution-environment and extra labels after NBO's own", () => {
    const args = buildDeployArgs({
      ...base,
      executionEnvironment: "gen1",
      fnConfig: "f".repeat(32),
      labels: isrcacheServiceLabels("a"),
    });
    expect(args[args.indexOf("--execution-environment") + 1]).toBe("gen1");
    expect(args[args.indexOf("--labels") + 1]).toBe(
      `nbo-content-id=0123456789ab,nbo-fn-config=${"f".repeat(32)},nbo-role=isrcache,nbo-app=a`,
    );
  });

  it("isIsrcacheServiceOf needs both labels, for this app", () => {
    expect(isIsrcacheServiceOf({ "nbo-role": "isrcache", "nbo-app": "a" }, "a")).toBe(true);
    expect(isIsrcacheServiceOf({ "nbo-role": "isrcache", "nbo-app": "b" }, "a")).toBe(false);
    expect(isIsrcacheServiceOf({ "nbo-app": "a" }, "a")).toBe(false);
    expect(isIsrcacheServiceOf({}, "a")).toBe(false);
    expect(isIsrcacheServiceOf(undefined, "a")).toBe(false);
  });

  it("serviceLabels reads labels past warnings, undefined for a missing service, throws otherwise", async () => {
    const ok = async () => `WARNING: x\n${JSON.stringify({ metadata: { labels: { "nbo-role": "isrcache" } } })}`;
    await expect(serviceLabels("a-isr", "p", "r", { run: ok })).resolves.toEqual({ "nbo-role": "isrcache" });
    const none = async () => JSON.stringify({ metadata: {} });
    await expect(serviceLabels("a-isr", "p", "r", { run: none })).resolves.toEqual({});
    const missing = async (): Promise<string> => {
      throw new Error("ERROR: (gcloud.run.services.describe) Cannot find service [a-isr]");
    };
    await expect(serviceLabels("a-isr", "p", "r", { run: missing })).resolves.toBeUndefined();
    const denied = async (): Promise<string> => {
      throw new Error("ERROR: PERMISSION_DENIED");
    };
    await expect(serviceLabels("a-isr", "p", "r", { run: denied })).rejects.toThrow(/PERMISSION_DENIED/);
  });
});
