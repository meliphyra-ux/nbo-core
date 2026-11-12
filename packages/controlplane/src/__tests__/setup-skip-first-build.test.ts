// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { pollOnce } from "../poller.js";
import { parseSetupRequest } from "../setup.js";
import { startHarness, staticSetup, bothClouds, type Harness } from "./v2-harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const deps = () => ({ store: h.store, queue: h.v2.queue, edgeSync: h.v2.edgeSync });

async function preparedProject(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await h.call("POST", "/projects/setup", staticSetup({ skipFirstBuild: true, ...overrides }));
  expect(res.status).toBe(201);
  const id = res.json.project.id as string;
  await h.v2.setup.settled(id);
  await h.v2.queue.idle(id);
  return id;
}

describe("skipFirstBuild", () => {
  it("finishes setup without building", async () => {
    const id = await preparedProject();
    const s = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(s.project).toMatchObject({ setupStatus: "ready", setupError: "", lastSeenSha: h.head });
    expect(s.latestBuild).toBeNull();
    expect(s.environments.map((e: { name: string }) => e.name)).toEqual(["k8s"]);
    expect(h.store.listBuilds(id)).toEqual([]);
    expect(h.deploys.deployed).toEqual([]);
  });

  it("reports a setup failure the same way", async () => {
    h.cloud.ensureError = new Error("billing disabled");
    const id = await preparedProject({ clouds: [{ target: "cloudrun", mode: "auto" }] });
    const s = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(s.project.setupStatus).toBe("needs-setup");
    expect(s.project.setupError).toContain("billing disabled");
  });

  it("still skips the build when setup is retried", async () => {
    h.cloud.ensureError = new Error("billing disabled");
    const id = await preparedProject({ clouds: [{ target: "cloudrun", mode: "auto" }] });
    h.cloud.ensureError = null;
    expect((await h.call("POST", `/projects/${id}/setup/retry`, {})).status).toBe(202);
    await h.v2.setup.settled(id);
    await h.v2.queue.idle(id);
    expect(h.store.getProject(id).setupStatus).toBe("ready");
    expect(h.store.listBuilds(id)).toEqual([]);
  });

  it("lets POST /projects/{id}/builds make the first deploy and register the first split", async () => {
    const id = await preparedProject({ clouds: bothClouds });
    const res = await h.call("POST", `/projects/${id}/builds`, {});
    expect(res.status).toBe(202);
    expect(res.json.revision).toBe(h.head);
    await h.v2.queue.idle(id);

    const s = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(s.latestBuild).toMatchObject({ id: res.json.id, status: "succeeded" });
    expect(s.latestBuild.deploymentIds).toHaveLength(2);
    expect(s.environments.map((e: { trafficWeight: number }) => e.trafficWeight)).toEqual([100, 0]);
    expect(h.edgePuts.at(-1)).toMatchObject({ host: s.project.edgeHost });
    expect(h.edgePuts.at(-1)!.weights).toContain(100);
  });

  it("gives the first split to the next cloud when the first one fails", async () => {
    const id = await preparedProject({ clouds: bothClouds });
    h.deploys.failTargets.add("kubernetes");
    const res = await h.call("POST", `/projects/${id}/builds`, {});
    await h.v2.queue.idle(id);

    const build = (await h.call("GET", `/builds/${res.json.id}`)).json;
    expect(build.status).toBe("failed");
    expect(build.error).toContain("k8s");
    const s = (await h.call("GET", `/projects/${id}/summary`)).json;
    expect(s.environments.map((e: { trafficWeight: number }) => e.trafficWeight)).toEqual([0, 100]);
  });

  it("leaves polling nothing to build on the same head, before or after the first build", async () => {
    const id = await preparedProject();
    await pollOnce(deps());
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id)).toEqual([]);

    await h.call("POST", `/projects/${id}/builds`, {});
    await pollOnce(deps());
    await h.v2.queue.idle(id);
    expect(h.store.listBuilds(id)).toHaveLength(1);
  });

  it("is off unless asked for, and only takes a boolean", async () => {
    expect(parseSetupRequest(staticSetup())).not.toHaveProperty("skipFirstBuild");
    expect(parseSetupRequest(staticSetup({ skipFirstBuild: false }))).not.toHaveProperty("skipFirstBuild");
    expect(parseSetupRequest(staticSetup({ skipFirstBuild: true })).skipFirstBuild).toBe(true);
    const res = await h.call("POST", "/projects/setup", staticSetup({ skipFirstBuild: "yes" }));
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("skipFirstBuild");
  });
});
