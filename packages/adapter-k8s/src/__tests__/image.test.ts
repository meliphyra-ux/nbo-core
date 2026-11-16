// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, cp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImage, buildFunctionImage, isrcacheImageTag, appBakedHash } from "../image.js";
import { renderIsrcacheDockerfile } from "../templates.js";

let dockerAvailable = true;
try {
  execFileSync("docker", ["--version"]);
} catch {
  dockerAvailable = false;
}

const builtTags: string[] = [];
afterAll(() => {
  for (const tag of builtTags) {
    try {
      execFileSync("docker", ["rmi", "-f", tag]);
    } catch {
      // best-effort cleanup
    }
  }
});

async function writeAppFixture(): Promise<{ nboDir: string; cliDeployDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "adapter-k8s-"));
  const nboDir = join(dir, "app");
  await mkdir(join(nboDir, "static"), { recursive: true });
  await writeFile(join(nboDir, "static", "index.html"), "hi");
  await writeFile(join(nboDir, "manifest.json"), JSON.stringify({ specVersion: "1.0" }));

  // None of these tests ever start the built image's container
  // (docker create makes a stopped container; ENTRYPOINT never
  // runs), so the artifact's own real-ness was never actually
  // exercised by the original Go tests either (a placeholder binary
  // there) — a placeholder directory, matching what a real `pnpm
  // deploy` output looks like (a dist/main.js plus a package.json),
  // makes that already-true fact explicit the same way here.
  const cliDeployDir = join(dir, "cli-deploy");
  await mkdir(join(cliDeployDir, "dist"), { recursive: true });
  await writeFile(join(cliDeployDir, "dist", "main.js"), "// placeholder\n");
  await writeFile(join(cliDeployDir, "package.json"), JSON.stringify({ name: "@nbo/cli", version: "0.0.0" }));

  return { nboDir, cliDeployDir };
}

function extractFile(tag: string, containerPath: string, destPath: string): string {
  const containerID = execFileSync("docker", ["create", tag]).toString().trim();
  try {
    execFileSync("docker", ["cp", `${containerID}:${containerPath}`, destPath]);
  } finally {
    execFileSync("docker", ["rm", "-f", containerID]);
  }
  return destPath;
}

