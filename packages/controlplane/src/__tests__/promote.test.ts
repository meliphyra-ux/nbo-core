// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startHarness, deployedProject, bothClouds, type Harness } from "./v2-harness.js";
import { createRunner } from "../runner.js";
import { createBuildQueue } from "../build-queue.js";
import { createSuppliedValues } from "../supplied-values.js";
import { transferConfig } from "../transfer.js";

let h: Harness;
const defaultStepDelayMs = transferConfig.stepDelayMs;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  transferConfig.stepDelayMs = defaultStepDelayMs;
  await h.close();
});

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// twoBuilds: a project on both clouds that has built the first commit
// (A) and then a second one (B), both deployed everywhere.
async function twoBuilds(): Promise<{ id: string; a: string; b: string; k8s: string; cr: string }> {
  const id = await deployedProject(h, { clouds: bothClouds });
  const a = h.store.listBuilds(id)[0]!.id;
  await h.commit("second");
  expect((await h.call("POST", `/projects/${id}/builds`)).status).toBe(202);
  await h.v2.queue.idle(id);
  const b = h.store.listBuilds(id)[1]!.id;
  expect(h.store.getBuild(b).status).toBe("succeeded");
  const [k8s, cr] = h.store.listEnvironments(id);
  return { id, a, b, k8s: k8s!.id, cr: cr!.id };
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath, e.name));
  }
  return out;
}

