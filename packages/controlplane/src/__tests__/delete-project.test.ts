// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { startHarness, deployedProject, bothClouds, type Harness } from "./v2-harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe("DELETE /projects/{id}", () => {
  it("removes the project, its records and its edge route, but leaves cloud services by default", async () => {
    const id = await deployedProject(h);
    expect(h.registry.get("storefront.127.0.0.1.sslip.io")).toBeDefined();
    const res = await h.call("DELETE", `/projects/${id}`);
    expect(res.status).toBe(204);
    expect((await h.call("GET", `/projects/${id}/summary`)).status).toBe(404);
    expect((await h.call("GET", "/projects/summary")).json).toEqual([]);
    expect(h.registry.get("storefront.127.0.0.1.sslip.io")).toBeUndefined();
    expect(h.teardown.removed).toEqual([]);
  });

  it("with resources=true also deletes what it runs on each cloud", async () => {
    const id = await deployedProject(h, { clouds: bothClouds });
    const res = await h.call("DELETE", `/projects/${id}?resources=true`);
    expect(res.status).toBe(204);
    expect(h.teardown.removed.map((r) => [r.target, r.appName])).toEqual([
      ["kubernetes", `p${id.split("_")[1]!.slice(0, 8)}-k8s`],
      ["cloudrun", `p${id.split("_")[1]!.slice(0, 8)}-cloudrun`],
    ]);
  });

  it("with resources=true also tears down every custom environment's clouds", async () => {
    const id = await deployedProject(h, { clouds: bothClouds });
    expect(
      (
        await h.call("POST", `/projects/${id}/stages`, {
          name: "staging",
          branch: "staging",
          clouds: [{ target: "kubernetes" }],
        })
      ).status,
    ).toBe(201);
    const res = await h.call("DELETE", `/projects/${id}?resources=true`);
    expect(res.status).toBe(204);
    const p = `p${id.split("_")[1]!.slice(0, 8)}`;
    expect(h.teardown.removed.map((r) => [r.target, r.appName])).toEqual([
      ["kubernetes", `${p}-k8s`],
      ["cloudrun", `${p}-cloudrun`],
      ["kubernetes", `${p}-s-staging-k8s`],
    ]);
  });

  it("removes every custom environment's host from the edge", async () => {
    const id = await deployedProject(h);
    const stage = (
      await h.call("POST", `/projects/${id}/stages`, {
        name: "staging",
        branch: "staging",
        clouds: [{ target: "kubernetes" }],
      })
    ).json;
    h.v2.queue.enqueue(id, h.head, { stageId: stage.id });
    await h.v2.queue.idle(id);
    expect(h.registry.get("staging--storefront.127.0.0.1.sslip.io")).toBeDefined();
    expect((await h.call("DELETE", `/projects/${id}`)).status).toBe(204);
    expect(h.registry.get("staging--storefront.127.0.0.1.sslip.io")).toBeUndefined();
    expect(h.registry.get("storefront.127.0.0.1.sslip.io")).toBeUndefined();
  });

  it("a teardown failure keeps the project and reports the cloud's error", async () => {
    const id = await deployedProject(h);
    h.teardown.failWith = new Error("Kubernetes: deleting x failed: Unable to connect to the server");
    const res = await h.call("DELETE", `/projects/${id}?resources=true`);
    expect(res.status).toBe(502);
    expect(res.json.error).toContain("Unable to connect");
    expect((await h.call("GET", `/projects/${id}/summary`)).status).toBe(200);
  });

  it("refuses while a build is running", async () => {
    const id = await deployedProject(h);
    h.deploys.delayMs = 400;
    await h.commit("second");
    await h.call("POST", `/projects/${id}/builds`, {});
    const res = await h.call("DELETE", `/projects/${id}`);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("build");
    await h.v2.queue.idle(id);
  });

  it("404s for an unknown project", async () => {
    expect((await h.call("DELETE", "/projects/proj_nope")).status).toBe(404);
  });
});
