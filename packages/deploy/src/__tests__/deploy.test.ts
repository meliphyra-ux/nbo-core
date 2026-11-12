// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalize, contentId } from "@nbo/digest";
import { deploy, type Deployer } from "../deploy.js";

function sha256Hex(raw: string | Buffer): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

// writeManifestFixture writes a minimal but schema-valid .nbo/
// directory: one static file, referenced by static.index.json, with
// every digest computed from the actual bytes on disk so validate()
// accepts it.
async function writeManifestFixture(dir: string): Promise<void> {
  await mkdir(join(dir, "static"), { recursive: true });
  const indexHTML = Buffer.from("hi");
  await writeFile(join(dir, "static", "index.html"), indexHTML);

  const staticIndex = Buffer.from(
    canonicalize({ files: { "/": { file: "index.html", digest: sha256Hex(indexHTML), size: 2, contentType: "text/html; charset=utf-8", cache: "revalidate" } } }),
  );
  await writeFile(join(dir, "static.index.json"), staticIndex);

  const routes = Buffer.from(canonicalize({ version: 1 }));
  await writeFile(join(dir, "routes.json"), routes);

  const manifest = Buffer.from(
    canonicalize({
      specVersion: "1.0",
      build: { id: "b1", createdAt: "2026-10-22T00:00:00Z", framework: { name: "static" } },
      requires: { capabilities: [], extensions: [] },
      functions: [],
      digests: { "static.index.json": sha256Hex(staticIndex), "routes.json": sha256Hex(routes) },
    }),
  );
  await writeFile(join(dir, "manifest.json"), manifest);
}

// writeManifestFixtureWithFunction writes the same fixture
// writeManifestFixture does, but also adds a minimal, schema-valid
// function to it, so manifest.functions is non-empty.
async function writeManifestFixtureWithFunction(dir: string, name: string): Promise<void> {
  await writeManifestFixture(dir);

  const bundleDir = join(dir, "functions", name, "bundle");
  await mkdir(bundleDir, { recursive: true });
  const entry = Buffer.from("export default { fetch() {} };");
  await writeFile(join(bundleDir, "index.mjs"), entry);

  const bundleIndex = Buffer.from(canonicalize({ files: { "index.mjs": { digest: sha256Hex(entry), size: entry.length } } }));
  await writeFile(join(bundleDir, "bundle.index.json"), bundleIndex);

  const functionJSON = Buffer.from(
    canonicalize({
      name,
      runtime: { kind: "node" },
      handler: { style: "fetch", entry: "index.mjs", export: "default" },
      artifact: { type: "bundle", path: "bundle/", digest: sha256Hex(bundleIndex), files: "bundle.index.json" },
      concurrency: "multi",
    }),
  );
  await writeFile(join(dir, "functions", name, "function.json"), functionJSON);

  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.functions = [name];
  manifest.digests[`functions/${name}/function.json`] = sha256Hex(functionJSON);
  await writeFile(manifestPath, canonicalize(manifest));
}

// setRequiredCapabilities mutates an already-written manifest.json's
// requires.capabilities array.
async function setRequiredCapabilities(dir: string, caps: string[]): Promise<void> {
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.requires.capabilities = caps;
  await writeFile(manifestPath, canonicalize(manifest));
}

async function computeTestContentID(dir: string): Promise<string> {
  const raw = await readFile(join(dir, "manifest.json"), "utf8");
  return contentId(JSON.parse(raw));
}