describe("deploy a chosen build (promote)", () => {
  it("deploys a stored build's .nbo/ to the chosen cloud only, without rebuilding", async () => {
    const { id, a, b, k8s, cr } = await twoBuilds();
    const deploysBefore = h.deploys.deployed.length;
    const putsBefore = h.edgePuts.length;

    const res = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ kind: "promote", sourceBuildId: a, targetEnvironmentId: cr, projectId: id });
    expect(res.json.log).toBeUndefined();
    await h.v2.queue.idle(id);

    const job = h.store.getBuild(res.json.id);
    expect(job.status).toBe("succeeded");
    expect(job.revision).toBe(h.store.getBuild(a).revision);
    expect(job.commit?.message).toBe("initial");
    expect(job.deploymentIds).toHaveLength(1);
    const dep = h.store.getDeployment(job.deploymentIds[0]!);
    expect(dep).toMatchObject({ environmentId: cr, buildId: a, status: "succeeded" });
    expect(h.deploys.deployed.slice(deploysBefore)).toEqual([cr]);
    expect(h.deploys.dirs[h.deploys.dirs.length - 1]).toBe(h.artifacts.path(a));
    expect(job.log).not.toContain("git clone");
    expect(job.timeline?.map((e) => [e.name, e.status])).toEqual([
      ["validate", "succeeded"],
      ["deploy cloudrun", "succeeded"],
    ]);
    expect(job.input?.envFingerprint).toBe(h.store.getBuild(b).input?.envFingerprint);
    // The edge is re-synced, and the split is left alone.
    expect(h.edgePuts.length).toBeGreaterThan(putsBefore);
    expect(h.store.listEnvironments(id).map((e) => e.trafficWeight)).toEqual([100, 0]);

    const summary = (await h.call("GET", `/projects/${id}/summary`)).json;
    const live = Object.fromEntries(summary.environments.map((e: any) => [e.id, e.liveBuild]));
    expect(live[cr]).toEqual({ id: a, revision: h.store.getBuild(a).revision, message: "initial", artifact: true });
    expect(live[k8s]).toEqual({ id: b, revision: h.store.getBuild(b).revision, message: "second", artifact: true });
  });

  it("deploying a promote job's id deploys the build it promoted", async () => {
    const { id, a, cr, k8s } = await twoBuilds();
    const first = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await h.v2.queue.idle(id);
    const again = await h.call("POST", `/builds/${first.json.id}/deploy`, { environmentId: k8s });
    expect(again.status).toBe(202);
    expect(again.json.sourceBuildId).toBe(a);
    await h.v2.queue.idle(id);
    expect(h.store.getBuild(again.json.id).status).toBe("succeeded");
  });

  it("refuses a build whose stored output no longer validates", async () => {
    const { id, a, cr } = await twoBuilds();
    const dir = h.artifacts.path(a)!;
    const staticFile = (await filesUnder(dir)).find((f) => f.includes(`${join("static")}`) && f.endsWith(".html"))!;
    await appendFile(staticFile, "tampered");
    const deploysBefore = h.deploys.deployed.length;

    const res = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await h.v2.queue.idle(id);
    const job = h.store.getBuild(res.json.id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("This build's stored output is damaged: rebuild it");
    expect(job.timeline?.map((e) => [e.name, e.status])).toEqual([["validate", "failed"]]);
    expect(h.deploys.deployed.length).toBe(deploysBefore);
  });

  it("refuses a build whose stored output has a different content id than was recorded", async () => {
    const { id, a, cr } = await twoBuilds();
    h.store.setBuildDetails(a, { contentId: "sha256:something-else" });
    const deploysBefore = h.deploys.deployed.length;
    const res = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await h.v2.queue.idle(id);
    const job = h.store.getBuild(res.json.id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("This build's stored output is damaged: rebuild it");
    expect(h.deploys.deployed.length).toBe(deploysBefore);
  });

  it("fails clearly when the stored output is gone", async () => {
    const { id, a, cr } = await twoBuilds();
    await h.artifacts.remove(a);
    const res = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await h.v2.queue.idle(id);
    const job = h.store.getBuild(res.json.id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("This build's stored output was cleaned up: rebuild it to deploy it");
  });

  it("a deploy failure is recorded on the job", async () => {
    const { id, a, cr } = await twoBuilds();
    h.deploys.failTargets.add("cloudrun");
    const res = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await h.v2.queue.idle(id);
    const job = h.store.getBuild(res.json.id);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("cloudrun");
    expect(job.deploymentIds).toHaveLength(1);
  });

  it("holds the build's output while the promote runs", async () => {
    const { id, a, cr } = await twoBuilds();
    h.deploys.delayMs = 300;
    const res = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await waitFor(() => (h.deploys.deployed.length > 0 && h.store.getBuild(res.json.id).status === "running" ? true : undefined));
    const removed = await h.artifacts.prune(id, () => false);
    expect(removed).not.toContain(a);
    expect(h.artifacts.path(a)).not.toBeNull();
    await h.v2.queue.idle(id);
    expect(h.store.getBuild(res.json.id).status).toBe("succeeded");
  });

  it("runs in the project's queue: never alongside a build, and never superseded by a newer commit", async () => {
    const { id, a, cr } = await twoBuilds();
    h.deploys.delayMs = 150;
    await h.commit("third");
    const build1 = await h.call("POST", `/projects/${id}/builds`);
    const promote = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    expect(h.store.getBuild(promote.json.id).status).toBe("queued");
    await h.commit("fourth");
    const build2 = await h.call("POST", `/projects/${id}/builds`);
    expect(h.store.getBuild(promote.json.id).status).toBe("queued");
    await h.v2.queue.idle(id);

    const b1 = h.store.getBuild(build1.json.id);
    const p = h.store.getBuild(promote.json.id);
    const b2 = h.store.getBuild(build2.json.id);
    expect([b1.status, p.status, b2.status]).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(p.startedAt >= b1.finishedAt).toBe(true);
    expect(b2.startedAt >= p.finishedAt).toBe(true);
  });

  it("rejects bad requests", async () => {
    const { id, a, cr } = await twoBuilds();
    expect((await h.call("POST", `/builds/${a}/deploy`, {})).status).toBe(400);
    expect((await h.call("POST", `/builds/${a}/deploy`, { environmentId: 7 })).status).toBe(400);
    expect((await h.call("POST", `/builds/build_missing/deploy`, { environmentId: cr })).status).toBe(404);
    expect((await h.call("POST", `/builds/${a}/deploy`, { environmentId: "env_missing" })).status).toBe(404);

    // An environment of another project.
    const other = h.store.createProject("other");
    const otherEnv = h.store.createEnvironment(other.id, "k8s", "kubernetes");
    expect((await h.call("POST", `/builds/${a}/deploy`, { environmentId: otherEnv.id })).status).toBe(400);

    // A build that did not succeed, or whose output is not kept.
    const failed = h.store.createQueuedBuild(id, "c".repeat(40));
    h.store.completeBuild(failed.id, "failed", [], "boom");
    expect((await h.call("POST", `/builds/${failed.id}/deploy`, { environmentId: cr })).status).toBe(400);
    h.store.setBuildDetails(a, { artifact: false });
    const gone = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    expect(gone.status).toBe(400);
    expect(gone.json.error).toBe("This build's output was cleaned up: rebuild it to deploy it");

    // An archived environment.
    h.store.setBuildDetails(a, { artifact: true });
    h.store.archiveEnvironment(cr);
    expect((await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr })).status).toBe(400);
  });
});

