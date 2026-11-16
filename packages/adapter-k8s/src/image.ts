// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { mkdtemp, mkdir, writeFile, rm, cp, readFile, readdir, readlink, lstat, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostScriptPath } from "@nbo/funcproxy";
import { run, runWith, type ToolContext } from "./run.js";
import { appDockerfile, functionDockerfile, renderIsrcacheDockerfile } from "./templates.js";

// assembleAppBuildContext populates buildCtx with everything the
// static app Dockerfile template needs: the nbo binary, the .nbo/
// directory, functionURLs baked in as /functions.json, and envVars
// baked in as /env.json (both defaulting to {} when not given) since
// a container's ENTRYPOINT is fixed at image-build time, not
// something a later `nbo serve` flag can supply per deploy.
async function assembleAppBuildContext(
  buildCtx: string,
  nboDir: string,
  cliDeployDir: string,
  functionURLs?: Record<string, string>,
  envVars?: Record<string, string>,
  carryDir?: string,
): Promise<void> {
  await writeFile(join(buildCtx, "Dockerfile"), appDockerfile);
  // cliDeployDir is a real `pnpm deploy` output — its own node_modules
  // contains symlinks into that deploy's own .pnpm virtual store as
  // *absolute* host paths (confirmed directly), which would be
  // dangling once relocated into this throwaway build context and
  // then into the built image's filesystem. dereference: true resolves
  // every one of them into a real file during this copy, confirmed
  // directly to still `require()` correctly afterward.
  await cp(cliDeployDir, join(buildCtx, "cli"), { recursive: true, dereference: true });
  await cp(nboDir, join(buildCtx, "app"), { recursive: true });
  // The previous build's hashed files (see @nbo/deploy's carry.ts); an empty index when none.
  if (carryDir) {
    await cp(carryDir, join(buildCtx, "carry"), { recursive: true });
  } else {
    await mkdir(join(buildCtx, "carry"), { recursive: true });
    await writeFile(join(buildCtx, "carry", "index.json"), JSON.stringify({ version: 1, contentId: "", files: {} }));
  }
  await writeFile(join(buildCtx, "functions.json"), JSON.stringify(functionURLs ?? {}));
  await writeFile(join(buildCtx, "env.json"), JSON.stringify(envVars ?? {}));
}