describe("deploy", () => {
  it("no-ops when the content id is already live", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);

    const d: Deployer = {
      liveContentID: async () => {
        // Pretend whatever this build's content id is, it's already
        // live — computed via the same path deploy() will use, to
        // avoid hardcoding a brittle literal hash.
        const id = await computeTestContentID(dir);
        return { id, ok: true };
      },
      buildAndDeploy: async () => {
        throw new Error("buildAndDeploy must not be called when the content id is already live");
      },
    };

    const result = await deploy(d, dir, "static-site");
    expect(result.alreadyLive).toBe(true);
  });

  it("deploys when the content id differs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);

    let called = false;
    const d: Deployer = {
      liveContentID: async () => ({ id: "sha256:somethingElseEntirely", ok: true }),
      buildAndDeploy: async () => {
        called = true;
      },
    };

    const result = await deploy(d, dir, "static-site");
    expect(result.alreadyLive).toBe(false);
    expect(called).toBe(true);
  });

  // Guards against a real bug found running the Cloud Run adapter's
  // verify script end to end: GCP labels can't hold a full content id
  // (63-char limit), so liveContentID returns a truncated form —
  // comparing it against the full id via plain equality can never
  // match, so the idempotency check always redeploys, every time,
  // even for identical content. idsMatch lets an adapter supply its
  // own comparison instead.
  it("uses a configured idsMatch instead of plain equality", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);

    const id = await computeTestContentID(dir);
    const truncated = id.slice(-8); // stand-in for a lossy, adapter-specific storage form

    const d: Deployer = {
      liveContentID: async () => ({ id: truncated, ok: true }),
      idsMatch: (liveID, wantID) => liveID === wantID.slice(-8),
      buildAndDeploy: async () => {
        throw new Error("buildAndDeploy must not be called when idsMatch reports a match");
      },
    };

    const result = await deploy(d, dir, "static-site");
    expect(result.alreadyLive).toBe(true);
  });

  it("deploys on a first-ever deploy when nothing is live yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);

    let called = false;
    const d: Deployer = {
      liveContentID: async () => ({ id: "", ok: false }),
      buildAndDeploy: async () => {
        called = true;
      },
    };

    const result = await deploy(d, dir, "static-site");
    expect(result.alreadyLive).toBe(false);
    expect(called).toBe(true);
  });

  it("refuses an invalid build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    // deliberately do NOT write a valid manifest/static-index/routes

    const d: Deployer = {
      liveContentID: async () => ({ id: "", ok: false }),
      buildAndDeploy: async () => {
        throw new Error("must not deploy an invalid build");
      },
    };

    await expect(deploy(d, dir, "static-site")).rejects.toThrow();
  });

  it("calls deployFunctions when the manifest has functions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixtureWithFunction(dir, "ssr");

    let calledWith: string[] = [];
    const d: Deployer = {
      liveContentID: async () => ({ id: "", ok: false }),
      deployFunctions: async (_nboDir, _appName, functionNames) => {
        calledWith = functionNames;
        return { ssr: "http://app-fn-ssr:8080" };
      },
      buildAndDeploy: async () => {},
    };

    await deploy(d, dir, "next-app");
    expect(calledWith).toEqual(["ssr"]);
  });

  it("never calls deployFunctions for a static-only build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir); // functions: []

    const d: Deployer = {
      liveContentID: async () => ({ id: "", ok: false }),
      deployFunctions: async () => {
        throw new Error("deployFunctions must not be called for a static-only build");
      },
      buildAndDeploy: async () => {},
    };

    await deploy(d, dir, "static-site");
  });

  it("refuses when the plan fails for the configured target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    await setRequiredCapabilities(dir, ["prerender.isr"]);

    let called = false;
    const d: Deployer = {
      capabilities: { name: "kubernetes" }, // declares nothing native or emulated
      liveContentID: async () => ({ id: "", ok: false }),
      buildAndDeploy: async () => {
        called = true;
      },
    };

    await expect(deploy(d, dir, "static-site")).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("still deploys when the plan passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    await setRequiredCapabilities(dir, ["fn.streaming"]);

    let called = false;
    const d: Deployer = {
      capabilities: { name: "kubernetes", native: { "fn.streaming": true } },
      liveContentID: async () => ({ id: "", ok: false }),
      buildAndDeploy: async () => {
        called = true;
      },
    };

    await deploy(d, dir, "static-site");
    expect(called).toBe(true);
  });

  // Review finding: nbo deploy only showed the plan on failure, so
  // the spec's "ignored with a warning" (unknown non-critical
  // extensions) and "the plan shows which service and what it costs"
  // (emulated capabilities) never reached a user whose deploy
  // actually succeeded.
  it("exposes the plan when it passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    await setRequiredCapabilities(dir, ["fn.streaming"]);

    const d: Deployer = {
      capabilities: { name: "kubernetes", native: { "fn.streaming": true } },
      liveContentID: async () => ({ id: "", ok: false }),
      buildAndDeploy: async () => {},
    };

    const result = await deploy(d, dir, "static-site");
    expect(result.plan).toContain("fn.streaming");
  });

  it("exposes the plan when already live", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    await setRequiredCapabilities(dir, ["fn.streaming"]);

    const d: Deployer = {
      capabilities: { name: "kubernetes", native: { "fn.streaming": true } },
      liveContentID: async () => {
        const id = await computeTestContentID(dir);
        return { id, ok: true };
      },
      buildAndDeploy: async () => {},
    };

    const result = await deploy(d, dir, "static-site");
    expect(result.alreadyLive).toBe(true);
    expect(result.plan).toContain("fn.streaming");
  });
});