describe("per-cloud auto-deploy", () => {
  it("new commits deploy only to clouds with auto-deploy on; the others keep their build", async () => {
    const { id, a, b, k8s, cr } = await twoBuilds();
    // cloudrun runs A, then stops taking new commits.
    await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await h.v2.queue.idle(id);
    const patched = await h.call("PATCH", `/environments/${cr}`, { autoDeploy: false });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ id: cr, autoDeploy: false });
    expect(patched.json.config).toEqual(expect.any(Object));

    await h.commit("third");
    const deploysBefore = h.deploys.deployed.length;
    const res = await h.call("POST", `/projects/${id}/builds`);
    await h.v2.queue.idle(id);
    const build = h.store.getBuild(res.json.id);
    expect(build.status).toBe("succeeded");
    expect(h.deploys.deployed.slice(deploysBefore)).toEqual([k8s]);
    const summary = (await h.call("GET", `/projects/${id}/summary`)).json;
    const env = (envId: string) => summary.environments.find((e: any) => e.id === envId);
    expect(env(cr).liveBuild.id).toBe(a);
    expect(env(cr).autoDeploy).toBe(false);
    expect(env(k8s).liveBuild.id).toBe(build.id);
    expect(b).not.toBe(build.id);
  });

  it("with no cloud taking new commits, a build still builds and keeps its output", async () => {
    const { id, b: before, k8s, cr } = await twoBuilds();
    await h.call("PATCH", `/environments/${k8s}`, { autoDeploy: false });
    await h.call("PATCH", `/environments/${cr}`, { autoDeploy: false });
    await h.commit("third");
    const deploysBefore = h.deploys.deployed.length;
    const res = await h.call("POST", `/projects/${id}/builds`);
    await h.v2.queue.idle(id);
    const build = h.store.getBuild(res.json.id);
    expect(build).toMatchObject({ status: "succeeded", deploymentIds: [], artifact: true, error: "", note: "Built — no cloud set to deploy new commits automatically" });
    // The production build is still the one the clouds serve.
    const summary = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(summary.productionBuild.id).toBe(before);
    expect(summary.latestBuild.note).toBe("Built — no cloud set to deploy new commits automatically");
    expect(build.log).toContain("Built — no cloud set to deploy new commits automatically");
    expect(h.deploys.deployed.length).toBe(deploysBefore);
    expect(h.artifacts.path(build.id)).not.toBeNull();
  });

  it("PATCH /environments/{id} accepts only autoDeploy as a boolean", async () => {
    const { cr } = await twoBuilds();
    expect((await h.call("PATCH", `/environments/${cr}`, { autoDeploy: "no" })).status).toBe(400);
    expect((await h.call("PATCH", `/environments/${cr}`, { autoDeploy: false, name: "x" })).status).toBe(400);
    expect((await h.call("PATCH", `/environments/${cr}`, [])).status).toBe(400);
    expect((await h.call("PATCH", `/environments/env_missing`, { autoDeploy: false })).status).toBe(404);
    expect(h.store.getEnvironment(cr).autoDeploy).toBe(true);
  });
});

