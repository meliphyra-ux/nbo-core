// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const targetCalls: unknown[][] = [];
const targets: { extraEnv: Record<string, string>; userEnv?: { vars: Record<string, string> }; appURL: string }[] = [];
const liveDeploy = async () => {
  targets.at(-1)!.appURL = "https://abc.lambda-url.eu-west-1.on.aws/";
  return { contentID: "sha256:" + "c".repeat(64), alreadyLive: false, url: "https://abc.lambda-url.eu-west-1.on.aws/" };
};
let deployImpl: () => Promise<unknown> = liveDeploy;
vi.mock("@nbo/deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nbo/deploy")>()),
  createLambdaTarget: vi.fn((...args: unknown[]) => {
    targetCalls.push(args);
    const t = { deployer: {}, extraEnv: {}, appURL: "" };
    targets.push(t);
    return t;
  }),
  deploy: vi.fn(async () => deployImpl()),
}));

const { createStore } = await import("../../store/store.js");
const { triggerDeploy } = await import("../deploy.js");
import type { Store } from "../../store/store.js";
import type { CommandRunner } from "@nbo/deploy";
import { KEY_ID, SECRET } from "../../clouds/__tests__/aws-fixture.js";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  targetCalls.length = 0;
  targets.length = 0;
  deployImpl = liveDeploy;
});

async function openStore(connected = true): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-deploy-lambda-"));
  const s = createStore(join(dir, "test.db"));
  s.setSecretKey(randomBytes(32));
  if (connected)
    s.saveAwsConnection(
      {
        region: "eu-west-1",
        accountId: "123456789012",
        repository: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/nbo",
      },
      { accessKeyId: KEY_ID, secretAccessKey: SECRET },
    );
  stores.push(s);
  return s;
}
async function nboDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-deploy-lambda-nbo-"));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));
  return dir;
}
function lambdaEnv(s: Store, region = "eu-west-1") {
  const p = s.createProject("shop");
  return s.createEnvironment(p.id, "lambda", "lambda", JSON.stringify({ region, cronsEnabled: true }));
}
const run: CommandRunner = async () => "";

describe("triggerDeploy (Lambda)", () => {
  it("deploys with the connection's key in the aws context and records the function URL without its slash", async () => {
    const s = await openStore();
    const env = lambdaEnv(s);
    s.setEnv({ projectId: env.projectId }, "API_URL", "https://api.example", false);
    const dep = await triggerDeploy({ store: s, mode: "production", run }, env.id, await nboDir());
    expect(dep.status).toBe("succeeded");
    expect(dep.url).toBe("https://abc.lambda-url.eu-west-1.on.aws");
    const [opts] = targetCalls[0] as [
      { ctx: { env: Record<string, string>; run: unknown }; accountId: string; repository: string },
    ];
    expect(opts.ctx.env).toMatchObject({
      AWS_ACCESS_KEY_ID: KEY_ID,
      AWS_SECRET_ACCESS_KEY: SECRET,
      AWS_REGION: "eu-west-1",
    });
    expect(opts.ctx.run).toBe(run);
    expect(opts.accountId).toBe("123456789012");
    expect(opts.repository).toBe("123456789012.dkr.ecr.eu-west-1.amazonaws.com/nbo");
    expect(Object.keys(targets[0]!.extraEnv)).toEqual(["NBO_CRON_SIGNING_SECRET"]);
    expect(targets[0]!.userEnv!.vars).toEqual({ API_URL: "https://api.example" });
  });

  it("refuses variables Lambda sets itself, naming them, before anything is deployed", async () => {
    const s = await openStore();
    const env = lambdaEnv(s);
    s.setEnv({ projectId: env.projectId }, "AWS_REGION", "us-east-1", false);
    s.setEnv({ projectId: env.projectId }, "AWS_LAMBDA_FUNCTION_NAME", "x", false);
    s.setEnv({ projectId: env.projectId }, "FINE", "x", false);
    await expect(triggerDeploy({ store: s, mode: "production", run }, env.id, await nboDir())).rejects.toThrow(
      "Lambda sets AWS_LAMBDA_FUNCTION_NAME, AWS_REGION itself",
    );
    expect(targetCalls).toHaveLength(0);
    expect(s.listDeployments(env.id)).toHaveLength(0);
  });

  it("refuses without an AWS connection, and in another region than the connection's", async () => {
    const none = await openStore(false);
    await expect(triggerDeploy({ store: none, run }, lambdaEnv(none).id, await nboDir())).rejects.toThrow(
      "AWS is not connected",
    );
    const s = await openStore();
    await expect(triggerDeploy({ store: s, run }, lambdaEnv(s, "us-east-1").id, await nboDir())).rejects.toThrow(
      "this environment runs in AWS region us-east-1 but NBO is connected to eu-west-1",
    );
    expect(targetCalls).toHaveLength(0);
  });

  it("keeps the key pair out of a recorded deploy error", async () => {
    const s = await openStore();
    const env = lambdaEnv(s);
    deployImpl = async () => {
      throw new Error(`push failed with ${KEY_ID} and ${SECRET}`);
    };
    const dep = await triggerDeploy({ store: s, mode: "production", run }, env.id, await nboDir());
    expect(dep.status).toBe("failed");
    expect(dep.error).not.toContain(SECRET);
    expect(dep.error).not.toContain(KEY_ID);
  });
});
