// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { startHarness, deployedProject, type Harness } from "../../__tests__/v2-harness.js";
import { affectedStages, hashPassword, stageProtected } from "../protection.js";
import { liveBuild } from "../../builds/artifacts.js";
import type { Stage } from "../../stages/stages.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function harness(): Promise<Harness> {
  const h = await startHarness();
  harnesses.push(h);
  return h;
}

const PASSWORD = "correct horse battery";
const url = (id: string) => `/projects/${id}/protection`;

describe("hashPassword", () => {
  it("hashes with the fixed format, matching the hash nbo serve verifies", async () => {
    // The same literal is pinned in packages/serve's protection test.
    expect(await hashPassword(PASSWORD, Buffer.alloc(16, 7))).toBe(
      "scrypt$16384$8$1$BwcHBwcHBwcHBwcHBwcHBw$jqNYMZJ6k8yP9UrEwEFdAphyQW3NDqRG8javhwKNA-0",
    );
    expect(await hashPassword(PASSWORD)).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  });
});

describe("stageProtected", () => {
  const stage = (kind: Stage["kind"]) => ({ kind }) as Stage;
  it("protects every stage but Production on previews, every stage on all, none without a password", () => {
    const on = (mode: "off" | "previews" | "all", hash = "h") => ({ mode, hash });
    expect(stageProtected(on("previews"), stage("production"))).toBe(false);
    for (const kind of ["preview", "development", "custom", "ephemeral"] as const)
      expect(stageProtected(on("previews"), stage(kind)), kind).toBe(true);
    expect(stageProtected(on("all"), stage("production"))).toBe(true);
    expect(stageProtected(on("off"), stage("custom"))).toBe(false);
    expect(stageProtected(on("all", ""), stage("production"))).toBe(false);
  });
});

describe("GET and PUT /projects/{id}/protection", () => {
  it("is off with no password by default", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const res = await h.call("GET", url(id));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ mode: "off", passwordSet: false });
  });

  it("refuses an unknown mode and a password outside 8 to 256 characters", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    expect((await h.call("PUT", url(id), { mode: "some" })).status).toBe(400);
    const short = await h.call("PUT", url(id), { mode: "all", password: "short" });
    expect(short.status).toBe(400);
    expect(short.json.error).toBe("the password must be 8 to 256 characters");
    expect((await h.call("PUT", url(id), { mode: "all", password: "x".repeat(257) })).status).toBe(400);
  });

  it("refuses turning protection on without a password", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const res = await h.call("PUT", url(id), { mode: "previews" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("a password is needed to turn protection on");
  });

  it("stores only a hash, and off keeps it so turning on again needs no password", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const on = await h.call("PUT", url(id), { mode: "all", password: PASSWORD });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ mode: "all", passwordSet: true });
    expect(on.text).not.toContain(PASSWORD);
    expect(h.store.getProtection(id).hash).toMatch(/^scrypt\$/);
    expect((await h.call("PUT", url(id), { mode: "off" })).json).toMatchObject({ mode: "off", passwordSet: true });
    expect((await h.call("PUT", url(id), { mode: "previews" })).json).toMatchObject({
      mode: "previews",
      passwordSet: true,
    });
  });

  it("is 404 for an unknown project", async () => {
    const h = await harness();
    expect((await h.call("GET", url("nope"))).status).toBe(404);
    expect((await h.call("PUT", url("nope"), { mode: "off" })).status).toBe(404);
  });

  it("deleting the project deletes its protection", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    await h.call("PUT", url(id), { mode: "all", password: PASSWORD });
    // The row references the project: a delete that left it behind would fail on the foreign key.
    h.store.deleteProject(id);
    expect(h.store.getProtection(id)).toEqual({ mode: "off", hash: "" });
  });
});

describe("affectedStages", () => {
  const stages = [
    { id: "prod", kind: "production" },
    { id: "stg", kind: "custom" },
    { id: "pv", kind: "ephemeral" },
  ] as Stage[];
  const ids = (before: Parameters<typeof affectedStages>[0], after: Parameters<typeof affectedStages>[1]) =>
    affectedStages(before, after, stages).map((s) => s.id);

  it("turning previews on touches every stage but Production; previews to all touches only Production", () => {
    expect(ids({ mode: "off", hash: "" }, { mode: "previews", hash: "a" })).toEqual(["stg", "pv"]);
    expect(ids({ mode: "previews", hash: "a" }, { mode: "all", hash: "a" })).toEqual(["prod"]);
    expect(ids({ mode: "all", hash: "a" }, { mode: "off", hash: "a" })).toEqual(["prod", "stg", "pv"]);
  });

  it("a new password redeploys every protected stage, and nothing else changes nothing", () => {
    expect(ids({ mode: "previews", hash: "a" }, { mode: "previews", hash: "b" })).toEqual(["stg", "pv"]);
    expect(ids({ mode: "previews", hash: "a" }, { mode: "previews", hash: "a" })).toEqual([]);
    expect(ids({ mode: "off", hash: "a" }, { mode: "off", hash: "b" })).toEqual([]);
  });
});

describe("PUT /projects/{id}/protection redeploys", () => {
  it("queues a promote of each affected cloud's live build", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const [env] = h.store.listEnvironments(id);
    const live = liveBuild(h.store, env!)!;
    expect(live).toBeTruthy();
    const res = await h.call("PUT", url(id), { mode: "all", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.json.redeploying).toEqual([{ environmentId: env!.id, buildId: expect.any(String) }]);
    expect(res.json.notRedeployed).toEqual([]);
    const job = h.store.getBuild(res.json.redeploying[0].buildId);
    expect(job.kind).toBe("promote");
    expect(job.sourceBuildId).toBe(live.kind === "promote" ? live.sourceBuildId : live.id);
    await h.v2.queue.idle(id);
  });

  it("lists a cloud with nothing deployed under notRedeployed and still answers 200", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const extra = h.store.createEnvironment(id, "k8s-spare", "kubernetes");
    const res = await h.call("PUT", url(id), { mode: "all", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.json.notRedeployed).toContainEqual({ environmentId: extra.id, reason: "nothing is deployed there yet" });
    await h.v2.queue.idle(id);
  });

  it("leaves a cloud whose build is already queued to that build, never redeploying the older one after it", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const [env] = h.store.listEnvironments(id);
    const live = liveBuild(h.store, env!)!;
    const pending = h.store.createQueuedBuild(id, live.revision);
    const res = await h.call("PUT", url(id), { mode: "all", password: PASSWORD });
    expect(res.json.redeploying).toEqual([{ environmentId: env!.id, buildId: pending.id }]);
    expect(h.store.listBuilds(id).filter((b) => b.kind === "promote")).toHaveLength(0);
  });

  it("redeploys nothing when nothing a visitor sees changes", async () => {
    const h = await harness();
    const id = await deployedProject(h);
    const res = await h.call("PUT", url(id), { mode: "previews", password: PASSWORD });
    expect(res.json).toMatchObject({ redeploying: [], notRedeployed: [] });
  });
});