describe("variables fingerprint", () => {
  it("GET /projects/{id}/env/fingerprint matches a build's recorded fingerprint until a variable changes", async () => {
    const { id, b } = await twoBuilds();
    const before = await h.call("GET", `/projects/${id}/env/fingerprint`);
    expect(before.status).toBe(200);
    expect(Object.keys(before.json)).toEqual(["fingerprint"]);
    expect(before.json.fingerprint).toBe((await h.call("GET", `/builds/${b}`)).json.input.envFingerprint);
    expect((await h.call("PUT", `/projects/${id}/env/API_URL`, { value: "https://api.example.com", secret: false })).status).toBe(200);
    const after = await h.call("GET", `/projects/${id}/env/fingerprint`);
    expect(after.json.fingerprint).not.toBe(before.json.fingerprint);
    expect(after.text).not.toContain("api.example.com");
    expect((await h.call("GET", `/projects/proj_missing/env/fingerprint`)).status).toBe(404);
  });
});

describe("promote review follow-ups", () => {
  it("a promote to a cloud with no traffic does not change the production build", async () => {
    const { id, a, b, cr } = await twoBuilds();
    await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await h.v2.queue.idle(id);
    const summary = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(summary.latestBuild.kind).toBe("promote");
    expect(summary.productionBuild.id).toBe(b);
  });

  it("the production build follows the cloud with the most traffic", async () => {
    const { id, a, k8s, cr } = await twoBuilds();
    await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await h.v2.queue.idle(id);
    h.store.setTrafficWeights(id, { [k8s]: 10, [cr]: 90 });
    expect((await h.call("GET", `/projects/${id}/summary`)).json.productionBuild.id).toBe(a);
  });

  it("a promote when no cloud has traffic gives the promoted cloud 100%", async () => {
    const { id, a, k8s, cr } = await twoBuilds();
    h.store.setTrafficWeights(id, { [k8s]: 0, [cr]: 0 });
    await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await h.v2.queue.idle(id);
    expect([h.store.getEnvironment(k8s).trafficWeight, h.store.getEnvironment(cr).trafficWeight]).toEqual([0, 100]);
  });

  it("a newer commit supersedes a queued commit build but not a promote queued between them", async () => {
    const { id, a, cr } = await twoBuilds();
    h.deploys.delayMs = 150;
    await h.commit("third");
    const running = await h.call("POST", `/projects/${id}/builds`);
    expect(running.json.status).toBe("running");
    await h.commit("fourth");
    const queued = await h.call("POST", `/projects/${id}/builds`);
    expect(queued.json.status).toBe("queued");
    const promote = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await h.commit("fifth");
    const newest = await h.call("POST", `/projects/${id}/builds`);
    expect(h.store.getBuild(queued.json.id)).toMatchObject({ status: "skipped", error: "superseded by a newer build" });
    expect(h.store.getBuild(promote.json.id).status).toBe("queued");
    await h.v2.queue.idle(id);
    const p = h.store.getBuild(promote.json.id);
    const n = h.store.getBuild(newest.json.id);
    expect([p.status, n.status]).toEqual(["succeeded", "succeeded"]);
    expect(p.startedAt >= h.store.getBuild(running.json.id).finishedAt).toBe(true);
    expect(n.startedAt >= p.finishedAt).toBe(true);
  });

  it("an error inside a promote still releases the hold on the build's output", async () => {
    const { id, a, cr } = await twoBuilds();
    const runner = createRunner(h.store, h.deploys, {
      artifacts: h.artifacts,
      holdSharedWork: () => {
        throw new Error("shared work exploded");
      },
    });
    const job = h.store.createQueuedPromote(id, a, cr);
    await runner.runBuild(job.id);
    expect(h.store.getBuild(job.id)).toMatchObject({ status: "failed", error: "shared work exploded" });
    expect(await h.artifacts.prune(id, (bid) => bid !== a)).toEqual([a]);
  });

  it("a transfer fails clearly when the source's live build lost its output after it started", async () => {
    transferConfig.stepDelayMs = 10;
    const id = await deployedProject(h);
    h.deploys.delayMs = 200;
    await h.commit("second");
    await h.call("POST", `/projects/${id}/builds`); // running: the transfer waits for it
    const res = await h.call("POST", `/projects/${id}/transfer`, { target: "cloudrun", mode: "auto" });
    expect(res.status).toBe(202);
    // The build now running becomes live on the source; its output goes missing.
    const second = h.store.listBuilds(id)[1]!;
    await waitFor(() => (h.store.getBuild(second.id).artifact ? true : undefined));
    h.store.setBuildDetails(second.id, { artifact: false });
    await h.v2.transfers.settled(id);
    const t = h.store.getTransfer(res.json.id);
    expect(t.status).toBe("failed");
    expect(t.error).toMatch(/no stored output/);
  });
});

