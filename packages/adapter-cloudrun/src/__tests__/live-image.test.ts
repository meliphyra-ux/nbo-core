// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { liveServiceState, functionDeployConfigHash, buildDeployArgs, type DeploySpec } from "../deploy.js";
import { serviceIdentityEmail, serviceIdentityId } from "../iam.js";
import type { CommandRunner } from "../run.js";

function recorder(answer: () => string | Error) {
  const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const a = answer();
    if (a instanceof Error) throw a;
    return a;
  };
  return { calls, run };
}

function describeJSON(
  o: {
    image?: string;
    url?: string;
    labels?: Record<string, string>;
    ready?: string;
    latestReady?: string;
    latestCreated?: string;
  } = {},
) {
  return JSON.stringify({
    metadata: { labels: o.labels ?? { "nbo-fn-config": "cfg" } },
    spec: { template: { spec: { containers: [{ image: o.image ?? "repo/img:1" }] } } },
    status: {
      url: o.url ?? "https://s.run.app",
      latestReadyRevisionName: o.latestReady ?? "s-00002",
      latestCreatedRevisionName: o.latestCreated ?? "s-00002",
      conditions: [
        { type: "ConfigurationsReady", status: "True" },
        { type: "Ready", status: o.ready ?? "True" },
      ],
    },
  });
}

describe("liveServiceState", () => {
  it("reads image, URL, config label and readiness in one describe call, with the context's env", async () => {
    const { calls, run } = recorder(() => describeJSON());
    const got = await liveServiceState("s", "proj", "us-central1", { env: { CLOUDSDK_CONFIG: "/tmp/g" }, run });
    expect(got).toEqual({
      image: "repo/img:1",
      url: "https://s.run.app",
      config: "cfg",
      fingerprint: "",
      secretEnvNames: [],
      ready: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "run",
      "services",
      "describe",
      "s",
      "--project",
      "proj",
      "--region",
      "us-central1",
      "--format=json",
    ]);
    expect(calls[0]!.env).toEqual({ CLOUDSDK_CONFIG: "/tmp/g" });
  });

  it("tolerates stderr lines merged into the output", async () => {
    const { run } = recorder(() => `WARNING: Python 3.8 is deprecated\n${describeJSON()}\nUpdates are available\n`);
    await expect(liveServiceState("s", "p", "r", { run })).resolves.toMatchObject({ image: "repo/img:1", ready: true });
  });

  it("is not ready when the Ready condition is not True", async () => {
    const { run } = recorder(() => describeJSON({ ready: "False" }));
    await expect(liveServiceState("s", "p", "r", { run })).resolves.toMatchObject({ ready: false });
  });

  it("is not ready when the latest created revision never became ready", async () => {
    const { run } = recorder(() => describeJSON({ latestReady: "s-00001", latestCreated: "s-00002" }));
    await expect(liveServiceState("s", "p", "r", { run })).resolves.toMatchObject({ ready: false });
  });

  it("reports an empty config for a service without the label", async () => {
    const { run } = recorder(() => describeJSON({ labels: {} }));
    await expect(liveServiceState("s", "p", "r", { run })).resolves.toMatchObject({ config: "" });
  });

  it("is undefined for a missing service, a failed describe, or unparsable output", async () => {
    await expect(
      liveServiceState("s", "p", "r", {
        run: recorder(() => new Error("ERROR: (gcloud.run.services.describe) Cannot find service [s]")).run,
      }),
    ).resolves.toBeUndefined();
    await expect(
      liveServiceState("s", "p", "r", { run: recorder(() => new Error("permission denied")).run }),
    ).resolves.toBeUndefined();
    await expect(liveServiceState("s", "p", "r", { run: recorder(() => "WARNING: x\n").run })).resolves.toBeUndefined();
  });
});

describe("function deploy config", () => {
  const spec: DeploySpec = {
    serviceName: "a-fn-ssr",
    imageTag: "repo/nbo-fn-a-ssr:0123",
    project: "p",
    region: "r",
    contentID: "sha256:" + "0".repeat(64),
    allowUnauthenticated: false,
  };

  it("hashes to a valid GCP label value, independent of fnConfig itself", () => {
    const h = functionDeployConfigHash(spec, "app@p.iam.gserviceaccount.com");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(functionDeployConfigHash({ ...spec, fnConfig: "x" }, "app@p.iam.gserviceaccount.com")).toBe(h);
  });

  it("changes with deploy flags, the service account, and the invoker member", () => {
    const h = functionDeployConfigHash(spec, "app@p.iam.gserviceaccount.com");
    expect(functionDeployConfigHash({ ...spec, memoryMB: 1024 }, "app@p.iam.gserviceaccount.com")).not.toBe(h);
    expect(functionDeployConfigHash({ ...spec, maxDurationSec: 60 }, "app@p.iam.gserviceaccount.com")).not.toBe(h);
    expect(
      functionDeployConfigHash(
        { ...spec, serviceAccount: "fn@p.iam.gserviceaccount.com" },
        "app@p.iam.gserviceaccount.com",
      ),
    ).not.toBe(h);
    expect(
      functionDeployConfigHash({ ...spec, imageTag: "repo/nbo-fn-a-ssr:9999" }, "app@p.iam.gserviceaccount.com"),
    ).not.toBe(h);
    expect(functionDeployConfigHash(spec, "123-compute@developer.gserviceaccount.com")).not.toBe(h);
  });

  it("buildDeployArgs writes fnConfig as the nbo-fn-config label next to the content id", () => {
    const args = buildDeployArgs({ ...spec, fnConfig: "abc" });
    expect(args[args.indexOf("--labels") + 1]).toBe(`nbo-content-id=${"0".repeat(32)},nbo-fn-config=abc`);
    const plain = buildDeployArgs(spec);
    expect(plain[plain.indexOf("--labels") + 1]).toBe(`nbo-content-id=${"0".repeat(32)}`);
  });

  it("serviceIdentityEmail is the account ensureServiceIdentity creates", () => {
    expect(serviceIdentityEmail("acme", "a-fn-ssr")).toBe(
      `${serviceIdentityId("a-fn-ssr")}@acme.iam.gserviceaccount.com`,
    );
  });
});

describe("environment fingerprint label", () => {
  const spec: DeploySpec = {
    serviceName: "a",
    imageTag: "repo/nbo-app-a:0123",
    project: "p",
    region: "r",
    contentID: "sha256:" + "0".repeat(64),
    allowUnauthenticated: true,
  };

  it("buildDeployArgs writes envFingerprint as the nbo-env label, only when given", () => {
    const args = buildDeployArgs({ ...spec, envFingerprint: "f00d" });
    expect(args[args.indexOf("--labels") + 1]).toBe(`nbo-content-id=${"0".repeat(32)},nbo-env=f00d`);
    const plain = buildDeployArgs(spec);
    expect(plain[plain.indexOf("--labels") + 1]).toBe(`nbo-content-id=${"0".repeat(32)}`);
  });

  it("changes the function config hash; absent leaves it unchanged", () => {
    const h = functionDeployConfigHash(spec, "m");
    expect(functionDeployConfigHash({ ...spec, envFingerprint: undefined }, "m")).toBe(h);
    expect(functionDeployConfigHash({ ...spec, envFingerprint: "f00d" }, "m")).not.toBe(h);
  });
});