describe("deploy progress", () => {
  // Every now() call advances 1500ms, so each timed step takes 1.5s.
  function clock() {
    let t = 0;
    return () => (t += 1500);
  }

  it("reports the validate and live-check steps in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixtureWithFunction(dir, "ssr");
    const messages: string[] = [];
    const d: Deployer = {
      liveContentID: async () => ({ id: "", ok: false }),
      deployFunctions: async () => ({}),
      buildAndDeploy: async () => {},
    };
    await deploy(d, dir, "next-app", { onProgress: (m) => messages.push(m), now: clock() });
    expect(messages).toEqual(["build validated in 1.5s", "live content id checked in 1.5s"]);
  });

  it("says so when the content id is already live", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    const id = await computeTestContentID(dir);
    const messages: string[] = [];
    const d: Deployer = {
      liveContentID: async () => ({ id, ok: true }),
      buildAndDeploy: async () => {
        throw new Error("must not deploy");
      },
    };
    await deploy(d, dir, "static-site", { onProgress: (m) => messages.push(m), now: clock() });
    expect(messages.at(-1)).toBe(`content id ${id} is already live, skipped`);
  });

  it("reports a failing step and rethrows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    const messages: string[] = [];
    const d: Deployer = { liveContentID: async () => ({ id: "", ok: false }), buildAndDeploy: async () => {} };
    await expect(deploy(d, dir, "x", { onProgress: (m) => messages.push(m), now: clock() })).rejects.toThrow(/refusing to deploy an invalid build/);
    expect(messages).toEqual(["build validation failed after 1.5s"]);
  });

  it("reports the plan step when a planner is configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    const messages: string[] = [];
    const d: Deployer = {
      capabilities: { name: "kubernetes" },
      liveContentID: async () => ({ id: "", ok: false }),
      buildAndDeploy: async () => {},
    };
    await deploy(d, dir, "static-site", { onProgress: (m) => messages.push(m), now: clock() });
    expect(messages).toEqual(["build validated in 1.5s", "plan evaluated in 1.5s", "live content id checked in 1.5s"]);
  });

  it("never fails a deploy because the progress sink throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    const d: Deployer = { liveContentID: async () => ({ id: "", ok: false }), buildAndDeploy: async () => {} };
    await expect(
      deploy(d, dir, "static-site", {
        onProgress: () => {
          throw new Error("sink down");
        },
      }),
    ).resolves.toMatchObject({ alreadyLive: false });
  });

  it("works with no progress options at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    const d: Deployer = { liveContentID: async () => ({ id: "", ok: false }), buildAndDeploy: async () => {} };
    await expect(deploy(d, dir, "static-site")).resolves.toMatchObject({ alreadyLive: false });
  });
});

// setManifestEnv adds manifest.env / bindings to an already-written fixture.
async function setManifestEnv(dir: string, env: Record<string, unknown>, bindings?: { name: string; type: string }[]): Promise<void> {
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.env = env;
  if (bindings) manifest.bindings = bindings;
  await writeFile(manifestPath, canonicalize(manifest));
}

