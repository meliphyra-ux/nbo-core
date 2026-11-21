// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash } from "node:crypto";
import { aws, type ToolContext } from "./run.js";

// pushImage pushes a local image to ECR as remoteTag
// (<account>.dkr.ecr.<region>.amazonaws.com/nbo:<tag>) and returns its
// digest URI. docker logs in with the ECR password on stdin under dockerEnv
// (a private DOCKER_CONFIG), which every docker step uses; docker never gets
// the key pair.
export async function pushImage(
  ctx: ToolContext,
  localTag: string,
  remoteTag: string,
  dockerEnv: Record<string, string>,
): Promise<string> {
  // The runner merges stderr: the password is the last line.
  const password = (await aws(ctx, ["ecr", "get-login-password"])).trim().split("\n").pop()!.trim();
  const registry = remoteTag.slice(0, remoteTag.indexOf("/"));
  try {
    await ctx.run("docker", ["login", "--username", "AWS", "--password-stdin", registry], {
      env: dockerEnv,
      input: password,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line preserve-caught-error -- the original error may carry the password
    throw new Error(msg.split(password).join("[redacted]"));
  }
  await ctx.run("docker", ["tag", localTag, remoteTag], { env: dockerEnv });
  const out = await ctx.run("docker", ["push", remoteTag], { env: dockerEnv });
  const digest = /digest: (sha256:[0-9a-f]{64})/.exec(out)?.[1];
  if (!digest) throw new Error(`docker push ${remoteTag} printed no digest`);
  return `${remoteTag.slice(0, remoteTag.lastIndexOf(":"))}@${digest}`;
}

// The AWS Lambda Web Adapter 1.1.0 (built 2026-09-18), its x86_64 image
// pinned by manifest digest.
const WEB_ADAPTER =
  "public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0-x86_64@sha256:9d6b29a45b14a4a70f88d53c68b6d5bab1b22d75baca733958fee59308c509b8";

// lambdaDockerfile turns an app or function image (unchanged, the one Cloud
// Run and Kubernetes run) into its Lambda variant: the Web Adapter as an
// extension in front of the server on 8080, streaming responses. The
// readiness check is a TCP connect: an HTTP GET / would run the app's home
// page or the function's code on every cold start.
export function lambdaDockerfile(base: string): string {
  return `FROM ${base}
COPY --from=${WEB_ADAPTER} /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=8080 AWS_LWA_INVOKE_MODE=response_stream AWS_LWA_READINESS_CHECK_PROTOCOL=tcp
`;
}

// lambdaLayerHash (8 hex) changes when the Lambda layer does; it goes into
// the image tag, so an adapter upgrade is a new image.
export const lambdaLayerHash = createHash("sha256").update(lambdaDockerfile("")).digest("hex").slice(0, 8);

// buildLambdaImage builds tag from base with no build context (the
// Dockerfile on stdin).
export async function buildLambdaImage(ctx: ToolContext, base: string, tag: string): Promise<void> {
  await ctx.run("docker", ["build", "-t", tag, "-"], { input: lambdaDockerfile(base) });
}
