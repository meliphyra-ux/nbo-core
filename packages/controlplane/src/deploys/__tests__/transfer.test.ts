// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { transferConfig } from "../transfer.js";
import { startHarness, deployedProject, type Harness } from "../../__tests__/v2-harness.js";

let h: Harness;
const defaultStepDelayMs = transferConfig.stepDelayMs;
beforeEach(async () => {
  transferConfig.stepDelayMs = 10;
  h = await startHarness();
});
afterEach(async () => {
  transferConfig.stepDelayMs = defaultStepDelayMs;
  await h.close();
});

const toCloudRun = { target: "cloudrun", mode: "auto" };

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("transfer", () => {
  it("the new cloud takes over the source cloud's auto-deploy setting", async () => {
    const id = await deployedProject(h);
    const [k8s] = h.store.listEnvironments(id);
    h.store.setEnvironmentAutoDeploy(k8s!.id, false);
    await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    await h.v2.transfers.settled(id);
    const cr = h.store.listEnvironments(id).find((e) => e.target === "cloudrun")!;
    expect(cr.autoDeploy).toBe(false);
  });

  it("provisions, builds, then shifts 1→10→50→100 and ends done with the old side at 0", async () => {
    const id = await deployedProject(h);
    const before = h.edgePuts.length;
    const res = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ projectId: id, status: "provisioning" });
    const summaryDuring = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(summaryDuring.activeTransfer?.id).toBe(res.json.id);

    await h.v2.transfers.settled(id);

    const t = h.store.getTransfer(res.json.id);
    expect(t).toMatchObject({ status: "done", weight: 100, error: "" });
    const [k8s, cr] = h.store.listEnvironments(id);
    expect([k8s!.name, k8s!.trafficWeight, cr!.name, cr!.trafficWeight]).toEqual(["k8s", 0, "cloudrun", 100]);
    expect(t.fromEnvId).toBe(k8s!.id);
    expect(t.toEnvId).toBe(cr!.id);
    // The transfer deploys the source's live build to the new side only
    // (one edge push, new side at 0), then the stepped shift.
    const puts = h.edgePuts.slice(before).map((p) => p.weights);
    expect(puts).toEqual([
      [100, 0],
      [99, 1],
      [90, 10],
      [50, 50],
      [0, 100],
    ]);
    expect((await h.call("GET", `/projects/${id}/summary`)).json.activeTransfer).toBeNull();
  });

  it("deploys the build live on the source cloud, not the branch head, without rebuilding", async () => {
    const id = await deployedProject(h);
    const live = h.store.listBuilds(id)[0]!;
    await h.commit("not built yet");
    const res = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    expect(res.status).toBe(202);
    await h.v2.transfers.settled(id);
    expect(h.store.getTransfer(res.json.id).status).toBe("done");
    const cr = h.store.listEnvironments(id)[1]!;
    const deps = h.store.listDeployments(cr.id);
    expect(deps.map((d) => [d.status, d.buildId])).toEqual([["succeeded", live.id]]);
    // No new commit build: only the promote job was added.
    expect(h.store.listBuilds(id).map((b) => b.kind)).toEqual(["build", "promote"]);
    expect(h.store.listBuilds(id)[1]).toMatchObject({
      sourceBuildId: live.id,
      targetEnvironmentId: cr.id,
      status: "succeeded",
    });
  });

  it("transfer is refused when the source cloud's live build has no stored output", async () => {
    const id = await deployedProject(h);
    const live = h.store.listBuilds(id)[0]!;
    h.store.setBuildDetails(live.id, { artifact: false });
    const res = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/no stored output/);
  });

  it("transfer stops and reports failed when the new side's deploy fails", async () => {
    const id = await deployedProject(h);
    h.deploys.failTargets.add("cloudrun");
    const res = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    await h.v2.transfers.settled(id);
    const t = h.store.getTransfer(res.json.id);
    expect(t.status).toBe("failed");
    expect(t.error).toContain("cloudrun");
    const summary = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(summary.activeTransfer).toBeNull();
    expect(summary.latestTransfer).toMatchObject({ id: res.json.id, status: "failed" });
    const [k8s, cr] = h.store.listEnvironments(id);
    expect(k8s!.trafficWeight).toBe(100);
    expect(cr!.trafficWeight).toBe(0);
    expect(h.registry.get("storefront.127.0.0.1.sslip.io")?.backends.map((b) => b.weight)).toEqual([100]);
  });

  it("cancel mid-shift leaves the last applied weights and status cancelled", async () => {
    transferConfig.stepDelayMs = 300;
    const id = await deployedProject(h);
    const res = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    await waitFor(() =>
      h.store.getTransfer(res.json.id).status === "shifting" && h.store.getTransfer(res.json.id).weight >= 1
        ? true
        : undefined,
    );
    const cancel = await h.call("POST", `/projects/${id}/transfer/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.json.status).toBe("cancelled");
    await h.v2.transfers.settled(id);

    const t = h.store.getTransfer(res.json.id);
    expect(t.status).toBe("cancelled");
    expect(t.weight).toBeLessThan(100);
    const [k8s, cr] = h.store.listEnvironments(id);
    expect(cr!.trafficWeight).toBe(t.weight);
    expect(k8s!.trafficWeight).toBe(100 - t.weight);
    expect((await h.call("POST", `/projects/${id}/transfer/cancel`)).status).toBe(404);
  });

  it("cancel ends a transfer waiting between steps right away, not after the step delay", async () => {
    transferConfig.stepDelayMs = 600_000;
    const id = await deployedProject(h);
    const res = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    await waitFor(() => (h.store.getTransfer(res.json.id).weight >= 1 ? true : undefined));
    expect((await h.call("POST", `/projects/${id}/transfer/cancel`)).status).toBe(200);
    const started = Date.now();
    await h.v2.transfers.settled(id);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(h.store.getTransfer(res.json.id)).toMatchObject({ status: "cancelled", weight: 1 });
  });

  it("transfer is refused while another is active or when the target already has an environment", async () => {
    transferConfig.stepDelayMs = 300;
    const id = await deployedProject(h);
    expect((await h.call("POST", `/projects/${id}/transfer`, { target: "kubernetes" })).status).toBe(409);
    const first = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    expect(first.status).toBe(202);
    const second = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    expect(second.status).toBe(409);
    await h.call("POST", `/projects/${id}/transfer/cancel`);
    await h.v2.transfers.settled(id);
  });

  it("transfer requires a prior successful build", async () => {
    h.deploys.failTargets.add("kubernetes");
    const id = await deployedProject(h);
    const res = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("deploy successfully once before transferring");
  });

  it("a done transfer moves cronsEnabled to the new environment", async () => {
    const id = await deployedProject(h);
    await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    await h.v2.transfers.settled(id);
    const [k8s, cr] = h.store.listEnvironments(id);
    expect(JSON.parse(k8s!.config).cronsEnabled).toBe(false);
    expect(JSON.parse(cr!.config).cronsEnabled).toBe(true);
  });

  it("a provisioning failure marks the transfer failed with the real error", async () => {
    const id = await deployedProject(h);
    h.cloud.ensureError = new Error('creating the Artifact Registry repository "nbo" failed: PERMISSION_DENIED');
    const res = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    await h.v2.transfers.settled(id);
    expect(h.store.getTransfer(res.json.id)).toMatchObject({
      status: "failed",
      error: 'creating the Artifact Registry repository "nbo" failed: PERMISSION_DENIED',
    });
  });

  it("a transfer started while a newer commit is queued deploys that commit instead of superseding it", async () => {
    const id = await deployedProject(h);
    h.deploys.delayMs = 300;
    const b = await h.commit("second");
    expect((await h.call("POST", `/projects/${id}/builds`, {})).json.status).toBe("running");
    const c = await h.commit("third");
    expect((await h.call("POST", `/projects/${id}/builds`, {})).json.status).toBe("queued");
    const res = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    expect(res.status).toBe(202);
    await h.v2.transfers.settled(id);

    const builds = h.store.listBuilds(id);
    expect(builds.filter((x) => x.error === "superseded by a newer build")).toEqual([]);
    expect(builds.find((x) => x.revision === c)?.status).toBe("succeeded");
    expect(builds.find((x) => x.revision === b)?.status).toBe("succeeded");
    // The transfer's own build deployed the newest succeeded commit to the new side.
    const cr = h.store.listEnvironments(id).find((e) => e.target === "cloudrun")!;
    const crDep = h.store.listDeployments(cr.id).at(-1)!;
    expect(builds.find((x) => x.deploymentIds.includes(crDep.id))?.revision).toBe(c);
    expect(h.store.getTransfer(res.json.id).status).toBe("done");
  }, 20_000);

  it("an edge push that fails mid-shift leaves stored weights at the last step the edge accepted", async () => {
    transferConfig.stepDelayMs = 400;
    const id = await deployedProject(h);
    const res = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    await waitFor(() => (h.store.getTransfer(res.json.id).weight >= 1 ? true : undefined));
    await h.stopEdge();
    await h.v2.transfers.settled(id);
    const t = h.store.getTransfer(res.json.id);
    expect(t.status).toBe("failed");
    const [k8s, cr] = h.store.listEnvironments(id);
    expect(cr!.trafficWeight).toBe(t.weight);
    expect(k8s!.trafficWeight).toBe(100 - t.weight);
  }, 20_000);

  it("PUT traffic is refused while a transfer is shifting", async () => {
    transferConfig.stepDelayMs = 400;
    const id = await deployedProject(h);
    const res = await h.call("POST", `/projects/${id}/transfer`, toCloudRun);
    await waitFor(() => (h.store.getTransfer(res.json.id).weight >= 1 ? true : undefined));
    const [k8s, cr] = h.store.listEnvironments(id);
    const put = await h.call("PUT", `/projects/${id}/traffic`, { weights: { [k8s!.id]: 50, [cr!.id]: 50 } });
    expect(put.status).toBe(409);
    await h.call("POST", `/projects/${id}/transfer/cancel`);
    await h.v2.transfers.settled(id);
  }, 20_000);
});