// withBuildContext runs fn with a fresh temp directory and removes it
// afterwards. The removal is best effort: a failure (EROFS once the
// disk has gone read-only, say) is only warned about, so it never
// replaces fn's own error and never fails a build that worked.
async function withBuildContext<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `nbo: could not remove the build context ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function runDockerBuild(buildCtx: string, tag: string): Promise<void> {
  await run("docker", ["build", "-t", tag, buildCtx]);
}

// buildImage assembles a throwaway Docker build context containing
// the given deployed @nbo/cli artifact (a real `pnpm deploy` output —
// see assembleAppBuildContext's own comment) and .nbo/ directory, then
// builds and tags an image from it — port of BuildImage (image.go
// lines 44-55), now Node-based rather than a single cross-compiled Go
// binary (step 8's own Dockerfile swap).
export async function buildImage(
  nboDir: string,
  cliDeployDir: string,
  tag: string,
  functionURLs?: Record<string, string>,
  envVars?: Record<string, string>,
  carryDir?: string,
): Promise<void> {
  await withBuildContext("nbo-image-", async (buildCtx) => {
    await assembleAppBuildContext(buildCtx, nboDir, cliDeployDir, functionURLs, envVars, carryDir);
    await runDockerBuild(buildCtx, tag);
  });
}

// assembleFunctionBuildContext populates buildCtx with everything the
// function Dockerfile template needs: the generic Node host (read via
// @nbo/funcproxy's own hostScriptPath — the second and final Go
// caller of internal/nodehost, now retired), the function's bundle/,
// its function.json, and envVars baked in as env.json (defaulting to
// {} when not given) — host.mjs's own join(bundleDir, "..",
// "env.json") convention, a sibling of function.json. Found missing
// running Slice 4's crons verify script for real: a function's own
// container never got any deploy-time env vars at all, so a cron
// target's signature check (or any binding/secret a function route
// reads) silently always failed.
async function assembleFunctionBuildContext(
  buildCtx: string,
  bundleDir: string,
  functionJSONPath: string,
  envVars?: Record<string, string>,
): Promise<void> {
  await writeFile(join(buildCtx, "Dockerfile"), functionDockerfile);
  await cp(hostScriptPath(), join(buildCtx, "host.mjs"));
  await cp(bundleDir, join(buildCtx, "bundle"), { recursive: true });
  await cp(functionJSONPath, join(buildCtx, "function.json"));
  await writeFile(join(buildCtx, "env.json"), JSON.stringify(envVars ?? {}));
}

// buildFunctionImage assembles a throwaway Docker build context
// containing the generic Node function host, the given function's
// bundle/ directory, its function.json, and envVars baked in as
// env.json, then builds and tags an image from it — port of
// BuildFunctionImage (image.go lines 117-128), extended with envVars
// (Go's own version never had crons/this env-propagation gap to fix).
export async function buildFunctionImage(
  bundleDir: string,
  functionJSONPath: string,
  tag: string,
  envVars?: Record<string, string>,
): Promise<void> {
  await withBuildContext("nbo-fn-image-", async (buildCtx) => {
    await assembleFunctionBuildContext(buildCtx, bundleDir, functionJSONPath, envVars);
    await runDockerBuild(buildCtx, tag);
  });
}

// functionImageHash is the content hash a function image is tagged
// with: sha256 over everything buildFunctionImage puts into the image
// (the Dockerfile, the shared host script, function.json, every bundle
// file's relative path, mode and bytes — symlinks by target — and the
// env baked in as env.json, keys sorted). Equal hashes mean equal
// images, so a deploy can skip a function whose live service already
// runs this tag. Env values only ever enter the digest; the returned
// 24 hex characters reveal nothing usable about them.
export async function functionImageHash(
  bundleDir: string,
  functionJSONPath: string,
  envVars?: Record<string, string>,
): Promise<string> {
  const h = createHash("sha256");
  const field = (label: string, data: string | Buffer) => {
    h.update(`${label}\0${Buffer.byteLength(data)}\0`);
    h.update(data);
  };
  field("dockerfile", functionDockerfile);
  field("host", await readFile(hostScriptPath()));
  field("function.json", await readFile(functionJSONPath));
  const env = envVars ?? {};
  field(
    "env",
    JSON.stringify(
      Object.keys(env)
        .sort()
        .map((k) => [k, env[k]]),
    ),
  );
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const e of entries) {
      const abs = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        field(`link ${r}`, await readlink(abs));
      } else if (e.isDirectory()) {
        h.update(`dir ${r}\0`);
        await walk(abs, r);
      } else if (e.isFile()) {
        const st = await lstat(abs);
        h.update(`file ${r}\0${st.mode & 0o777}\0${st.size}\0`);
        for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
      }
    }
  };
  await walk(bundleDir, "");
  return h.digest("hex").slice(0, 24);
}

// loadImageIntoKind — port of LoadImageIntoKind (image.go lines
// 149-159). No existing Go unit test; ships build-verified only.
//
// Loads into one cluster run one at a time (a per-cluster queue):
// parallel function deploys would otherwise run concurrent `ctr image
// import`s of shared layers on the same nodes, which is flaky. A failed
// load rejects only its own caller; the next one still runs.
const kindLoadQueues = new Map<string, Promise<unknown>>();

export function loadImageIntoKind(tag: string, clusterName: string): Promise<void> {
  const prev = kindLoadQueues.get(clusterName) ?? Promise.resolve();
  const mine = prev.then(async () => {
    await run("kind", ["load", "docker-image", tag, "--name", clusterName]);
  });
  const tail = mine.catch(() => {});
  kindLoadQueues.set(clusterName, tail);
  // Drop the entry once this was the last queued load.
  void tail.then(() => {
    if (kindLoadQueues.get(clusterName) === tail) kindLoadQueues.delete(clusterName);
  });
  return mine;
}

// pushImage tags a local image under its registry tag and pushes it
// with ctx.env (a temporary DOCKER_CONFIG holding the registry login),
// for clusters that pull from a registry rather than `kind load`.
export async function pushImage(localTag: string, remoteTag: string, ctx?: ToolContext): Promise<void> {
  await runWith(ctx, "docker", ["tag", localTag, remoteTag]);
  await runWith(ctx, "docker", ["push", remoteTag]);
}

