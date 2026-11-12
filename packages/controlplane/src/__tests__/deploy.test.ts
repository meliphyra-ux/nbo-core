// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner, DeployResult, IsrOptions, ProgressOptions, UserEnv } from "@nbo/deploy";
import { createStore, ErrNotFound, type Store, type Environment } from "../store.js";
import { triggerDeploy, deployAppName, otherAppNames, recordDeployFailure, type Orchestrator } from "../deploy.js";
import { withRevalidateToken } from "../revalidate-tokens.js";
import { canonicalize } from "@nbo/digest";

// Docker builds and the CLI bundle are stubbed below (by file, as @nbo/deploy
// imports them); every other step of the real deploy path runs, and its
// kubectl and docker push calls go to the test's runner.
vi.mock("../../../adapter-k8s/dist/image.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../adapter-k8s/dist/image.js")>()),
  buildImage: vi.fn().mockResolvedValue(undefined),
  buildFunctionImage: vi.fn().mockResolvedValue(undefined),
  buildIsrcacheImage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../deploy/dist/run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../deploy/dist/run.js")>()),
  run: vi.fn().mockResolvedValue(""),
}));
const k8sImages = await import("../../../adapter-k8s/dist/image.js");

// The real targets, recorded: what triggerDeploy sets on them is the test.
type MadeTarget = { carryFrom?: string; userEnv?: UserEnv; extraEnv: Record<string, string>; isr?: IsrOptions; options?: unknown };
const madeTargets: MadeTarget[] = [];
// deployOverride replaces @nbo/deploy's deploy() for one test (no Docker).
let deployOverride: ((nboDir: string, appName: string, progress?: ProgressOptions) => Promise<DeployResult>) | undefined;
vi.mock("@nbo/deploy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@nbo/deploy")>();
  return {
    ...real,
    createKubernetesTarget: (...args: Parameters<typeof real.createKubernetesTarget>) => {
      const t = real.createKubernetesTarget(...args);
      madeTargets.push(Object.assign(t, { options: args[1] }));
      return t;
    },
    createCloudRunTarget: (...args: Parameters<typeof real.createCloudRunTarget>) => {
      const t = real.createCloudRunTarget(...args);
      madeTargets.push(t);
      return t;
    },
    deploy: (...args: Parameters<typeof real.deploy>) => (deployOverride ? deployOverride(args[1], args[2], args[3]) : real.deploy(...args)),
  };
});

afterEach(() => {
  deployOverride = undefined;
  madeTargets.length = 0;
  delete process.env.NBO_PRERENDER_BYPASS;
});

const okResult: DeployResult = { contentID: "sha256:" + "c".repeat(64), alreadyLive: false, url: "http://in-cluster", plan: "" };

// nboDir writes a .nbo/ stand-in: only prerender.json matters here
// (deploy() itself is replaced). isr: one prerender route, or none.
async function nboDir(isr: boolean, manifest: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-deploy-nbo-"));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ specVersion: "1.0", ...manifest }));
  if (isr) {
    await writeFile(
      join(dir, "prerender.json"),
      JSON.stringify({ prerenders: [{ id: "/isr", match: "^/isr$", function: "ssr", revalidateSec: 60, bypassToken: { env: "NBO_PRERENDER_BYPASS" } }] }),
    );
  }
  return dir;
}

function sha256Hex(raw: string | Buffer): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

