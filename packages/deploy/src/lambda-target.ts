// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildImage, buildFunctionImage, functionImageHash, appBakedHash } from "@nbo/adapter-k8s";
import {
  buildLambdaImage,
  capabilities,
  checkEnvSize,
  deployFunction,
  isLive,
  lambdaLayerHash,
  lambdaName,
  liveFunctionState,
  pushImage,
  type LambdaFunctionSpec,
  type ToolContext,
} from "@nbo/adapter-lambda";
import type { Function as NboFunction } from "@nbo/spec";
import { imageEnvVars, providedEnvNames, type UserEnv } from "./env.js";
import { cliDeployDirs, functionConcurrency } from "./kubernetes-target.js";
import { mapLimit } from "./concurrency.js";
import { appImageTag } from "./tag.js";
import { withCarry } from "./carry.js";
import type { Deployer } from "./deploy.js";
import { createProgress, type Progress, type ProgressOptions } from "./progress.js";
import { withDockerConfig } from "./credentials.js";

// ctx is @nbo/adapter-lambda's awsContext (the connection's key pair and
// region in its env, plus a runner); accountId and repository come from the
// AWS connection (repository: <account>.dkr.ecr.<region>.amazonaws.com/nbo).
export interface LambdaTargetOptions {
  ctx: ToolContext;
  accountId: string;
  repository: string;
}

// LambdaTarget mirrors CloudRunTarget (extraEnv, userEnv and carryFrom are
// read at call time), without an ISR cache: Lambda serves prerender routes
// uncached (deploy() says so once).
export interface LambdaTarget {
  deployer: Deployer;
  extraEnv: Record<string, string>;
  appURL: string;
  userEnv?: UserEnv;
  carryFrom?: string;
}