describe("final review follow-ups", () => {
  it("retention keeps the source of a queued promote, so the promote still succeeds", async () => {
    const { id, a, cr } = await twoBuilds();
    // A runner that keeps no build beyond the live ones: without the
    // queued promote counting, the build before it would prune A.
    const runner = createRunner(h.store, h.deploys, { artifacts: h.artifacts, keepBuilds: 0 });
    const queue = createBuildQueue(h.store, runner, createSuppliedValues());
    h.deploys.delayMs = 100;
    const sha = await h.commit("third");
    const build = queue.enqueue(id, sha);
    expect(h.store.getBuild(build.id).status).toBe("running");
    const promote = queue.enqueuePromote(id, a, cr);
    expect(h.store.getBuild(promote.id).status).toBe("queued");
    await queue.idle(id);
    expect(h.store.getBuild(build.id).status).toBe("succeeded");
    expect(h.store.getBuild(promote.id)).toMatchObject({ status: "succeeded", error: "" });
    expect(h.store.getBuild(a).artifact).toBe(true);
  });

  it("refuses a second deploy of the same build to the same cloud while one is queued or running", async () => {
    const { id, a, k8s, cr } = await twoBuilds();
    h.deploys.delayMs = 150;
    const first = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    expect(first.status).toBe(202);
    const again = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("A deploy of this build to this cloud is already queued");
    // Through the promote job's own id too.
    expect((await h.call("POST", `/builds/${first.json.id}/deploy`, { environmentId: cr })).status).toBe(409);
    // Another cloud is fine.
    expect((await h.call("POST", `/builds/${a}/deploy`, { environmentId: k8s })).status).toBe(202);
    await h.v2.queue.idle(id);
    // Once it has finished, deploying again is allowed.
    expect((await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr })).status).toBe(202);
    await h.v2.queue.idle(id);
  });

  it("PATCH /environments/{id} refuses an archived environment", async () => {
    const { cr } = await twoBuilds();
    h.store.archiveEnvironment(cr);
    const res = await h.call("PATCH", `/environments/${cr}`, { autoDeploy: false });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/archived/);
    expect(h.store.getEnvironment(cr).autoDeploy).toBe(true);
  });

  it("the summary exposes each live build's stored-output flag and the production cloud's live deployment", async () => {
    const { id, a, b, k8s, cr } = await twoBuilds();
    const promote = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await h.v2.queue.idle(id);
    h.store.setTrafficWeights(id, { [k8s]: 10, [cr]: 90 });
    const summary = (await h.call("GET", `/projects/${id}/summary`)).json;
    const env = (envId: string) => summary.environments.find((e: any) => e.id === envId);
    expect(env(cr).liveBuild).toMatchObject({ id: a, artifact: true });
    expect(env(k8s).liveBuild).toMatchObject({ id: b, artifact: true });
    expect(summary.productionBuild.id).toBe(a);
    const dep = h.store.getDeployment(h.store.getBuild(promote.json.id).deploymentIds[0]!);
    expect(summary.productionDeployment).toEqual({ id: dep.id, createdAt: dep.createdAt, environmentId: cr });
    expect(summary.productionDeployment.id).not.toBe(h.store.getBuild(a).deploymentId);

    h.store.setBuildDetails(a, { artifact: false });
    expect((await h.call("GET", `/projects/${id}/summary`)).json.environments.find((e: any) => e.id === cr).liveBuild.artifact).toBe(false);
  });
});