describe("deploy with user environment variables", () => {
  const userEnv = (vars: Record<string, string>, fingerprint: string | null) => ({ vars, secretNames: [], fingerprint });

  it("fails before any cloud call when a required variable is missing, naming it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    await setManifestEnv(dir, { required: ["DATABASE_URL", "API_KEY"] }, [{ name: "cache", type: "redis" }]);
    let cloud = 0;
    const d: Deployer = {
      userEnv: userEnv({ API_KEY: "k" }, "fp1"),
      liveContentID: async () => {
        cloud++;
        return { id: "", ok: false };
      },
      buildAndDeploy: async () => {
        cloud++;
      },
    };
    await expect(deploy(d, dir, "app")).rejects.toThrow(
      new Error("deploy: missing required environment variable(s): DATABASE_URL, CACHE_URL - set them with PUT /projects/{id}/env/{name} or Terraform's nbo_env_var"),
    );
    expect(cloud).toBe(0);
  });

  it("counts user variables and NBO-provided names as available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    await setManifestEnv(dir, { required: ["DATABASE_URL", "NBO_CRON_SIGNING_SECRET"] });
    let deployed = false;
    const d: Deployer = {
      userEnv: userEnv({ DATABASE_URL: "postgres://x" }, "fp1"),
      providedEnvNames: () => ["NBO_CRON_SIGNING_SECRET"],
      liveContentID: async () => ({ id: "", ok: false }),
      buildAndDeploy: async () => {
        deployed = true;
      },
    };
    await deploy(d, dir, "app");
    expect(deployed).toBe(true);
  });

  it("is already live only when the content id AND the fingerprint match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    const id = await computeTestContentID(dir);
    const d: Deployer = {
      userEnv: userEnv({ A: "1" }, "fp1"),
      liveContentID: async () => ({ id, ok: true, fingerprint: "fp1" }),
      buildAndDeploy: async () => {
        throw new Error("must not deploy");
      },
    };
    expect((await deploy(d, dir, "app")).alreadyLive).toBe(true);
  });

  it("redeploys when only the fingerprint differs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    const id = await computeTestContentID(dir);
    for (const [want, live] of [
      ["fp2", "fp1"],
      ["fp2", undefined],
      [null, "fp1"],
    ] as const) {
      let deployed = false;
      const d: Deployer = {
        userEnv: userEnv(want ? { A: "1" } : {}, want),
        liveContentID: async () => ({ id, ok: true, ...(live ? { fingerprint: live } : {}) }),
        buildAndDeploy: async () => {
          deployed = true;
        },
      };
      const r = await deploy(d, dir, "app");
      expect(r.alreadyLive, `${want} vs ${live}`).toBe(false);
      expect(deployed).toBe(true);
    }
  });

  it("a null fingerprint against no stored fingerprint skips exactly as before", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    const id = await computeTestContentID(dir);
    const d: Deployer = {
      userEnv: userEnv({}, null),
      liveContentID: async () => ({ id, ok: true }),
      buildAndDeploy: async () => {
        throw new Error("must not deploy");
      },
    };
    expect((await deploy(d, dir, "app")).alreadyLive).toBe(true);
  });
});

// writePrerenderFixture adds a schema-valid prerender.json with one
// route (function "ssr") and names it in manifest.json's digests.
async function writePrerenderFixture(dir: string): Promise<void> {
  await writeManifestFixtureWithFunction(dir, "ssr");
  const doc = Buffer.from(
    canonicalize({
      version: 1,
      prerenders: [{ id: "/isr", match: "^/isr$", function: "ssr", revalidateSec: 60, expireSec: 31536000, seeds: {}, onMiss: "blocking", bypassToken: { env: "NBO_PRERENDER_BYPASS" } }],
    }),
  );
  await writeFile(join(dir, "prerender.json"), doc);
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.digests["prerender.json"] = sha256Hex(doc);
  await writeFile(manifestPath, canonicalize(manifest));
}

