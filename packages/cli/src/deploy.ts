// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { deploy, createKubernetesTarget, createCloudRunTarget, type Deployer } from "@nbo/deploy";

// parseDeployArgs — port of parseDeployArgs (deploy.go lines 11-26).
export function parseDeployArgs(args: string[]): { dir: string; appName: string; target: string; carryFrom?: string } {
  let target = "kubernetes";
  if (args.length === 0) return { dir: "", appName: "", target };
  const dir = args[0]!;
  let appName = "";
  let carryFrom: string | undefined;
  for (let i = 1; i < args.length - 1; i++) {
    if (args[i] === "--app") appName = args[i + 1]!;
    else if (args[i] === "--target") target = args[i + 1]!;
    else if (args[i] === "--carry-from") carryFrom = args[i + 1]!;
  }
  return carryFrom === undefined ? { dir, appName, target } : { dir, appName, target, carryFrom };
}

// runDeploy — port of runDeploy (deploy.go lines 28-80).
export async function runDeploy(args: string[]): Promise<number> {
  if (args.length < 1) {
    console.error("usage: nbo deploy <dir> --app <name> [--target kubernetes|cloudrun] [--carry-from <dir>]");
    return 1;
  }
  const { dir: nboDir, appName, target, carryFrom } = parseDeployArgs(args);
  if (appName === "") {
    console.error("usage: nbo deploy <dir> --app <name> [--target kubernetes|cloudrun]");
    return 1;
  }

  let d: Deployer;
  let appURLOf: (() => string) | undefined;
  if (target === "cloudrun") {
    const project = process.env.NBO_GCP_PROJECT ?? "";
    const region = process.env.NBO_GCP_REGION ?? "";
    const repo = process.env.NBO_AR_REPO ?? "";
    const missing: Record<string, string> = { NBO_GCP_PROJECT: project, NBO_GCP_REGION: region, NBO_AR_REPO: repo };
    for (const [name, val] of Object.entries(missing)) {
      if (val === "") {
        console.error(`usage: nbo deploy <dir> --app <name> --target cloudrun requires ${name}`);
        return 1;
      }
    }
    const ct = createCloudRunTarget(project, region, repo);
    if (carryFrom !== undefined) ct.carryFrom = carryFrom;
    d = ct.deployer;
    appURLOf = () => ct.appURL;
  } else if (target === "kubernetes") {
    const kt = createKubernetesTarget(appName);
    if (carryFrom !== undefined) kt.carryFrom = carryFrom;
    d = kt.deployer;
  } else {
    console.error(`unknown target ${JSON.stringify(target)} (known: kubernetes, cloudrun)`);
    return 1;
  }

  let result;
  try {
    // Progress goes to stderr (stdout keeps its one result line), so a
    // build with prerender routes says it is served uncached here.
    result = await deploy(d, nboDir, appName, { onProgress: (m) => console.error(m) });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (result.plan !== "") {
    console.error(result.plan);
  }
  const url = appURLOf?.() || result.url;
  if (result.alreadyLive) {
    console.log(`content id ${result.contentID} already live for ${JSON.stringify(appName)} — nothing to do`);
  } else {
    console.log(`deployed ${appName} (content id ${result.contentID}) -> ${url}`);
  }
  return 0;
}