describe("carrying the cloud's live build into the next deploy", () => {
  it("a second commit build passes the first build's output as carryFrom; a first deploy passes none", async () => {
    const { a, b } = await twoBuilds();
    expect(h.deploys.options.slice(0, 2).map((o) => o.carryFrom)).toEqual([undefined, undefined]);
    const later = h.deploys.options.slice(2);
    expect(later).toHaveLength(2);
    for (const o of later) expect(o).toMatchObject({ buildId: b, carryFrom: h.artifacts.path(a) });
  });

  it("a pruned previous build passes none and the build log says so", async () => {
    const id = await deployedProject(h);
    const a = h.store.listBuilds(id)[0]!.id;
    await h.artifacts.remove(a);
    await h.commit("second");
    await h.call("POST", `/projects/${id}/builds`);
    await h.v2.queue.idle(id);
    const second = h.store.listBuilds(id)[1]!;
    expect(second.status).toBe("succeeded");
    expect(h.deploys.options[h.deploys.options.length - 1]!.carryFrom).toBeUndefined();
    expect(second.log).toContain("No previous build output to keep");
  });

  it("a promote of build X onto a cloud running Y passes Y's output", async () => {
    const { id, a, b, cr } = await twoBuilds();
    await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await h.v2.queue.idle(id);
    const last = h.deploys.options[h.deploys.options.length - 1]!;
    expect(last).toMatchObject({ buildId: a, carryFrom: h.artifacts.path(b) });
    const job = h.store.listBuilds(id).find((x) => x.kind === "promote")!;
    expect(job.log).toContain(`Keeping the files of build ${h.store.getBuild(b).revision.slice(0, 7)} during the rollout`);
  });

  it("a promote onto a cloud already running that build carries nothing", async () => {
    const { id, b, cr } = await twoBuilds();
    await h.call("POST", `/builds/${b}/deploy`, { environmentId: cr });
    await h.v2.queue.idle(id);
    expect(h.deploys.options[h.deploys.options.length - 1]!.carryFrom).toBeUndefined();
  });

  it("a prune run while the deploy is in flight keeps the previous build, and releases it afterwards", async () => {
    const { id, a, b, cr } = await twoBuilds();
    h.deploys.delayMs = 300;
    const res = await h.call("POST", `/builds/${a}/deploy`, { environmentId: cr });
    await new Promise((r) => setTimeout(r, 100));
    const removed = await h.artifacts.prune(id, () => false);
    expect(removed).not.toContain(b);
    expect(h.artifacts.path(b)).not.toBeNull();
    await h.v2.queue.idle(id);
    expect(h.store.getBuild(res.json.id).status).toBe("succeeded");
    expect(await h.artifacts.prune(id, () => false)).toContain(b);
  });
});