describe("deploy: ISR cache", () => {
  function recordingDeployer(calls: string[], live: { id: string; ok: boolean } = { id: "", ok: false }): Deployer {
    return {
      liveContentID: async () => {
        calls.push("liveContentID");
        return live;
      },
      deployIsrCache: async (_nboDir, appName) => {
        calls.push(`deployIsrCache ${appName}`);
        return `http://${appName}-isr:8080`;
      },
      removeIsrCache: async (appName) => {
        calls.push(`removeIsrCache ${appName}`);
      },
      deployFunctions: async () => {
        calls.push("deployFunctions");
        return {};
      },
      buildAndDeploy: async () => {
        calls.push("buildAndDeploy");
      },
    };
  }

  it("deploys the cache after the live check and before functions for a build with prerender routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writePrerenderFixture(dir);
    const calls: string[] = [];
    await deploy(recordingDeployer(calls), dir, "app");
    expect(calls).toEqual(["liveContentID", "deployIsrCache app", "deployFunctions", "buildAndDeploy"]);
  });

  it("passes the build's directory to deployIsrCache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writePrerenderFixture(dir);
    let gotDir = "";
    const d = recordingDeployer([]);
    d.deployIsrCache = async (nboDir) => {
      gotDir = nboDir;
      return "http://c:8080";
    };
    await deploy(d, dir, "app");
    expect(gotDir).toBe(dir);
  });

  it("calls neither cache step when the build is already live", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writePrerenderFixture(dir);
    const id = await computeTestContentID(dir);
    const calls: string[] = [];
    const r = await deploy(recordingDeployer(calls, { id, ok: true }), dir, "app");
    expect(r.alreadyLive).toBe(true);
    expect(calls).toEqual(["liveContentID"]);
  });

  it("removes the cache after the new app is live when the build has no prerender routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixtureWithFunction(dir, "ssr");
    const calls: string[] = [];
    await deploy(recordingDeployer(calls), dir, "app");
    expect(calls).toEqual(["liveContentID", "deployFunctions", "buildAndDeploy", "removeIsrCache app"]);
  });

  it("reports a failed removal as progress and still succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    const d = recordingDeployer([]);
    d.removeIsrCache = async () => {
      throw new Error("kubectl delete failed: forbidden");
    };
    const lines: string[] = [];
    const r = await deploy(d, dir, "app", { onProgress: (m) => lines.push(m) });
    expect(r.alreadyLive).toBe(false);
    expect(lines.some((l) => l.includes("ISR cache") && l.includes("forbidden"))).toBe(true);
  });

  it("does nothing about the cache without the cache steps (the CLI without prerender routes)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writeManifestFixture(dir);
    const lines: string[] = [];
    const d: Deployer = { liveContentID: async () => ({ id: "", ok: false }), buildAndDeploy: async () => {} };
    await deploy(d, dir, "app", { onProgress: (m) => lines.push(m) });
    expect(lines.filter((l) => l.includes("ISR") || l.includes("uncached"))).toEqual([]);
  });

  it("reports one 'served uncached' line when prerender routes have no cache step (nbo deploy)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writePrerenderFixture(dir);
    const lines: string[] = [];
    const d: Deployer = {
      liveContentID: async () => ({ id: "", ok: false }),
      deployFunctions: async () => ({}),
      buildAndDeploy: async () => {},
    };
    await deploy(d, dir, "app", { onProgress: (m) => lines.push(m) });
    expect(lines.filter((l) => l.includes("uncached"))).toEqual(["prerender routes are served uncached: this deploy runs no ISR cache"]);
  });

  it("reads the cache steps from getters at call time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writePrerenderFixture(dir);
    const calls: string[] = [];
    const isr = { enabled: false };
    const base = recordingDeployer(calls);
    const d: Deployer = {
      liveContentID: base.liveContentID,
      deployFunctions: base.deployFunctions!,
      buildAndDeploy: base.buildAndDeploy,
      get deployIsrCache() {
        return isr.enabled ? base.deployIsrCache : undefined;
      },
    };
    isr.enabled = true;
    await deploy(d, dir, "app");
    expect(calls).toContain("deployIsrCache app");
  });

  it("does not remove the cache when the build has prerender routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-"));
    await writePrerenderFixture(dir);
    const calls: string[] = [];
    await deploy(recordingDeployer(calls), dir, "app");
    expect(calls.some((c) => c.startsWith("removeIsrCache"))).toBe(false);
  });
});