// createLambdaTarget deploys the app and each function as their own Lambda
// (images as on Cloud Run plus the Web Adapter, pushed to the one ECR
// repository, tagged <lambda name>_<image hash>-l<layer hash>). Functions get
// AWS_IAM function URLs, baked into the app's /functions.json; the app's URL
// is public and is the deployment URL. Every variable (the user's and NBO's
// own) is Lambda environment, never baked into an image; Lambda's 4 KB limit
// is checked before anything is built or pushed.
export function createLambdaTarget(opts: LambdaTargetOptions, progress?: ProgressOptions): LambdaTarget {
  const { ctx, accountId, repository } = opts;
  const progressRoot = createProgress(progress);
  let functionURLs: Record<string, string> = {};
  let functionLambdas: string[] = [];
  const target = {} as LambdaTarget;
  target.extraEnv = {};
  target.appURL = "";

  // NBO's own values win over a user's variable of the same name, as
  // /env.json does on Cloud Run.
  const runtimeEnv = async (nboDir: string): Promise<Record<string, string>> => {
    const env = {
      ...target.userEnv?.vars,
      ...(await imageEnvVars(nboDir, true, target.extraEnv, target.userEnv)),
    };
    checkEnvSize(env);
    return env;
  };
  const fingerprint = () => (target.userEnv?.fingerprint ? { envFingerprint: target.userEnv.fingerprint } : {});

  // pushLambdaImage adds the Web Adapter to a built image and pushes it under
  // a private DOCKER_CONFIG that goes away with the push.
  const pushLambdaImage = async (p: Progress, localTag: string, remoteTag: string): Promise<void> => {
    const lambdaTag = `${localTag}-lambda`;
    await p.timed("lambda layer added", "lambda layer", () => buildLambdaImage(ctx, localTag, lambdaTag));
    await p.timed("image pushed", "image push", () =>
      withDockerConfig((env) => pushImage(ctx, lambdaTag, remoteTag, env)),
    );
  };
  const imageTag = (name: string, suffix: string) => `${name}_${suffix}-l${lambdaLayerHash}`;

  const deployFunctions = async (
    nboDir: string,
    app: string,
    functionNames: string[],
  ): Promise<Record<string, string>> => {
    const env = await runtimeEnv(nboDir);
    // Each function is skipped (no build, push or AWS write) when its live
    // Lambda is ready and tagged with this image, config and variables.
    const deployOne = async (name: string): Promise<string> => {
      const p = progressRoot.scope(`function ${name}`);
      const bundleDir = join(nboDir, "functions", name, "bundle");
      const functionJSONPath = join(nboDir, "functions", name, "function.json");
      const fnName = lambdaName(app, name);
      const suffix = await functionImageHash(bundleDir, functionJSONPath, {});
      const localTag = `nbo-fn-${app}-${name}:${suffix}`;
      const remoteTag = `${repository}:${imageTag(fnName, suffix)}`;
      let resources: NboFunction["resources"];
      try {
        resources = (JSON.parse(await readFile(functionJSONPath, "utf8")) as NboFunction).resources;
      } catch {
        // Unreadable function.json: the adapter's defaults, as on Cloud Run.
      }
      const spec: LambdaFunctionSpec = {
        name: fnName,
        image: remoteTag,
        accountId,
        // Functions aren't content-id-tracked: their image hash stands in.
        contentID: suffix,
        memoryMB: resources?.memoryMb,
        maxDurationSec: resources?.maxDurationSec,
        env,
        ...fingerprint(),
        public: false,
      };
      const live = await liveFunctionState(fnName, ctx);
      if (isLive(live, spec)) {
        p.report("unchanged, skipped");
        return live!.url;
      }
      await p.timed("image built", "image build", () => buildFunctionImage(bundleDir, functionJSONPath, localTag, {}));
      await pushLambdaImage(p, localTag, remoteTag);
      const { url } = await p.timed("function deployed", "function deploy", () => deployFunction(spec, ctx));
      return url;
    };
    const urls = await mapLimit(functionNames, functionConcurrency, deployOne);
    functionURLs = Object.fromEntries(functionNames.map((n, i) => [n, urls[i]!]));
    functionLambdas = functionNames.map((n) => lambdaName(app, n));
    return functionURLs;
  };

  const buildAndDeployApp = async (nboDir: string, app: string, id: string): Promise<void> => {
    const p = progressRoot.scope("app");
    const env = await runtimeEnv(nboDir);
    const cli = await p.timed("cli bundle prepared", "cli bundle preparation", () => cliDeployDirs.acquire(nboDir));
    try {
      const suffix = await withCarry(
        target.carryFrom,
        nboDir,
        (m) => p.report(m),
        async (carryDir, carryHash) => {
          const suffix = appImageTag(id, carryHash, await appBakedHash(cli.dir, functionURLs, {}));
          await p.timed("image built", "image build", () =>
            buildImage(nboDir, cli.dir, `nbo-app-${app}:${suffix}`, functionURLs, {}, carryDir),
          );
          return suffix;
        },
      );
      const name = lambdaName(app);
      const remoteTag = `${repository}:${imageTag(name, suffix)}`;
      await pushLambdaImage(p, `nbo-app-${app}:${suffix}`, remoteTag);
      const { url } = await p.timed("function deployed", "function deploy", () =>
        deployFunction(
          {
            name,
            image: remoteTag,
            accountId,
            contentID: id,
            env,
            ...fingerprint(),
            public: true,
            invokes: functionLambdas,
          },
          ctx,
        ),
      );
      target.appURL = url;
    } finally {
      await cli.release();
    }
  };

  // shortcut: a function the new build no longer has keeps running until the
  // environment is torn down, as on Cloud Run; prune when one of them does.
  target.deployer = {
    capabilities,
    liveContentID: async (app: string) => {
      const live = await liveFunctionState(lambdaName(app), ctx);
      if (!live) return { id: "", ok: false };
      // An unchanged deploy returns the live app's URL.
      target.appURL = live.url;
      return { id: live.contentID, ok: live.ready && !!live.url, fingerprint: live.fingerprint || null };
    },
    urlFor: () => target.appURL,
    deployFunctions,
    buildAndDeploy: buildAndDeployApp,
    // Read at call time: callers set target.userEnv after construction.
    get userEnv() {
      return target.userEnv;
    },
    providedEnvNames: () => providedEnvNames(true, target.extraEnv),
  };
  return target;
}