describe("builds per stage", () => {
  // stagingProject: a deployed Production project plus a staging stage with
  // one Kubernetes cloud.
  async function stagingProject() {
    const id = await deployedProject(h);
    const staging = h.store.createStage(id, { name: "staging", branch: "staging", host: "" });
    const row = h.store.createEnvironment(id, "s-staging-k8s", "kubernetes", undefined, staging.id);
    return { id, staging, row, prod: h.store.listEnvironments(id)[0]! };
  }

  it("a staging build deploys only to staging; promoting it to a Production cloud uses Production variables", async () => {
    const { id, staging, row, prod } = await stagingProject();
    h.store.setSecretKey(randomBytes(32)); // the variables fingerprint is keyed
    expect((await h.call("PUT", `/projects/${id}/env/API_URL`, { value: "https://prod.example.com", secret: false })).status).toBe(200);
    expect((await h.call("PUT", `/projects/${id}/env/API_URL?stage=staging`, { value: "https://staging.example.com", secret: false })).status).toBe(200);
    const before = h.deploys.deployed.length;

    const res = await h.call("POST", `/projects/${id}/builds`, { stage: "staging", revision: h.head });
    expect(res.status).toBe(202);
    expect(res.json.stageId).toBe(staging.id);
    await h.v2.queue.idle(id);
    const built = h.store.getBuild(res.json.id);
    expect(built.status).toBe("succeeded");
    expect(h.deploys.deployed.slice(before)).toEqual([row.id]);
    expect(h.deploys.options[h.deploys.options.length - 1]!.env?.vars).toEqual({ API_URL: "https://staging.example.com" });

    const promote = await h.call("POST", `/builds/${built.id}/deploy`, { environmentId: prod.id });
    expect(promote.status).toBe(202);
    expect(promote.json.stageId).toBe(h.store.productionStage(id).id);
    await h.v2.queue.idle(id);
    expect(h.store.getBuild(promote.json.id).status).toBe("succeeded");
    expect(h.deploys.deployed[h.deploys.deployed.length - 1]).toBe(prod.id);
    expect(h.deploys.options[h.deploys.options.length - 1]!.env?.vars).toEqual({ API_URL: "https://prod.example.com" });
  });

  it("a staging cloud carries its own live build into the next staging deploy", async () => {
    const { id, row } = await stagingProject();
    const first = await h.call("POST", `/projects/${id}/builds`, { stage: "staging", revision: h.head });
    await h.v2.queue.idle(id);
    // The staging cloud had nothing live: Production's build isn't carried.
    expect(h.deploys.deployed[h.deploys.deployed.length - 1]).toBe(row.id);
    expect(h.deploys.options[h.deploys.options.length - 1]!.carryFrom).toBeUndefined();
    await h.call("POST", `/projects/${id}/builds`, { stage: "staging", revision: h.head });
    await h.v2.queue.idle(id);
    expect(h.deploys.deployed[h.deploys.deployed.length - 1]).toBe(row.id);
    expect(h.deploys.options[h.deploys.options.length - 1]!.carryFrom).toBe(h.artifacts.path(first.json.id));
  });

  it("POST /projects/{id}/builds { stage } builds the head of the stage's branch and records it on the stage", async () => {
    await h.close();
    const asked: string[] = [];
    h = await startHarness({
      v2: {
        lsRemote: async (_repo: string, branch: string) => {
          asked.push(branch);
          return branch === "staging" ? "c".repeat(40) : h.head;
        },
      },
    });
    const { id, staging } = await stagingProject();
    const lastSeenBefore = h.store.getProject(id).lastSeenSha;
    asked.length = 0;

    const res = await h.call("POST", `/projects/${id}/builds`, { stage: "staging" });
    expect(res.status).toBe(202);
    expect(asked).toEqual(["staging"]);
    expect(res.json).toMatchObject({ revision: "c".repeat(40), stageId: staging.id, manual: true });
    expect(h.store.getStage(staging.id).lastSeenSha).toBe("c".repeat(40));
    expect(h.store.getProject(id).lastSeenSha).toBe(lastSeenBefore);
    await h.v2.queue.idle(id);

    expect((await h.call("POST", `/projects/${id}/builds`, { stage: "nope" })).status).toBe(404);
    expect((await h.call("POST", `/projects/${id}/builds`, { stage: "preview" })).status).toBe(400);
    expect((await h.call("POST", `/projects/${id}/builds`, { stage: "development" })).status).toBe(400);
    expect((await h.call("POST", `/projects/${id}/builds`, { stage: 7 })).status).toBe(400);
    expect(asked).toEqual(["staging"]);
  });
});
