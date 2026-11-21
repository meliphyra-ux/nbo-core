// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createStore, type Store } from "../../store/store.js";
import { awsBoundaryPolicy, awsCredentials, awsIamPolicy, awsIamPolicyFor, createAwsConnect } from "../aws-connect.js";
import { NO_AWS_FILE } from "@nbo/adapter-lambda";
import { KEY_ID, SECRET, fakeAws, type Call } from "./aws-fixture.js";

const openStores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of openStores.splice(0)) s.close();
});

async function openStore(): Promise<{ store: Store; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-aws-"));
  const path = join(dir, "t.db");
  const store = createStore(path, { secretKey: randomBytes(32) });
  openStores.push(store);
  return { store, path };
}

const req = { accessKeyId: KEY_ID, secretAccessKey: SECRET, region: "eu-west-1" };

// Review Focus 1: the key pair reaches aws only through the environment.
function expectEnvOnly(calls: Call[]): void {
  for (const c of calls) {
    expect(c.cmd).toBe("aws");
    expect(c.args.join(" ")).not.toContain(SECRET);
    expect(c.args.join(" ")).not.toContain(KEY_ID);
    expect(c.env).toEqual({
      AWS_ACCESS_KEY_ID: KEY_ID,
      AWS_SECRET_ACCESS_KEY: SECRET,
      AWS_REGION: "eu-west-1",
      AWS_PAGER: "",
      AWS_CONFIG_FILE: NO_AWS_FILE,
      AWS_SHARED_CREDENTIALS_FILE: NO_AWS_FILE,
    });
  }
}

function spyLogs(): () => string {
  const spies = (["log", "warn", "error", "info"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  return () => spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" "))).join("\n");
}

describe("aws connect", () => {
  it("checks the key, creates the nbo repository and saves the connection sealed", async () => {
    const { store, path } = await openStore();
    const f = fakeAws();
    const conn = await createAwsConnect({ store, run: f.run }).connect(req);
    expect(conn).toMatchObject({
      kind: "aws",
      region: "eu-west-1",
      accountId: "123456789012",
      repository: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/nbo",
      status: "connected",
    });
    expect(f.lines()).toEqual([
      "sts get-caller-identity --output json",
      "ecr describe-repositories --repository-names nbo --output json",
      "ecr create-repository --repository-name nbo --image-scanning-configuration scanOnPush=true --output json",
    ]);
    expectEnvOnly(f.calls);
    expect(store.getAwsSecrets()).toEqual({ accessKeyId: KEY_ID, secretAccessKey: SECRET });
    expect(awsCredentials(store)).toEqual(req);
    const raw = new DatabaseSync(path);
    expect(JSON.stringify(raw.prepare("SELECT * FROM connections").all())).not.toContain(SECRET);
    raw.close();
  });

  it("reuses an existing repository, and a create that lost a race", async () => {
    const { store } = await openStore();
    const found = fakeAws((l) =>
      l.startsWith("ecr describe") ? '{"repositories":[{"repositoryName":"nbo"}]}' : undefined,
    );
    await createAwsConnect({ store, run: found.run }).connect(req);
    expect(found.lines().some((l) => l.includes("create-repository"))).toBe(false);
    const raced = fakeAws((l) =>
      l.startsWith("ecr create") ? new Error("An error occurred (RepositoryAlreadyExistsException)") : undefined,
    );
    await expect(createAwsConnect({ store, run: raced.run }).connect(req)).resolves.toMatchObject({ kind: "aws" });
  });

  it("refuses malformed input before calling aws", async () => {
    const { store } = await openStore();
    const f = fakeAws();
    const c = createAwsConnect({ store, run: f.run });
    await expect(c.connect({ ...req, accessKeyId: "ASIAABCDEFGHIJKLMNOP" })).rejects.toThrow(/AKIA/);
    await expect(c.connect({ ...req, region: "eu-west-1; rm" })).rejects.toThrow(/region/);
    await expect(c.connect({ ...req, secretAccessKey: "has space" })).rejects.toThrow(/secretAccessKey/);
    expect(f.calls).toEqual([]);
  });

  it("never lets the key pair into an error, a log line or the stored check", async () => {
    const { store } = await openStore();
    const logs = spyLogs();
    const echo = (l: string) =>
      l.startsWith("sts") ? new Error(`aws ${l} failed:\nAccessDenied for ${KEY_ID} signed with ${SECRET}`) : undefined;
    const err = (await createAwsConnect({ store, run: fakeAws(echo).run })
      .connect(req)
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/AWS refused checking the access key/);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain(KEY_ID);
    expect(store.getAwsConnection()).toBeNull();

    await createAwsConnect({ store, run: fakeAws().run }).connect(req);
    const t = await createAwsConnect({ store, run: fakeAws(echo).run })
      .test()
      .catch((e: unknown) => e);
    expect(String(t)).not.toContain(SECRET);
    expect(store.getAwsConnection()!.status).toBe("failing");
    expect(store.getAwsConnection()!.lastError).toContain("[redacted]");
    expect(store.getAwsConnection()!.lastError).not.toContain(SECRET);
    expect(logs()).not.toContain(SECRET);
  });

  it("says when the aws CLI is missing", async () => {
    const { store } = await openStore();
    const f = fakeAws(() => Object.assign(new Error("spawn aws ENOENT"), { code: "ENOENT" }));
    await expect(createAwsConnect({ store, run: f.run }).connect(req)).rejects.toThrow(
      "the aws CLI is not installed in the NBO container",
    );
  });

  it("test re-checks the stored key and repository, and notices another account", async () => {
    const { store } = await openStore();
    await createAwsConnect({ store, run: fakeAws().run }).connect(req);
    const ok = fakeAws((l) => (l.startsWith("ecr describe") ? '{"repositories":[]}' : undefined));
    expect(await createAwsConnect({ store, run: ok.run }).test()).toMatchObject({ status: "connected" });
    expect(ok.lines()).toEqual([
      "sts get-caller-identity --output json",
      "ecr describe-repositories --repository-names nbo --output json",
    ]);
    expectEnvOnly(ok.calls);
    const other = fakeAws(() => undefined, "999999999999");
    await expect(createAwsConnect({ store, run: other.run }).test()).rejects.toThrow(/999999999999/);
    expect(store.getAwsConnection()!.status).toBe("failing");
  });

  it("refuses a replace that moves the account or region while Lambda environments use it", async () => {
    const { store, path } = await openStore();
    await createAwsConnect({ store, run: fakeAws().run }).connect(req);
    const p = store.createProject("web");
    const env = store.createEnvironment(p.id, "lambda", "cloudrun");
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE environments SET target = 'lambda' WHERE id = ?").run(env.id);
    raw.close();
    const c = createAwsConnect({ store, run: fakeAws(() => undefined, "999999999999").run });
    await expect(c.connect(req)).rejects.toThrow(/web/);
    await expect(
      createAwsConnect({ store, run: fakeAws().run }).connect({ ...req, region: "us-east-1" }),
    ).rejects.toThrow(/web/);
    // The same account and region: a key rotation goes through.
    await expect(createAwsConnect({ store, run: fakeAws().run }).connect(req)).resolves.toMatchObject({ kind: "aws" });
    expect(store.getAwsConnection()!.region).toBe("eu-west-1");
  });
});