// validIsrNboDir writes a schema-valid .nbo/ that validate() accepts: one
// static page, one function "ssr" and one prerender route served by it.
async function validIsrNboDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-deploy-valid-"));
  await mkdir(join(dir, "static"), { recursive: true });
  const html = Buffer.from("hi");
  await writeFile(join(dir, "static", "index.html"), html);
  const staticIndex = Buffer.from(
    canonicalize({ files: { "/": { file: "index.html", digest: sha256Hex(html), size: 2, contentType: "text/html; charset=utf-8", cache: "revalidate" } } }),
  );
  await writeFile(join(dir, "static.index.json"), staticIndex);
  const routes = Buffer.from(canonicalize({ version: 1 }));
  await writeFile(join(dir, "routes.json"), routes);
  const bundleDir = join(dir, "functions", "ssr", "bundle");
  await mkdir(bundleDir, { recursive: true });
  const entry = Buffer.from("export default { fetch() {} };");
  await writeFile(join(bundleDir, "index.mjs"), entry);
  const bundleIndex = Buffer.from(canonicalize({ files: { "index.mjs": { digest: sha256Hex(entry), size: entry.length } } }));
  await writeFile(join(bundleDir, "bundle.index.json"), bundleIndex);
  const fn = Buffer.from(
    canonicalize({
      name: "ssr",
      runtime: { kind: "node" },
      handler: { style: "fetch", entry: "index.mjs", export: "default" },
      artifact: { type: "bundle", path: "bundle/", digest: sha256Hex(bundleIndex), files: "bundle.index.json" },
      concurrency: "multi",
    }),
  );
  await writeFile(join(dir, "functions", "ssr", "function.json"), fn);
  const prerender = Buffer.from(
    canonicalize({
      version: 1,
      prerenders: [{ id: "/isr", match: "^/isr$", function: "ssr", revalidateSec: 60, expireSec: 31536000, seeds: {}, onMiss: "blocking", bypassToken: { env: "NBO_PRERENDER_BYPASS" } }],
    }),
  );
  await writeFile(join(dir, "prerender.json"), prerender);
  const manifest = canonicalize({
    specVersion: "1.0",
    build: { id: "b1", createdAt: "2026-10-22T00:00:00Z", framework: { name: "next" } },
    requires: { capabilities: [], extensions: [] },
    functions: ["ssr"],
    digests: {
      "static.index.json": sha256Hex(staticIndex),
      "routes.json": sha256Hex(routes),
      "functions/ssr/function.json": sha256Hex(fn),
      "prerender.json": sha256Hex(prerender),
    },
  });
  await writeFile(join(dir, "manifest.json"), manifest);
  return dir;
}

async function keyedStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-deploy-"));
  const s = createStore(join(dir, "test.db"), { secretKey: randomBytes(32) });
  openStores.push(s);
  return s;
}

const openStores: Store[] = [];

afterEach(() => {
  for (const s of openStores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed by the test itself — fine
    }
  }
});

async function openTestStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "controlplane-deploy-"));
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

describe("triggerDeploy", () => {
  it("generates a cron signing secret before deploying, even though the deploy itself fails", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    const o: Orchestrator = { store: s };

    expect(() => s.getCronSigningSecret(env.id)).toThrow();
    // An empty dir fails @nbo/deploy's own validate() check
    // immediately, before touching Docker/kubectl — a real error
    // from the real call path, no fake/injection needed.
    const emptyDir = await mkdtemp(join(tmpdir(), "controlplane-deploy-empty-"));
    await triggerDeploy(o, env.id, emptyDir);

    const secret = s.getCronSigningSecret(env.id);
    expect(secret).not.toBe("");
  });

  it("rejects an unknown environment", async () => {
    const s = await openTestStore();
    const o: Orchestrator = { store: s };
    await expect(triggerDeploy(o, "nope", "/some/dir")).rejects.toThrow(ErrNotFound);
  });

  it("rejects a Cloud Run environment missing project/region/arRepo before creating any Deployment row", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "cloudrun", "{}"); // no project/region/arRepo
    const o: Orchestrator = { store: s };

    await expect(triggerDeploy(o, env.id, "/some/dir")).rejects.toThrow();
    expect(s.listDeployments(env.id)).toHaveLength(0);
  });

  // store.createEnvironment itself already rejects an unrecognized
  // target (Task 1's own ported test proves it) — Go's own
  // equivalent test discards CreateEnvironment's own error the same
  // way (`env, _ := s.CreateEnvironment(...)`) and proceeds with
  // whatever zero-value id resulted, so it really exercises
  // triggerDeploy's "unknown environment" path, not a genuine
  // switch-default case reached through createEnvironment. Ported
  // faithfully as the same real behavior, not "fixed" into testing
  // something createEnvironment's own validation makes unreachable
  // through the normal API.
  it("rejects an unrecognized target", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const o: Orchestrator = { store: s };
    let environmentId = "";
    try {
      const env = s.createEnvironment(p.id, "production", "not-a-real-target");
      environmentId = env.id;
    } catch {
      // expected — createEnvironment's own validation already rejects
      // this target; environmentId stays "" below.
    }
    await expect(triggerDeploy(o, environmentId, "/some/dir")).rejects.toThrow();
  });

  it("hands carryFrom to the Kubernetes target it builds", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    const emptyDir = await mkdtemp(join(tmpdir(), "controlplane-deploy-empty-"));
    madeTargets.length = 0;
    await triggerDeploy({ store: s }, env.id, emptyDir, { carryFrom: "/previous/.nbo" });
    expect(madeTargets).toHaveLength(1);
    expect(madeTargets[0]!.carryFrom).toBe("/previous/.nbo");
    madeTargets.length = 0;
    await triggerDeploy({ store: s }, env.id, emptyDir);
    expect(madeTargets[0]!.carryFrom).toBeUndefined();
  });

  it("records a real deploy failure as a failed Deployment row", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    const o: Orchestrator = { store: s };

    const emptyDir = await mkdtemp(join(tmpdir(), "controlplane-deploy-empty-"));
    const dep = await triggerDeploy(o, env.id, emptyDir, { buildId: "build_chosen" });
    expect(dep.status).toBe("failed");
    expect(dep.error).not.toBe("");
    // The row records which build it was deploying.
    expect(dep.buildId).toBe("build_chosen");
  });
});

