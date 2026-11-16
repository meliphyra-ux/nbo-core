// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, expect, it } from "vitest";
import { domainMappingRegions, listCloudRunRegions } from "../regions.js";

describe("listCloudRunRegions", () => {
  it("lists sorted regions flagged by domain-mapping support and passes ctx.env", async () => {
    const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    const run = async (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
      calls.push({ cmd, args, env: opts?.env });
      return "us-central1\nxx-test1\neurope-north1\n";
    };
    const out = await listCloudRunRegions(run, { env: { CLOUDSDK_CONFIG: "/tmp/x" } }, "my-proj");
    expect(out.map((r) => r.id)).toEqual(["europe-north1", "us-central1", "xx-test1"]);
    expect(out.find((r) => r.id === "us-central1")?.domainMapping).toBe(true);
    expect(out.find((r) => r.id === "xx-test1")?.domainMapping).toBe(false);
    expect(calls[0].cmd).toBe("gcloud");
    expect(calls[0].args).toEqual(["run", "regions", "list", "--project", "my-proj", "--format=value(locationId)"]);
    expect(calls[0].env).toEqual({ CLOUDSDK_CONFIG: "/tmp/x" });
  });

  it("records provenance", () => {
    expect(domainMappingRegions.source).toBe("https://cloud.google.com/run/docs/mapping-custom-domains");
    expect(domainMappingRegions.takenOn).toBe("2026-11-03");
    expect(domainMappingRegions.regions).toContain("us-central1");
  });
});

describe("listCloudRunRegions with merged stderr", () => {
  it("drops warning lines and dedupes", async () => {
    const run = async () =>
      "WARNING: gcloud update available\nus-central1\n\nus-central1\nUpdates are available for some Google Cloud CLI components.\neurope-north1\n";
    const out = await listCloudRunRegions(run, {}, "p");
    expect(out.map((r) => r.id)).toEqual(["europe-north1", "us-central1"]);
  });
});
