// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { awsContext, awsJson, BOUNDARY_POLICY, type AwsCredentials } from "@nbo/adapter-lambda";
import type { CommandRunner } from "@nbo/deploy";
import { ErrInvalid } from "../store/errors.js";
import type { Store } from "../store/store.js";
import type { AwsConnection } from "./connections.js";
import { partialConnectNote } from "./cloud-setup.js";

export interface AwsConnect {
  // connect checks the key pair, makes the nbo repository and saves the
  // connection; called again, it replaces the key pair.
  connect(req: AwsCredentials): Promise<AwsConnection>;
  test(): Promise<AwsConnection>;
}

const REPOSITORY = "nbo";

const BOUNDARY_ARN = `arn:aws:iam::<account>:policy/${BOUNDARY_POLICY}`;
const BASIC_EXECUTION = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";

// awsIamPolicy: the least-privilege policy for the IAM user whose key NBO
// keeps, with <region> and <account> to fill in (awsIamPolicyFor). Lambda
// functions named nbo-* and their URLs, the nbo ECR repository, execution
// roles under the path /nbo/ that carry the nbo-boundary permissions
// boundary (awsBoundaryPolicy, made by the person connecting; NBO can't
// change it), PassRole to Lambda only, and the identity check. So whoever
// holds the key can't make a role worth more than the boundary.
export const awsIamPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "NboLambda",
      Effect: "Allow",
      Action: [
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:CreateFunctionUrlConfig",
        "lambda:UpdateFunctionUrlConfig",
        "lambda:GetFunctionUrlConfig",
        "lambda:DeleteFunctionUrlConfig",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:GetPolicy",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:ListTags",
      ],
      Resource: "arn:aws:lambda:<region>:<account>:function:nbo-*",
    },
    {
      Sid: "NboRepository",
      Effect: "Allow",
      Action: [
        "ecr:DescribeRepositories",
        "ecr:CreateRepository",
        "ecr:DescribeImages",
        "ecr:ListImages",
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchDeleteImage",
        // Lambda grants itself pull access on the repository at create time.
        "ecr:GetRepositoryPolicy",
        "ecr:SetRepositoryPolicy",
      ],
      Resource: "arn:aws:ecr:<region>:<account>:repository/nbo",
    },
    {
      Sid: "NboRoles",
      Effect: "Allow",
      Action: ["iam:CreateRole", "iam:PutRolePolicy", "iam:PutRolePermissionsBoundary"],
      Resource: "arn:aws:iam::<account>:role/nbo/*",
      Condition: { StringEquals: { "iam:PermissionsBoundary": BOUNDARY_ARN } },
    },
    {
      Sid: "NboRoleLogs",
      Effect: "Allow",
      Action: "iam:AttachRolePolicy",
      Resource: "arn:aws:iam::<account>:role/nbo/*",
      Condition: { StringEquals: { "iam:PermissionsBoundary": BOUNDARY_ARN, "iam:PolicyARN": BASIC_EXECUTION } },
    },
    {
      Sid: "NboRoleCleanup",
      Effect: "Allow",
      Action: ["iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy"],
      Resource: "arn:aws:iam::<account>:role/nbo/*",
    },
    {
      Sid: "NboPassRole",
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: "arn:aws:iam::<account>:role/nbo/*",
      Condition: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } },
    },
    {
      Sid: "NboAccountWide",
      Effect: "Allow",
      // lambda:ListFunctions takes no resource: teardown lists to find an app's functions.
      Action: ["ecr:GetAuthorizationToken", "lambda:ListFunctions", "sts:GetCallerIdentity"],
      Resource: "*",
    },
  ],
} as const;

// awsBoundaryPolicy: the managed policy nbo-boundary, the permissions
// boundary of every role NBO makes: logs, and calling NBO's own functions.
export const awsBoundaryPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "NboLogs",
      Effect: "Allow",
      Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: "arn:aws:logs:<region>:<account>:*",
    },
    {
      Sid: "NboInvoke",
      Effect: "Allow",
      Action: ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"],
      Resource: "arn:aws:lambda:<region>:<account>:function:nbo-*",
    },
  ],
} as const;

type Policy = {
  Version: string;
  Statement: { Sid: string; Action: string | string[]; Resource: string; Condition?: Record<string, unknown> }[];
};