describe.skipIf(!dockerAvailable)("buildImage", () => {
  it("produces a loadable image", async () => {
    const { nboDir, cliDeployDir } = await writeAppFixture();
    const tag = "nbo-image-test:latest";
    builtTags.push(tag);

    await buildImage(nboDir, cliDeployDir, tag);

    expect(() => execFileSync("docker", ["image", "inspect", tag])).not.toThrow();
  }, 60000);

  it("writes given env vars into /env.json", async () => {
    const { nboDir, cliDeployDir } = await writeAppFixture();
    const tag = "nbo-image-env-test:latest";
    builtTags.push(tag);

    await buildImage(nboDir, cliDeployDir, tag, undefined, { NBO_ISRCACHE_URL: "http://isrcache:8080" });

    const dest = join(await mkdtemp(join(tmpdir(), "adapter-k8s-extract-")), "env.json");
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(extractFile(tag, "/env.json", dest), "utf8");
    expect(content).toContain("http://isrcache:8080");
  }, 60000);

  it("puts an empty carry index in the context when no carry is given", async () => {
    const { nboDir, cliDeployDir } = await writeAppFixture();
    const tag = "nbo-image-carry-empty-test:latest";
    builtTags.push(tag);

    await buildImage(nboDir, cliDeployDir, tag);

    const dest = join(await mkdtemp(join(tmpdir(), "adapter-k8s-extract-")), "index.json");
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(extractFile(tag, "/app/carry/index.json", dest), "utf8"))).toEqual({
      version: 1,
      contentId: "",
      files: {},
    });
  }, 60000);

  it("copies the given carry directory to /app/carry", async () => {
    const { nboDir, cliDeployDir } = await writeAppFixture();
    const carryDir = await mkdtemp(join(tmpdir(), "adapter-k8s-carry-"));
    await mkdir(join(carryDir, "static", "assets"), { recursive: true });
    await writeFile(join(carryDir, "static", "assets", "old.js"), "old-bytes");
    await writeFile(join(carryDir, "index.json"), JSON.stringify({ version: 1, contentId: "sha256:aa", files: {} }));
    const tag = "nbo-image-carry-test:latest";
    builtTags.push(tag);

    await buildImage(nboDir, cliDeployDir, tag, undefined, undefined, carryDir);

    const dest = join(await mkdtemp(join(tmpdir(), "adapter-k8s-extract-")), "old.js");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(extractFile(tag, "/app/carry/static/assets/old.js", dest), "utf8")).toBe("old-bytes");
  }, 60000);

  it("writes given function URLs into /functions.json", async () => {
    const { nboDir, cliDeployDir } = await writeAppFixture();
    const tag = "nbo-image-functions-test:latest";
    builtTags.push(tag);

    await buildImage(nboDir, cliDeployDir, tag, { ssr: "http://next-app-fn-ssr:8080" });

    const dest = join(await mkdtemp(join(tmpdir(), "adapter-k8s-extract-")), "functions.json");
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(extractFile(tag, "/functions.json", dest), "utf8");
    expect(content).toContain("next-app-fn-ssr");
  }, 60000);

  // Guards against a regression found running the Cloud Run
  // adapter's own real verify script: the app image was FROM scratch,
  // which has no CA certificate bundle at all, so any outbound HTTPS
  // call from inside it failed with "x509: certificate signed by
  // unknown authority". Now proves a fact about node:24-slim's own
  // base image instead of about a manually-added Alpine-certs layer
  // — the point of the Node-base-image swap.
  it("includes CA certificates for outbound HTTPS", async () => {
    const { nboDir, cliDeployDir } = await writeAppFixture();
    const tag = "nbo-image-certs-test:latest";
    builtTags.push(tag);

    await buildImage(nboDir, cliDeployDir, tag);

    const dest = join(await mkdtemp(join(tmpdir(), "adapter-k8s-extract-")), "ca-certificates.crt");
    extractFile(tag, "/etc/ssl/certs/ca-certificates.crt", dest);
    const { stat } = await import("node:fs/promises");
    const info = await stat(dest);
    expect(info.size).toBeGreaterThan(0);
  }, 60000);

  // This sub-project's own Review Focus: a reasonable person running
  // this Dockerfile change expects the resulting image to actually
  // run `node dist/main.js serve ...` from the deployed CLI artifact's
  // own directory, not just that `docker build` succeeded.
  it("sets ENTRYPOINT and WorkingDir for the new Node-based app image", async () => {
    const { nboDir, cliDeployDir } = await writeAppFixture();
    const tag = "nbo-image-entrypoint-test:latest";
    builtTags.push(tag);

    await buildImage(nboDir, cliDeployDir, tag);

    const inspect = JSON.parse(execFileSync("docker", ["image", "inspect", tag]).toString());
    expect(inspect[0].Config.WorkingDir).toBe("/app/cli");
    expect(inspect[0].Config.Entrypoint).toEqual([
      "node",
      "dist/main.js",
      "serve",
      "/app/app",
      "--port",
      "8080",
      "--carry",
      "/app/carry",
    ]);
  }, 60000);
});

