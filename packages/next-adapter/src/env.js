// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { sha256Hex } from "@nbo/writer";

// fromNextEnv derives env.inlinedAtBuild/inlinedEnvDigest from the
// build process's own process.env — onBuildComplete's own context
// carries no field naming which env vars a build actually reads
// (confirmed against the real, installed
// next/dist/build/adapter/build-complete.d.ts: the one "env" field
// that exists there, on each route output's own config, is "only
// populated for edge runtime currently" and unrelated). Every
// NEXT_PUBLIC_* key set in the build's own environment is listed,
// erring toward over-inclusion — a var that was set but never
// actually referenced ending up listed is the safe direction for a
// check whose whole job is catching drift between what a build
// assumed and what a deploy environment actually has.
export function fromNextEnv(env) {
  const inlinedAtBuild = Object.keys(env)
    .filter((k) => k.startsWith("NEXT_PUBLIC_"))
    .sort();
  const digestInput = inlinedAtBuild.map((k) => `${k}=${env[k]}`).join("\n");
  const inlinedEnvDigest = `sha256:${sha256Hex(digestInput)}`;
  return { inlinedAtBuild, inlinedEnvDigest };
}