// awsIamPolicyFor fills in the region and account (placeholders stay when unknown).
export function awsIamPolicyFor(
  region?: string,
  account?: string,
  policy: typeof awsIamPolicy | typeof awsBoundaryPolicy = awsIamPolicy,
): Policy {
  let text = JSON.stringify(policy);
  if (region) text = text.replaceAll("<region>", region);
  if (account) text = text.replaceAll("<account>", account);
  return JSON.parse(text) as Policy;
}

export const validAwsRegion = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
export const validAwsAccount = /^\d{12}$/;

// awsCredentials: the stored key pair and region, for every aws call.
export function awsCredentials(store: Store): AwsCredentials {
  const conn = store.getAwsConnection();
  if (!conn) throw new ErrInvalid("AWS is not connected");
  const { accessKeyId, secretAccessKey } = store.getAwsSecrets();
  return { accessKeyId, secretAccessKey, region: conn.region };
}

function validate(req: AwsCredentials): void {
  if (typeof req.accessKeyId !== "string" || !/^AKIA[A-Z0-9]{16}$/.test(req.accessKeyId))
    throw new ErrInvalid("accessKeyId must be an IAM user's access key id (AKIA and 16 letters or digits)");
  if (typeof req.secretAccessKey !== "string" || !/^[\x21-\x7e]{16,128}$/.test(req.secretAccessKey))
    throw new ErrInvalid("secretAccessKey must be the access key's secret (no spaces)");
  if (typeof req.region !== "string" || !validAwsRegion.test(req.region))
    throw new ErrInvalid("region must be an AWS region such as eu-west-1");
}

export function createAwsConnect(deps: { store: Store; run: CommandRunner }): AwsConnect {
  const { store, run } = deps;

  // step names what failed; aws() has already taken the key pair out of the text.
  async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT")
        throw new Error("the aws CLI is not installed in the NBO container", { cause: err });
      throw new Error(`AWS refused ${name}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  async function check(creds: AwsCredentials): Promise<string> {
    const ctx = awsContext(creds, run);
    const { Account } = await step("checking the access key", () =>
      awsJson<{ Account?: unknown }>(ctx, ["sts", "get-caller-identity"]),
    );
    if (typeof Account !== "string" || !validAwsAccount.test(Account))
      throw new Error("AWS answered the identity check without an account id");
    await step(`creating the ECR repository ${REPOSITORY}`, async () => {
      try {
        await awsJson(ctx, ["ecr", "describe-repositories", "--repository-names", REPOSITORY]);
      } catch (err) {
        if (!/RepositoryNotFoundException/.test(String(err))) throw err;
        try {
          await awsJson(ctx, [
            "ecr",
            "create-repository",
            "--repository-name",
            REPOSITORY,
            "--image-scanning-configuration",
            "scanOnPush=true",
          ]);
        } catch (createErr) {
          if (!/RepositoryAlreadyExistsException/.test(String(createErr))) throw createErr;
        }
      }
    });
    return Account;
  }

  return {
    async connect(req) {
      validate(req);
      const creds = { accessKeyId: req.accessKeyId, secretAccessKey: req.secretAccessKey, region: req.region };
      let accountId: string;
      try {
        accountId = await check(creds);
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : String(err)} ${partialConnectNote}`, { cause: err });
      }
      // Lambda environments live in one account and region: moving either would strand them.
      const old = store.getAwsConnection();
      if (old && (old.accountId !== accountId || old.region !== creds.region)) {
        const using = [...new Set(store.environmentsUsing("aws").map((u) => u.projectName))];
        if (using.length > 0)
          throw new ErrInvalid(
            `projects still run on AWS account ${old.accountId} in ${old.region}: ${using.join(", ")} — use a key of that account and region, or archive those environments first`,
          );
      }
      return store.saveAwsConnection(
        {
          region: creds.region,
          accountId,
          repository: `${accountId}.dkr.ecr.${creds.region}.amazonaws.com/${REPOSITORY}`,
        },
        { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
      );
    },

    async test() {
      const conn = store.getAwsConnection();
      if (!conn) throw new ErrInvalid("AWS is not connected");
      try {
        const account = await check(awsCredentials(store));
        if (account !== conn.accountId)
          throw new Error(`the stored key now belongs to account ${account}, not ${conn.accountId}`);
        store.recordConnectionCheck("aws", null);
      } catch (err) {
        store.recordConnectionCheck("aws", err instanceof Error ? err.message : String(err));
        throw err;
      }
      return store.getAwsConnection()!;
    },
  };
}