describe.skipIf(!dockerAvailable)("buildFunctionImage", () => {
  it("produces a loadable image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapter-k8s-fn-"));
    const bundleDir = join(dir, "bundle");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "index.mjs"), "export default { fetch() { return new Response('ok'); } };");
    const fnJSONPath = join(dir, "function.json");
    await writeFile(fnJSONPath, JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }));

    const tag = "nbo-fn-image-test:latest";
    builtTags.push(tag);
    await buildFunctionImage(bundleDir, fnJSONPath, tag);

    expect(() => execFileSync("docker", ["image", "inspect", tag])).not.toThrow();
  }, 60000);

  // Real bug found running Slice 4's crons verify script for real: a
  // deployed function never got /env.json's own baked vars at all
  // (only the main app image did), so a cron target's signature
  // check — or any binding/secret a function route reads — silently
  // always failed.
  it("writes given env vars into /app/env.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapter-k8s-fn-"));
    const bundleDir = join(dir, "bundle");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "index.mjs"), "export default { fetch() { return new Response('ok'); } };");
    const fnJSONPath = join(dir, "function.json");
    await writeFile(fnJSONPath, JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }));

    const tag = "nbo-fn-image-env-test:latest";
    builtTags.push(tag);
    await buildFunctionImage(bundleDir, fnJSONPath, tag, { NBO_CRON_SIGNING_SECRET: "s3cr3t" });

    const dest = join(await mkdtemp(join(tmpdir(), "adapter-k8s-extract-")), "env.json");
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(extractFile(tag, "/app/env.json", dest), "utf8");
    expect(content).toContain("s3cr3t");
  }, 60000);

  // A docker build succeeding proves nothing about whether the
  // container can actually find its own files at runtime (this
  // sub-project's own Review Focus item 5) — assert the real file
  // layout and WorkingDir directly, rather than trusting a successful
  // build.
  it("lays out /app/host.mjs, /app/bundle, /app/function.json with WorkingDir set to the bundle dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapter-k8s-fn-"));
    const bundleDir = join(dir, "bundle");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "index.mjs"), "export default { fetch() { return new Response('ok'); } };");
    const fnJSONPath = join(dir, "function.json");
    await writeFile(fnJSONPath, JSON.stringify({ handler: { entry: "index.mjs", export: "default" } }));

    const tag = "nbo-fn-image-layout-test:latest";
    builtTags.push(tag);
    await buildFunctionImage(bundleDir, fnJSONPath, tag);

    const inspect = JSON.parse(execFileSync("docker", ["image", "inspect", tag]).toString());
    expect(inspect[0].Config.WorkingDir).toBe("/app/bundle");
    expect(inspect[0].Config.Entrypoint).toEqual(["node", "/app/host.mjs", "/app/bundle"]);

    const extractDir = await mkdtemp(join(tmpdir(), "adapter-k8s-extract-"));
    const hostDest = extractFile(tag, "/app/host.mjs", join(extractDir, "host.mjs"));
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(hostDest, "utf8")).toContain("NBO_FUNCTION_LISTENING");

    const fnJSONDest = extractFile(tag, "/app/function.json", join(extractDir, "function.json"));
    expect(await readFile(fnJSONDest, "utf8")).toContain("index.mjs");

    const bundleDest = extractFile(tag, "/app/bundle/index.mjs", join(extractDir, "bundle-index.mjs"));
    expect(await readFile(bundleDest, "utf8")).toContain("fetch");
  }, 60000);
});

// writeCliBundle writes a small stand-in for a `pnpm deploy` output:
// the CLI's own dist/, one @nbo package's dist/, and files outside any
// dist/ that the cache image tag must ignore.
async function writeCliBundle(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "adapter-k8s-isrcache-")), "cli-deploy");
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "dist", "main.js"), "// cli\n");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@nbo/cli" }));
  await mkdir(join(dir, "node_modules", "@nbo", "isrcache", "dist"), { recursive: true });
  await writeFile(join(dir, "node_modules", "@nbo", "isrcache", "dist", "index.js"), "// isrcache\n");
  await writeFile(join(dir, "node_modules", "@nbo", "isrcache", "package.json"), "{}");
  await mkdir(join(dir, "node_modules", "left-pad", "dist"), { recursive: true });
  await writeFile(join(dir, "node_modules", "left-pad", "dist", "index.js"), "// third party\n");
  return dir;
}

async function copyTree(src: string): Promise<string> {
  const dest = join(await mkdtemp(join(tmpdir(), "adapter-k8s-isrcache-")), "cli-deploy");
  await cp(src, dest, { recursive: true });
  return dest;
}

