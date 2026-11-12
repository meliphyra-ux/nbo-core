// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { serviceIdentityId, ensureServiceIdentity, grantInvoker } from "../iam.js";
import { buildDeployArgs, deploy, liveContentID } from "../deploy.js";
import { pushImage } from "../image.js";
import type { ToolContext } from "../run.js";

type Call = { cmd: string; args: string[]; env?: Record<string, string> };

function fake(answer: (cmd: string, args: string[], n: number) => string | Error = () => "") {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const ctx: ToolContext = {
    env: { CLOUDSDK_CONFIG: "/tmp/g" },
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts?.env });
      const r = answer(cmd, args, calls.length);
      if (r instanceof Error) throw r;
      return r;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { calls, sleeps, ctx };
}

describe("serviceIdentityId", () => {
  it("is nbo- plus 21 hex chars and stable", () => {
    const id = serviceIdentityId("p4715bebb-cloudrun-fn-ssr");
    expect(id).toMatch(/^nbo-[0-9a-f]{21}$/);
    expect(serviceIdentityId("p4715bebb-cloudrun-fn-ssr")).toBe(id);
    expect(serviceIdentityId("other")).not.toBe(id);
  });
});

describe("ensureServiceIdentity", () => {
  it("returns the email without creating when it exists", async () => {
    const { calls, ctx } = fake(() => "Warning: something\nemail: x\n");
    const email = await ensureServiceIdentity("acme", "svc", ctx);
    expect(email).toBe(`${serviceIdentityId("svc")}@acme.iam.gserviceaccount.com`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 3)).toEqual(["iam", "service-accounts", "describe"]);
    expect(calls[0]!.env).toEqual({ CLOUDSDK_CONFIG: "/tmp/g" });
  });

  it("creates it with a display name and no roles when missing", async () => {
    const { calls, ctx } = fake((_c, args) => (args[2] === "describe" ? new Error("NOT_FOUND: Unknown service account") : ""));
    await ensureServiceIdentity("acme", "svc", ctx);
    expect(calls).toHaveLength(2);
    const create = calls[1]!.args;
    expect(create.slice(0, 3)).toEqual(["iam", "service-accounts", "create"]);
    expect(create).toContain(serviceIdentityId("svc"));
    expect(create).toContain("NBO svc");
    expect(create.some((a) => a.includes("add-iam-policy-binding"))).toBe(false);
  });

  it("treats already exists on create as success", async () => {
    const { ctx } = fake((_c, args) => {
      if (args[2] === "describe") return new Error("NOT_FOUND");
      return new Error("ALREADY_EXISTS: Service account already exists");
    });
    await expect(ensureServiceIdentity("acme", "svc", ctx)).resolves.toContain("@acme.iam.gserviceaccount.com");
  });

  it("surfaces other errors", async () => {
    const { ctx } = fake(() => new Error("PERMISSION_DENIED"));
    await expect(ensureServiceIdentity("acme", "svc", ctx)).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

describe("grantInvoker", () => {
  it("carries ctx env and retries propagation with 2/4/8s backoff", async () => {
    const { calls, sleeps, ctx } = fake((_c, _a, n) => (n < 3 ? new Error("Service account nbo-x@acme.iam.gserviceaccount.com does not exist.") : ""));
    await grantInvoker("fn", "acme", "us-central1", "nbo-x@acme.iam.gserviceaccount.com", ctx);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 4000]);
    expect(calls[2]!.env).toEqual({ CLOUDSDK_CONFIG: "/tmp/g" });
  });

  it("retries the actAs permission error that shows while a new account propagates", async () => {
    const { calls, sleeps, ctx } = fake((_c, _a, n) =>
      n < 2 ? new Error("Permission 'iam.serviceaccounts.actAs' denied on service account nbo-x@p.iam.gserviceaccount.com (or it may not exist).") : "",
    );
    await grantInvoker("fn", "p", "r", "nbo-x@p.iam.gserviceaccount.com", ctx);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("gives up after four retries", async () => {
    const { calls, sleeps, ctx } = fake(() => new Error("service account does not exist"));
    await expect(grantInvoker("fn", "acme", "r", "e@x", ctx)).rejects.toThrow(/does not exist/);
    expect(calls).toHaveLength(5);
    expect(sleeps).toEqual([2000, 4000, 8000, 16000]);
  });
});

describe("deploy with a service account", () => {
  const spec = { serviceName: "svc", imageTag: "img", project: "acme", region: "r", contentID: "sha256:" + "a".repeat(64), allowUnauthenticated: false };

  it("adds --service-account and leaves other args untouched", () => {
    const base = buildDeployArgs(spec);
    const withSa = buildDeployArgs({ ...spec, serviceAccount: "nbo-x@acme.iam.gserviceaccount.com" });
    expect(withSa.slice(0, base.length)).toEqual(base);
    expect(withSa.slice(base.length)).toEqual(["--service-account", "nbo-x@acme.iam.gserviceaccount.com"]);
  });

  it("runs gcloud through ctx and tolerates warning lines before the describe JSON", async () => {
    const { calls, ctx } = fake((_c, args) => (args.includes("describe") ? `WARNING: x\n${JSON.stringify({ status: { url: "https://u" }, metadata: {} })}` : ""));
    const url = await deploy(spec, ctx);
    expect(url).toBe("https://u");
    expect(calls.every((c) => c.env?.CLOUDSDK_CONFIG === "/tmp/g")).toBe(true);
  });

  it("retries a deploy on a service account that has not propagated", async () => {
    const { calls, sleeps, ctx } = fake((_c, args, n) => {
      if (args.includes("describe")) return JSON.stringify({ status: { url: "https://u" }, metadata: {} });
      return n === 1 ? new Error("Service account nbo-x@acme.iam.gserviceaccount.com does not exist") : "";
    });
    await deploy({ ...spec, serviceAccount: "nbo-x@acme.iam.gserviceaccount.com" }, ctx);
    expect(sleeps).toEqual([2000]);
    expect(calls.filter((c) => c.args[1] === "deploy")).toHaveLength(2);
  });

  it("liveContentID treats a missing service as not live through ctx", async () => {
    const { ctx } = fake(() => new Error("ERROR: Cannot find service [svc]"));
    expect(await liveContentID("svc", "acme", "r", ctx)).toEqual({ id: "", ok: false });
  });
});

describe("pushImage with ctx", () => {
  it("tags and pushes through ctx with its env", async () => {
    const { calls, ctx } = fake();
    await pushImage("a:1", "reg/a:1", { ...ctx, env: { DOCKER_CONFIG: "/tmp/d" } });
    expect(calls.map((c) => c.args)).toEqual([
      ["tag", "a:1", "reg/a:1"],
      ["push", "reg/a:1"],
    ]);
    expect(calls[1]!.env).toEqual({ DOCKER_CONFIG: "/tmp/d" });
  });
});