describe("triggerDeploy and the revalidation secret", () => {
  const kubeconfig = "apiVersion: v1\nkind: Config\nusers:\n- name: nbo-controller\n  user:\n    token: SUPERSECRETTOKEN\n";

  it("adds the stage's secret to an ISR build's snapshot as a secret, with its own fingerprint and hashes", async () => {
    const s = await keyedStore();
    const p = s.createProject("shop");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    s.setEnv({ projectId: p.id }, "API_KEY", "user-secret-value", true);
    const snapshot = s.resolveEnv(p.id);
    const fingerprint = s.envFingerprintFor(snapshot);
    let seen: MadeTarget | undefined;
    deployOverride = async () => {
      seen = madeTargets.at(-1);
      return okResult;
    };

    const dep = await triggerDeploy({ store: s }, env.id, await nboDir(true), { env: snapshot, fingerprint });
    expect(dep.status).toBe("succeeded");
    const token = s.getRevalidateToken(s.productionStage(p.id).id)!.token;
    const ue = seen!.userEnv!;
    expect(ue.vars.NBO_PRERENDER_BYPASS).toBe(token);
    expect(ue.vars.API_KEY).toBe("user-secret-value");
    expect(ue.secretNames).toEqual(["API_KEY", "NBO_PRERENDER_BYPASS"]);
    const withToken = withRevalidateToken(s, s.productionStage(p.id), snapshot);
    expect(ue.fingerprint).toBe(s.envFingerprintFor(withToken));
    expect(ue.fingerprint).not.toBe(fingerprint);
    expect(ue.secretHashes).toEqual(s.envSecretHashes(withToken));
    expect(seen!.isr).toEqual({ enabled: true, removeCache: false });
    // The caller's snapshot is not changed.
    expect(snapshot.vars.NBO_PRERENDER_BYPASS).toBeUndefined();
  });

  it("leaves a build without prerender routes exactly as before: same fingerprint, no secret, no token row", async () => {
    const s = await keyedStore();
    const p = s.createProject("shop");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    s.setEnv({ projectId: p.id }, "PLAIN", "plain-value", false);
    s.setEnv({ projectId: p.id }, "API_KEY", "user-secret-value", true);
    const snapshot = s.resolveEnv(p.id);
    const fingerprint = s.envFingerprintFor(snapshot);
    let seen: MadeTarget | undefined;
    deployOverride = async () => {
      seen = madeTargets.at(-1);
      return okResult;
    };

    await triggerDeploy({ store: s }, env.id, await nboDir(false), { env: snapshot, fingerprint });
    const ue = seen!.userEnv!;
    expect(ue.fingerprint).toBe(fingerprint);
    expect(ue.vars).toEqual({ PLAIN: "plain-value", API_KEY: "user-secret-value" });
    expect(ue.vars.NBO_PRERENDER_BYPASS).toBeUndefined();
    expect(ue.secretNames).toEqual(["API_KEY"]);
    expect(ue.secretHashes).toEqual(s.envSecretHashes(snapshot));
    expect(s.getRevalidateToken(s.productionStage(p.id).id)).toBeUndefined();
    expect(seen!.isr).toEqual({ enabled: false, removeCache: false });

    // No variables at all: the fingerprint stays null.
    const bare = s.createProject("bare");
    const bareEnv = s.createEnvironment(bare.id, "production", "kubernetes");
    await triggerDeploy({ store: s }, bareEnv.id, await nboDir(false), { env: { vars: {}, secretNames: [] }, fingerprint: null });
    expect(madeTargets.at(-1)!.userEnv!.fingerprint).toBeNull();
    expect(madeTargets.at(-1)!.userEnv!.secretHashes).toBeUndefined();
  });

  it("gives an ephemeral stage's deploy its own secret, not Production's", async () => {
    const s = await keyedStore();
    const p = s.createProject("shop");
    const prodToken = s.ensureRevalidateToken(s.productionStage(p.id).id).token;
    const pv = s.createEphemeralStage(p.id, { branch: "feature/x", host: "feature-x--shop.127.0.0.1.sslip.io", expiresAt: "", label: "" });
    const env = s.createEnvironment(p.id, "pv-k8s", "kubernetes", "{}", pv.id);
    deployOverride = async () => okResult;

    await triggerDeploy({ store: s }, env.id, await nboDir(true));
    const got = madeTargets.at(-1)!.userEnv!.vars.NBO_PRERENDER_BYPASS;
    expect(got).toBe(s.getRevalidateToken(pv.id)!.token);
    expect(got).not.toBe(prodToken);
  });

  it("removes the cache only when the cloud's previous build had prerender routes and this one has none", async () => {
    const s = await keyedStore();
    const p = s.createProject("shop");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    deployOverride = async () => okResult;
    const isrDir = await nboDir(true);
    const plainDir = await nboDir(false);
    const cases: [string, string | undefined, IsrOptions][] = [
      [plainDir, isrDir, { enabled: false, removeCache: true }],
      [plainDir, plainDir, { enabled: false, removeCache: false }],
      [plainDir, undefined, { enabled: false, removeCache: false }],
      [isrDir, isrDir, { enabled: true, removeCache: false }],
      [isrDir, plainDir, { enabled: true, removeCache: false }],
    ];
    for (const [dir, carryFrom, want] of cases) {
      await triggerDeploy({ store: s }, env.id, dir, carryFrom ? { carryFrom } : undefined);
      expect(madeTargets.at(-1)!.isr).toEqual(want);
    }
  });

  it("sets isr on the Cloud Run target too", async () => {
    const s = await keyedStore();
    const p = s.createProject("shop");
    const env = s.createEnvironment(p.id, "cloudrun", "cloudrun", JSON.stringify({ project: "proj", region: "us-central1", arRepo: "us-central1-docker.pkg.dev/proj/nbo" }));
    deployOverride = async () => okResult;
    await triggerDeploy({ store: s }, env.id, await nboDir(true));
    expect(madeTargets.at(-1)!.isr).toEqual({ enabled: true, removeCache: false });
    expect(madeTargets.at(-1)!.userEnv!.secretNames).toContain("NBO_PRERENDER_BYPASS");
  });

  it("still delivers the secret when the workspace keeps variable names only", async () => {
    const s = await keyedStore();
    const p = s.createProject("shop");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    s.clearStoredValues();
    deployOverride = async () => okResult;
    const snapshot = s.resolveEnv(p.id, "production", {});
    await triggerDeploy({ store: s }, env.id, await nboDir(true), { env: snapshot, fingerprint: s.envFingerprintFor(snapshot) });
    const ue = madeTargets.at(-1)!.userEnv!;
    expect(ue.vars.NBO_PRERENDER_BYPASS).toBe(s.getRevalidateToken(s.productionStage(p.id).id)!.token);
    expect(ue.fingerprint).not.toBeNull();
  });

  it("keeps the secret out of the image, every runner argument, progress and a recorded error (production Kubernetes, real deploy path)", async () => {
    const s = await keyedStore();
    const cid = s.saveKubernetesConnection(
      { name: "prod", server: "https://k8s.example:6443", registry: { kind: "custom", server: "ghcr.io", username: "bot" } },
      { kubeconfig, registryPassword: "REGPASSWORD" },
    ).id;
    const p = s.createProject("shop");
    const env = s.createEnvironment(p.id, "production", "kubernetes", JSON.stringify({ clusterId: cid }));
    const token = s.ensureRevalidateToken(s.productionStage(p.id).id).token;
    // NBO's own environment has a value too: it must not be baked either.
    process.env.NBO_PRERENDER_BYPASS = "operator-own-value";

    // The fake runner gets every kubectl and docker push call the real
    // Kubernetes target makes (Docker builds and the CLI bundle are stubbed).
    const token64 = Buffer.from(token, "utf8").toString("base64");
    let failSecretApply = false;
    const calls: { cmd: string; args: string[]; input?: string }[] = [];
    const run: CommandRunner = async (cmd, args, opts) => {
      calls.push({ cmd, args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
      if (failSecretApply && cmd === "kubectl" && args.includes("apply") && opts?.input?.includes(token64)) {
        throw new Error(`kubectl apply: exit status 1: The Secret "x-env" is invalid: data[NBO_PRERENDER_BYPASS]: ${token}`);
      }
      return "";
    };
    const lines: string[] = [];
    const dir = await validIsrNboDir();

    const dep = await triggerDeploy({ store: s, mode: "production", run }, env.id, dir, { progress: (m) => lines.push(m) });
    expect(dep.status).toBe("succeeded");

    // The images: the app's /functions.json and /env.json, each function's env.json, the cache image.
    const appImage = vi.mocked(k8sImages.buildImage).mock.calls.at(-1)!;
    expect(appImage[3]).toHaveProperty("__isrcache");
    expect(appImage[4]).not.toHaveProperty("NBO_PRERENDER_BYPASS");
    expect(JSON.stringify(appImage)).not.toContain(token);
    expect(JSON.stringify(appImage)).not.toContain("operator-own-value");
    const fnImage = vi.mocked(k8sImages.buildFunctionImage).mock.calls.at(-1)!;
    expect(JSON.stringify(fnImage)).not.toContain(token);
    expect(vi.mocked(k8sImages.buildIsrcacheImage)).toHaveBeenCalled();
    // The real target delivered the value: on stdin, in the <app>-env Secret, and nowhere else.
    expect(calls.some((c) => c.cmd === "kubectl" && c.args.includes("apply") && (c.input ?? "").includes(token64))).toBe(true);
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      expect(c.args.join(" ")).not.toContain(token);
      expect(c.args.join(" ")).not.toContain(token64);
    }
    expect(lines.join("\n")).not.toContain(token);

    // A failure carrying the value is recorded redacted.
    failSecretApply = true;
    const failed = await triggerDeploy({ store: s, mode: "production", run }, env.id, dir, { progress: (m) => lines.push(m) });
    for (const c of calls) expect(c.args.join(" ")).not.toContain(token);
    expect(lines.join("\n")).not.toContain(token);
    expect(failed.status).toBe("failed");
    expect(failed.error).not.toContain(token);
    expect(failed.error).toContain("[redacted]");
  });
});

describe("recordDeployFailure", () => {
  it("throws when recording the failure also fails", async () => {
    const s = await openTestStore();
    const p = s.createProject("acme");
    const env = s.createEnvironment(p.id, "production", "kubernetes");
    const dep = s.createDeployment(env.id);
    s.close(); // the store becomes unusable right when recording the failure is attempted

    expect(() => recordDeployFailure(s, dep.id, new Error("deploy exploded"))).toThrow();
  });
});

describe("otherAppNames", () => {
  it("lists the app names of the project's other cloud rows, archived and every stage included", async () => {
    const s = await openTestStore();
    const p = s.createProject("shop");
    const k8s = s.createEnvironment(p.id, "k8s", "kubernetes");
    const isr = s.createEnvironment(p.id, "k8s-isr", "kubernetes");
    const gone = s.createEnvironment(p.id, "cloudrun", "cloudrun", "{}");
    s.archiveEnvironment(gone.id);
    const stage = s.createStage(p.id, { name: "staging", branch: "dev", host: "staging--shop.example.com" });
    const staged = s.createEnvironment(p.id, "s-staging-k8s", "kubernetes", "{}", stage.id);
    const other = s.createProject("other");
    s.createEnvironment(other.id, "k8s", "kubernetes");
    expect(otherAppNames(s, k8s).sort()).toEqual([deployAppName(isr), deployAppName(gone), deployAppName(staged)].sort());
    expect(otherAppNames(s, k8s)).toContain(`${deployAppName(k8s)}-isr`);
  });
});

describe("deployAppName", () => {
  it("combines the project and environment", () => {
    const env: Environment = { id: "", projectId: "proj_abcdef1234567890", name: "production", target: "kubernetes", config: "{}", createdAt: "" };
    expect(deployAppName(env)).toBe("pabcdef12-production");
  });

  it("differs across projects for the same environment name", () => {
    const a = deployAppName({ id: "", projectId: "proj_aaaaaaaa00000000", name: "production", target: "kubernetes", config: "{}", createdAt: "" });
    const b = deployAppName({ id: "", projectId: "proj_bbbbbbbb00000000", name: "production", target: "kubernetes", config: "{}", createdAt: "" });
    expect(a).not.toBe(b);
  });

  // Kubernetes Service names are DNS-1035 labels, which — unlike
  // Deployment names (DNS-1123) — must start with a letter, not a
  // digit. A project id's random hex suffix can (and, being hex,
  // very often does) start with a digit.
  it("always starts with a lowercase letter", () => {
    const env: Environment = { id: "", projectId: "proj_0123456789abcdef", name: "production", target: "kubernetes", config: "{}", createdAt: "" };
    const got = deployAppName(env);
    expect(got[0]).toMatch(/[a-z]/);
  });
});