// cliCodeFiles lists the files NBO's code hash covers: the CLI's own
// dist/, every @nbo package's dist/ under node_modules, and the
// bundle's pnpm-lock.yaml (so a dependency-only upgrade such as re2 or
// undici changes it too), as sorted relative paths with forward
// slashes. Links are followed (stat, not lstat): a workspace package
// under node_modules/@nbo may be a link into the store, and the image
// gets the files it points at. A dangling link is skipped: it puts
// nothing into the image either.
async function cliCodeFiles(cliDeployDir: string): Promise<{ rel: string; abs: string; size: number }[]> {
  const out: { rel: string; abs: string; size: number }[] = [];
  const statOrNull = async (p: string) => {
    try {
      return await stat(p);
    } catch {
      return null;
    }
  };
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of await readdir(abs)) {
      const a = join(abs, name);
      const r = `${rel}/${name}`;
      const st = await statOrNull(a);
      if (!st) continue;
      if (st.isDirectory()) await walk(a, r);
      else if (st.isFile()) out.push({ rel: r, abs: a, size: st.size });
    }
  };
  if ((await statOrNull(join(cliDeployDir, "dist")))?.isDirectory()) await walk(join(cliDeployDir, "dist"), "dist");
  const scope = join(cliDeployDir, "node_modules", "@nbo");
  if ((await statOrNull(scope))?.isDirectory()) {
    for (const pkg of await readdir(scope)) {
      const dist = join(scope, pkg, "dist");
      if ((await statOrNull(dist))?.isDirectory()) await walk(dist, `node_modules/@nbo/${pkg}/dist`);
    }
  }
  const lock = await statOrNull(join(cliDeployDir, "pnpm-lock.yaml"));
  if (lock?.isFile()) out.push({ rel: "pnpm-lock.yaml", abs: join(cliDeployDir, "pnpm-lock.yaml"), size: lock.size });
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

const codeHashMemo = new Map<string, Promise<string>>();
const CODE_HASH_MEMO_MAX = 64;

// cliCodeHash is sha256 (hex) over every file cliCodeFiles lists
// (relative path, size, bytes): NBO's own code in a prepared CLI
// bundle. Memoized per directory: a prepared CLI bundle never changes
// while it is leased.
function cliCodeHash(cliDeployDir: string): Promise<string> {
  const hit = codeHashMemo.get(cliDeployDir);
  if (hit) return hit;
  const p = (async () => {
    const h = createHash("sha256");
    for (const f of await cliCodeFiles(cliDeployDir)) {
      h.update(`file ${f.rel} ${f.size} `);
      for await (const chunk of createReadStream(f.abs)) h.update(chunk as Buffer);
    }
    return h.digest("hex");
  })();
  codeHashMemo.set(cliDeployDir, p);
  p.catch(() => {
    if (codeHashMemo.get(cliDeployDir) === p) codeHashMemo.delete(cliDeployDir);
  });
  // Bundles are temp dirs, one per build: keep only the newest few.
  while (codeHashMemo.size > CODE_HASH_MEMO_MAX) {
    const oldest = codeHashMemo.keys().next().value as string;
    codeHashMemo.delete(oldest);
  }
  return p;
}

// isrcacheImageTag is the ISR cache image's tag, `nbo-isrcache:<12 hex>`:
// sha256 over the Dockerfile text and cliCodeHash. It changes only when
// NBO's code or dependencies do, not per build, so the cache keeps
// running (and stays warm) across deploys that change only the app or
// its variables.
export async function isrcacheImageTag(cliDeployDir: string): Promise<string> {
  const code = await cliCodeHash(cliDeployDir);
  const h = createHash("sha256");
  const dockerfile = renderIsrcacheDockerfile();
  h.update(`dockerfile ${Buffer.byteLength(dockerfile)} `);
  h.update(dockerfile);
  h.update(`code ${code}`);
  return `nbo-isrcache:${h.digest("hex").slice(0, 12)}`;
}

// appBakedHash is 8 hex over what buildImage bakes into an app image
// besides .nbo/ and the carried files: the app Dockerfile, NBO's code
// (cliCodeHash), /functions.json and /env.json, written exactly as
// assembleAppBuildContext writes them. It goes into the app image tag,
// so a deploy of the same build after an NBO upgrade, or with other
// function URLs or baked values, gets a new tag: Kubernetes pulls with
// IfNotPresent and would otherwise start a node's older image.
export async function appBakedHash(
  cliDeployDir: string,
  functionURLs?: Record<string, string>,
  envVars?: Record<string, string>,
): Promise<string> {
  const code = await cliCodeHash(cliDeployDir);
  const h = createHash("sha256");
  for (const [name, text] of [
    ["dockerfile", appDockerfile],
    ["code", code],
    ["functions.json", JSON.stringify(functionURLs ?? {})],
    ["env.json", JSON.stringify(envVars ?? {})],
  ] as const) {
    h.update(`${name} ${Buffer.byteLength(text)} `);
    h.update(text);
  }
  return h.digest("hex").slice(0, 8);
}

// buildIsrcacheImage builds the ISR cache image from a prepared CLI
// bundle: the bundle goes under cli/ in a throwaway context (links
// resolved, as for the app image) next to renderIsrcacheDockerfile().
export async function buildIsrcacheImage(cliDeployDir: string, tag: string): Promise<void> {
  await withBuildContext("nbo-isrcache-image-", async (buildCtx) => {
    await writeFile(join(buildCtx, "Dockerfile"), renderIsrcacheDockerfile());
    await cp(cliDeployDir, join(buildCtx, "cli"), { recursive: true, dereference: true });
    await runDockerBuild(buildCtx, tag);
  });
}