describe("isrcacheImageTag", () => {
  it("is nbo-isrcache:<12 hex>", async () => {
    expect(await isrcacheImageTag(await writeCliBundle())).toMatch(/^nbo-isrcache:[0-9a-f]{12}$/);
  });

  it("is stable for the same tree, wherever it lives", async () => {
    const a = await writeCliBundle();
    const b = await copyTree(a);
    expect(await isrcacheImageTag(a)).toBe(await isrcacheImageTag(b));
  });

  it("changes when one dist file changes", async () => {
    const a = await writeCliBundle();
    const b = await copyTree(a);
    await writeFile(join(b, "node_modules", "@nbo", "isrcache", "dist", "index.js"), "// isrcache v2\n");
    const c = await copyTree(a);
    await writeFile(join(c, "dist", "main.js"), "// cli v2\n");
    const tagA = await isrcacheImageTag(a);
    expect(await isrcacheImageTag(b)).not.toBe(tagA);
    expect(await isrcacheImageTag(c)).not.toBe(tagA);
  });

  it("changes when a dist file is added or renamed", async () => {
    const a = await writeCliBundle();
    const b = await copyTree(a);
    await writeFile(join(b, "dist", "extra.js"), "");
    expect(await isrcacheImageTag(b)).not.toBe(await isrcacheImageTag(a));
  });

  it("ignores files outside dist/ and packages outside @nbo", async () => {
    const a = await writeCliBundle();
    const b = await copyTree(a);
    await writeFile(join(b, "package.json"), JSON.stringify({ name: "@nbo/cli", version: "9" }));
    await writeFile(join(b, "node_modules", "@nbo", "isrcache", "package.json"), '{"x":1}');
    await writeFile(join(b, "node_modules", "left-pad", "dist", "index.js"), "// changed\n");
    expect(await isrcacheImageTag(b)).toBe(await isrcacheImageTag(a));
  });

  it("follows a linked @nbo package", async () => {
    const a = await writeCliBundle();
    const b = await copyTree(a);
    const elsewhere = join(await mkdtemp(join(tmpdir(), "adapter-k8s-isrcache-pkg-")), "isrcache");
    await cp(join(b, "node_modules", "@nbo", "isrcache"), elsewhere, { recursive: true });
    await rm(join(b, "node_modules", "@nbo", "isrcache"), { recursive: true, force: true });
    // A junction needs no admin rights on Windows; elsewhere it is a plain directory symlink.
    await symlink(elsewhere, join(b, "node_modules", "@nbo", "isrcache"), "junction");
    expect(await isrcacheImageTag(b)).toBe(await isrcacheImageTag(a));
  });

  it("is memoized per directory", async () => {
    const a = await writeCliBundle();
    const first = await isrcacheImageTag(a);
    await writeFile(join(a, "dist", "main.js"), "// changed after the first call\n");
    expect(await isrcacheImageTag(a)).toBe(first);
  });

  it("changes when the bundle's pnpm-lock.yaml changes (a dependency-only upgrade)", async () => {
    const a = await writeCliBundle();
    await writeFile(join(a, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nre2: 1.21.0\n");
    const b = await copyTree(a);
    await writeFile(join(b, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nre2: 1.22.0\n");
    expect(await isrcacheImageTag(b)).not.toBe(await isrcacheImageTag(a));
  });

  it("skips a dangling link instead of failing", async () => {
    const a = await writeCliBundle();
    const b = await copyTree(a);
    const gone = join(await mkdtemp(join(tmpdir(), "adapter-k8s-isrcache-gone-")), "missing");
    await symlink(gone, join(b, "dist", "dangling"), "junction");
    expect(await isrcacheImageTag(b)).toBe(await isrcacheImageTag(a));
  });
});

describe("appBakedHash", () => {
  it("is 8 hex and stable for the same inputs", async () => {
    const a = await writeCliBundle();
    const b = await copyTree(a);
    const h = await appBakedHash(a, { ssr: "http://x" }, { A: "1" });
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(await appBakedHash(b, { ssr: "http://x" }, { A: "1" })).toBe(h);
  });

  it("changes with functions.json, env.json or NBO's code", async () => {
    const a = await writeCliBundle();
    const h = await appBakedHash(a, { ssr: "http://x" }, { A: "1" });
    expect(await appBakedHash(a, { ssr: "http://x", __isrcache: "http://c" }, { A: "1" })).not.toBe(h);
    expect(await appBakedHash(a, { ssr: "http://x" }, { A: "2" })).not.toBe(h);
    const c = await copyTree(a);
    await writeFile(join(c, "node_modules", "@nbo", "isrcache", "dist", "index.js"), "// serve v2\n");
    expect(await appBakedHash(c, { ssr: "http://x" }, { A: "1" })).not.toBe(h);
    expect(await appBakedHash(a)).toBe(await appBakedHash(a, {}, {}));
  });
});

describe("renderIsrcacheDockerfile", () => {
  it("is the pinned text: the app image's CLI prefix, then the cache's env and entrypoint", () => {
    expect(renderIsrcacheDockerfile()).toBe(`FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY cli /app/cli
WORKDIR /app/cli
RUN re2_pkg="$(find . -path '*/node_modules/re2/package.json' | head -1)"; \\
    if [ -n "$re2_pkg" ]; then \\
      re2_dir="$(dirname "$re2_pkg")"; \\
      rm -rf "$re2_dir/build"; \\
      (cd "$re2_dir" && npm run install); \\
    fi
ENV NBO_ISRCACHE_ADDR=:8080
ENTRYPOINT ["node", "dist/main.js", "isrcache"]
`);
  });
});