describe("the IAM policy", () => {
  it("scopes every grant to the account, the region, the nbo repository and /nbo/ roles", () => {
    const text = JSON.stringify(awsIamPolicyFor("eu-west-1", "123456789012"));
    expect(text).not.toMatch(/<region>|<account>/);
    const statements = awsIamPolicyFor("eu-west-1", "123456789012").Statement;
    const byAction = (a: string) => statements.filter((s) => ([] as string[]).concat(s.Action).includes(a));
    expect(byAction("lambda:CreateFunction")[0]!.Resource).toBe("arn:aws:lambda:eu-west-1:123456789012:function:nbo-*");
    expect(byAction("ecr:PutImage")[0]!.Resource).toBe("arn:aws:ecr:eu-west-1:123456789012:repository/nbo");
    expect(byAction("iam:PassRole")[0]!.Resource).toBe("arn:aws:iam::123456789012:role/nbo/*");
    expect(byAction("ecr:GetAuthorizationToken")[0]!.Resource).toBe("*");
    expect(byAction("sts:GetCallerIdentity")[0]!.Resource).toBe("*");
    // Only the token, identity and function-listing calls are account-wide.
    for (const s of statements)
      if (s.Resource === "*")
        expect(([] as string[]).concat(s.Action).sort()).toEqual([
          "ecr:GetAuthorizationToken",
          "lambda:ListFunctions",
          "sts:GetCallerIdentity",
        ]);
    expect(JSON.stringify(awsIamPolicy)).toContain("<account>");
  });

  // Review I3: a holder of NBO's key must not be able to make a role with more than the boundary allows.
  it("lets NBO make, change and pass /nbo/ roles only within the nbo-boundary permissions boundary", () => {
    const statements = awsIamPolicyFor("eu-west-1", "123456789012").Statement;
    const boundary = "arn:aws:iam::123456789012:policy/nbo-boundary";
    const byAction = (a: string) => statements.filter((s) => ([] as string[]).concat(s.Action).includes(a));
    for (const a of ["iam:CreateRole", "iam:PutRolePolicy", "iam:PutRolePermissionsBoundary", "iam:AttachRolePolicy"]) {
      expect(byAction(a)).toHaveLength(1);
      expect(byAction(a)[0]!.Resource).toBe("arn:aws:iam::123456789012:role/nbo/*");
      expect(byAction(a)[0]!.Condition).toMatchObject({ StringEquals: { "iam:PermissionsBoundary": boundary } });
    }
    expect(byAction("iam:AttachRolePolicy")[0]!.Condition).toMatchObject({
      StringEquals: { "iam:PolicyARN": "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" },
    });
    expect(byAction("iam:PassRole")[0]!.Condition).toEqual({
      StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" },
    });
    // Nothing may change or remove a boundary, or edit a managed policy.
    for (const a of ["iam:DeleteRolePermissionsBoundary", "iam:CreatePolicyVersion", "iam:UpdateAssumeRolePolicy"])
      expect(byAction(a)).toEqual([]);
    // Every other IAM grant only cleans up.
    for (const s of statements) {
      const iam = ([] as string[]).concat(s.Action).filter((a) => a.startsWith("iam:"));
      if (iam.length && !s.Condition)
        expect(iam.sort()).toEqual(["iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy"]);
    }
  });

  it("the boundary allows only logs and calling NBO's own functions", () => {
    const b = awsIamPolicyFor("eu-west-1", "123456789012", awsBoundaryPolicy).Statement;
    expect(b.flatMap((s) => ([] as string[]).concat(s.Action)).sort()).toEqual([
      "lambda:InvokeFunction",
      "lambda:InvokeFunctionUrl",
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]);
    expect(b.find((s) => s.Sid === "NboInvoke")!.Resource).toBe("arn:aws:lambda:eu-west-1:123456789012:function:nbo-*");
  });
});
