// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, type Store } from "../../store/store.js";
import { createRouter } from "../../http/router.js";
import {
  verifyGithubSignature,
  registerGitConfigRoutes,
  registerWebhookRoutes,
  stageForBranch,
  type BuildTrigger,
} from "../webhooks.js";
import { branchInUse } from "../../stages/stages.js";
import { ErrConflict } from "../../store/errors.js";
import { statusForStoreError } from "../../http/handlers.js";

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
  const dir = await mkdtemp(join(tmpdir(), "controlplane-webhooks-"));
  const s = createStore(join(dir, "test.db"));
  openStores.push(s);
  return s;
}

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyGithubSignature", () => {
  it("verifies a real HMAC-SHA256 signature", () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    expect(verifyGithubSignature("s3cr3t", body, sign("s3cr3t", body))).toBe(true);
  });

  it("rejects a signature over a different body", () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const wrongSig = sign("s3cr3t", JSON.stringify({ ref: "refs/heads/other" }));
    expect(verifyGithubSignature("s3cr3t", body, wrongSig)).toBe(false);
  });

  it("rejects a signature computed with a different secret", () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    expect(verifyGithubSignature("s3cr3t", body, sign("wrong-secret", body))).toBe(false);
  });

  it("rejects a missing header without throwing", () => {
    expect(verifyGithubSignature("s3cr3t", "{}", null)).toBe(false);
  });
});

function gitConfigBody() {
  return {
    repo: "https://example.com/acme/web.git",
    productionBranch: "main",
    framework: "static",
    buildCommand: "npm run build",
    outputDir: "dist",
  };
}

describe("registerGitConfigRoutes", () => {
  it("PUT stores config and returns it with a webhookSecret", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const router = createRouter();
    registerGitConfigRoutes(router, store);

    const res = await router(
      new Request(`http://x/projects/${proj.id}/git`, { method: "PUT", body: JSON.stringify(gitConfigBody()) }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.repo).toBe(gitConfigBody().repo);
    expect(typeof body.webhookSecret).toBe("string");
    expect(body.webhookSecret.length).toBeGreaterThan(0);
  });

  it("PUT rejects a missing repo", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const router = createRouter();
    registerGitConfigRoutes(router, store);

    const bad = { ...gitConfigBody(), repo: undefined };
    const res = await router(
      new Request(`http://x/projects/${proj.id}/git`, { method: "PUT", body: JSON.stringify(bad) }),
    );
    expect(res.status).toBe(400);
  });

  it("PUT rejects an unknown framework", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const router = createRouter();
    registerGitConfigRoutes(router, store);

    const bad = { ...gitConfigBody(), framework: "sveltekit" };
    const res = await router(
      new Request(`http://x/projects/${proj.id}/git`, { method: "PUT", body: JSON.stringify(bad) }),
    );
    expect(res.status).toBe(400);
  });

  // Final-review finding: an outputDir of "." or a path escaping the
  // clone (e.g. "../..") would publish the whole clone — .git/
  // (history, any secret ever committed) and node_modules included —
  // as the deployed static site.
  it.each(["..", ".", "../secrets", "/etc", "a/../../b"])("PUT rejects an unsafe outputDir %s", async (outputDir) => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const router = createRouter();
    registerGitConfigRoutes(router, store);

    const bad = { ...gitConfigBody(), outputDir };
    const res = await router(
      new Request(`http://x/projects/${proj.id}/git`, { method: "PUT", body: JSON.stringify(bad) }),
    );
    expect(res.status).toBe(400);
  });

  it("PUT accepts an ordinary relative outputDir", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const router = createRouter();
    registerGitConfigRoutes(router, store);

    const res = await router(
      new Request(`http://x/projects/${proj.id}/git`, {
        method: "PUT",
        body: JSON.stringify({ ...gitConfigBody(), outputDir: "build/output" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("GET on an unconfigured project returns 404", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const router = createRouter();
    registerGitConfigRoutes(router, store);

    const res = await router(new Request(`http://x/projects/${proj.id}/git`));
    expect(res.status).toBe(404);
  });

  it("GET /projects/{projectID}/builds lists the project's own builds", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.createBuild(proj.id, "rev1");
    const router = createRouter();
    registerGitConfigRoutes(router, store);

    const res = await router(new Request(`http://x/projects/${proj.id}/builds`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].revision).toBe("rev1");
  });

  it("the builds list leaves out the heavy details; GET /builds/{id} keeps them", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const build = store.createBuild(proj.id, "rev1");
    store.setBuildDetails(build.id, {
      commit: { sha: "a", message: "m", author: "x", committedAt: "" },
      timeline: [],
      artifact: true,
      contentId: "sha256:c",
    });
    const router = createRouter();
    registerGitConfigRoutes(router, store);
    const [item] = await (await router(new Request(`http://x/projects/${proj.id}/builds`))).json();
    for (const k of ["log", "input", "timeline", "outputSummary", "commit"]) expect(item).not.toHaveProperty(k);
    expect(item).toMatchObject({ revision: "rev1", artifact: true, contentId: "sha256:c" });
    const one = await (await router(new Request(`http://x/builds/${build.id}`))).json();
    expect(one.commit).toMatchObject({ sha: "a" });
    expect(one.timeline).toEqual([]);
  });

  it("GET /builds/{buildID} returns one build or 404", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    const build = store.createBuild(proj.id, "rev1");
    const router = createRouter();
    registerGitConfigRoutes(router, store);

    const ok = await router(new Request(`http://x/builds/${build.id}`));
    expect(ok.status).toBe(200);

    const missing = await router(new Request("http://x/builds/build_nope"));
    expect(missing.status).toBe(404);
  });
});

describe("registerWebhookRoutes", () => {
  async function setup(): Promise<{
    store: Store;
    router: ReturnType<typeof createRouter>;
    projectId: string;
    secret: string;
    trigger: BuildTrigger;
  }> {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, gitConfigBody() as never);
    const secret = store.ensureWebhookSecret(proj.id);
    const trigger: BuildTrigger = { enqueue: vi.fn().mockReturnValue({ id: "build_fake", status: "queued" }) };
    const router = createRouter();
    registerWebhookRoutes(router, store, trigger);
    return { store, router, projectId: proj.id, secret, trigger };
  }

  it("a correct signature with the configured branch triggers a build and returns 202", async () => {
    const { router, projectId, secret, trigger } = await setup();
    const payload = JSON.stringify({ ref: "refs/heads/main", after: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });

    const res = await router(
      new Request(`http://x/projects/${projectId}/webhooks/github`, {
        method: "POST",
        body: payload,
        headers: { "x-hub-signature-256": sign(secret, payload) },
      }),
    );

    expect(res.status).toBe(202);
    expect(trigger.enqueue).toHaveBeenCalledWith(projectId, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  });

  it("a wrong signature is rejected and never triggers a build", async () => {
    const { router, projectId, trigger } = await setup();
    const payload = JSON.stringify({ ref: "refs/heads/main", after: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });

    const res = await router(
      new Request(`http://x/projects/${projectId}/webhooks/github`, {
        method: "POST",
        body: payload,
        headers: { "x-hub-signature-256": sign("wrong", payload) },
      }),
    );

    expect(res.status).toBe(401);
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  it("a correct signature for a non-configured branch is accepted but never triggers a build", async () => {
    const { router, projectId, secret, trigger } = await setup();
    const payload = JSON.stringify({ ref: "refs/heads/feature-x", after: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });

    const res = await router(
      new Request(`http://x/projects/${projectId}/webhooks/github`, {
        method: "POST",
        body: payload,
        headers: { "x-hub-signature-256": sign(secret, payload) },
      }),
    );

    expect(res.status).toBe(200);
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  it("a project with no git config returns 404", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme-unconfigured");
    const trigger: BuildTrigger = { enqueue: vi.fn().mockReturnValue({ id: "build_fake", status: "queued" }) };
    const router = createRouter();
    registerWebhookRoutes(router, store, trigger);
    const payload = JSON.stringify({ ref: "refs/heads/main", after: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });

    const res = await router(
      new Request(`http://x/projects/${proj.id}/webhooks/github`, {
        method: "POST",
        body: payload,
        headers: { "x-hub-signature-256": "sha256=whatever" },
      }),
    );

    expect(res.status).toBe(404);
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  // Final-review finding: GitHub's own "ping" event (sent the moment
  // the webhook is created in their UI, before any push ever
  // happens) has no ref/after at all — the owner would see a red X
  // on first setup. A real push event's own payload always has them,
  // so gating on the event-type header, not the payload shape, is
  // what tells the two apart correctly.
  it("a ping event (no ref/after at all) is accepted, not treated as a malformed push", async () => {
    const { router, projectId, secret, trigger } = await setup();
    const payload = JSON.stringify({ zen: "Non-blocking is better than blocking.", hook_id: 1 });

    const res = await router(
      new Request(`http://x/projects/${projectId}/webhooks/github`, {
        method: "POST",
        body: payload,
        headers: { "x-hub-signature-256": sign(secret, payload), "x-github-event": "ping" },
      }),
    );

    expect(res.status).toBe(200);
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  it("a non-push event is accepted and ignored, never treated as a build trigger", async () => {
    const { router, projectId, secret, trigger } = await setup();
    const payload = JSON.stringify({ ref: "refs/heads/main", after: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });

    const res = await router(
      new Request(`http://x/projects/${projectId}/webhooks/github`, {
        method: "POST",
        body: payload,
        headers: { "x-hub-signature-256": sign(secret, payload), "x-github-event": "star" },
      }),
    );

    expect(res.status).toBe(200);
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  // Final-review finding: GitHub's own webhook configuration
  // defaults to "Content type: application/x-www-form-urlencoded",
  // sending the JSON payload as a urlencoded `payload=` field, not a
  // raw JSON body — a real delivery with the default setting would
  // otherwise always 400.
  it("accepts a real application/x-www-form-urlencoded delivery (GitHub's own default content type)", async () => {
    const { router, projectId, secret, trigger } = await setup();
    const json = JSON.stringify({ ref: "refs/heads/main", after: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
    const formBody = `payload=${encodeURIComponent(json)}`;

    const res = await router(
      new Request(`http://x/projects/${projectId}/webhooks/github`, {
        method: "POST",
        body: formBody,
        headers: {
          "x-hub-signature-256": sign(secret, formBody),
          "content-type": "application/x-www-form-urlencoded",
          "x-github-event": "push",
        },
      }),
    );

    expect(res.status).toBe(202);
    expect(trigger.enqueue).toHaveBeenCalledWith(projectId, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  });

  // Final-review finding: a branch-deletion push sends after:
  // "0000000000000000000000000000000000000000" with deleted: true —
  // there is no real revision to build, so this must be ignored, not
  // handed to git checkout as a literal 40-character string of zeros.
  it("a branch-deletion push (after is all zeros) is accepted and ignored", async () => {
    const { router, projectId, secret, trigger } = await setup();
    const payload = JSON.stringify({
      ref: "refs/heads/main",
      after: "0000000000000000000000000000000000000000",
      deleted: true,
    });

    const res = await router(
      new Request(`http://x/projects/${projectId}/webhooks/github`, {
        method: "POST",
        body: payload,
        headers: { "x-hub-signature-256": sign(secret, payload) },
      }),
    );

    expect(res.status).toBe(200);
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  // Final-review finding: `void trigger?.runBuild(...)` had no
  // .catch — matching the cron scheduler's own documented lesson
  // (scheduler.ts: "The .catch is load-bearing") that this exact
  // fire-and-forget shape needs one, or a rejecting trigger crashes
  // the whole control-plane process.
  it("a trigger whose enqueue throws answers 500 instead of crashing", async () => {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, gitConfigBody() as never);
    const secret = store.ensureWebhookSecret(proj.id);
    const throwing: BuildTrigger = {
      enqueue() {
        throw new Error("boom");
      },
    };
    const router = createRouter();
    registerWebhookRoutes(router, store, throwing);
    const payload = JSON.stringify({ ref: "refs/heads/main", after: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });

    const res = await router(
      new Request(`http://x/projects/${proj.id}/webhooks/github`, {
        method: "POST",
        body: payload,
        headers: { "x-hub-signature-256": sign(secret, payload) },
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("boom");
  });

  it("rejects a push whose after is not a real 40-character sha", async () => {
    const { router, projectId, secret, trigger } = await setup();
    const payload = JSON.stringify({ ref: "refs/heads/main", after: "--upload-pack=touch /tmp/pwned" });

    const res = await router(
      new Request(`http://x/projects/${projectId}/webhooks/github`, {
        method: "POST",
        body: payload,
        headers: { "x-hub-signature-256": sign(secret, payload) },
      }),
    );

    expect(res.status).toBe(400);
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });
});

describe("stageForBranch and branchInUse", () => {
  it("find the custom environment on a branch; Production's branch and unknown ones belong to none", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    store.setGitConfig(p.id, gitConfigBody() as never);
    const staging = store.createStage(p.id, { name: "staging", branch: "stage", host: "" });
    expect(stageForBranch(store, p.id, "stage")?.id).toBe(staging.id);
    expect(stageForBranch(store, p.id, "main")).toBeNull();
    expect(stageForBranch(store, p.id, "other")).toBeNull();
    // A custom environment's branch is its own even when an ephemeral one shares it.
    store.createEphemeralStage(p.id, { branch: "stage", host: "x--acme.127.0.0.1.sslip.io", expiresAt: "", label: "" });
    expect(stageForBranch(store, p.id, "stage")?.id).toBe(staging.id);
    expect(branchInUse(store, p.id, "main")).toBe("production");
    expect(branchInUse(store, p.id, "stage")).toBe("staging");
    expect(branchInUse(store, p.id, "stage", staging.id)).toBeNull();
    expect(branchInUse(store, p.id, "free")).toBeNull();
  });

  it("createStage refuses a branch Production or another environment uses (409)", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    store.setGitConfig(p.id, gitConfigBody() as never);
    store.createStage(p.id, { name: "staging", branch: "stage", host: "" });
    expect(() => store.createStage(p.id, { name: "qat", branch: "main", host: "" })).toThrow(ErrConflict);
    expect(() => store.createStage(p.id, { name: "qat", branch: "stage", host: "" })).toThrow(ErrConflict);
    expect(statusForStoreError(new ErrConflict("x"))).toBe(409);
  });
});

describe("PUT /git with a branch an environment uses", () => {
  it("409 when the new production branch is a custom environment's branch; other branches pass", async () => {
    const store = await openTestStore();
    const p = store.createProject("acme");
    store.setGitConfig(p.id, gitConfigBody() as never);
    store.createStage(p.id, { name: "staging", branch: "stage", host: "" });
    const router = createRouter();
    registerGitConfigRoutes(router, store);
    const put = (productionBranch: string) =>
      router(
        new Request(`http://x/projects/${p.id}/git`, {
          method: "PUT",
          body: JSON.stringify({ ...gitConfigBody(), productionBranch }),
        }),
      );
    const clash = await put("stage");
    expect(clash.status).toBe(409);
    expect((await clash.json()).error).toMatch(/staging/);
    expect(store.getGitConfig(p.id).productionBranch).toBe("main");
    expect((await put("release")).status).toBe(200);
  });
});

describe("push webhook for environments", () => {
  const after = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  async function setup(autoDeploy = true) {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, gitConfigBody() as never);
    const staging = store.createStage(proj.id, { name: "staging", branch: "stage", autoDeploy, host: "" });
    const secret = store.ensureWebhookSecret(proj.id);
    const trigger: BuildTrigger = { enqueue: vi.fn().mockReturnValue({ id: "build_fake", status: "queued" }) };
    const router = createRouter();
    registerWebhookRoutes(router, store, trigger);
    const push = async (branch: string) => {
      const payload = JSON.stringify({ ref: `refs/heads/${branch}`, after });
      return router(
        new Request(`http://x/projects/${proj.id}/webhooks/github`, {
          method: "POST",
          body: payload,
          headers: { "x-hub-signature-256": sign(secret, payload) },
        }),
      );
    };
    return { store, proj, staging, trigger, push };
  }

  it("the production branch builds Production, with no stage", async () => {
    const { proj, trigger, push } = await setup();
    expect((await push("main")).status).toBe(202);
    expect(trigger.enqueue).toHaveBeenCalledWith(proj.id, after);
  });

  it("a stage branch with auto-deploy builds that stage", async () => {
    const { proj, staging, trigger, push } = await setup();
    const res = await push("stage");
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "queued", buildId: "build_fake" });
    expect(trigger.enqueue).toHaveBeenCalledWith(proj.id, after, { stageId: staging.id });
  });

  it("a stage push records the head on the stage, so the poller doesn't build it again", async () => {
    const { store, staging, push } = await setup();
    expect((await push("stage")).status).toBe(202);
    expect(store.getStage(staging.id).lastSeenSha).toBe(after);
  });

  it("a stage branch with auto-deploy off is ignored", async () => {
    const { trigger, push } = await setup(false);
    const res = await push("stage");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ignored");
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  it("any other branch is ignored", async () => {
    const { trigger, push } = await setup();
    const res = await push("feature-x");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ignored");
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });
});

describe("pushes to other branches", () => {
  const fixture = (name: string): string =>
    readFileSync(new URL(`../../__tests__/fixtures/github/${name}.json`, import.meta.url), "utf8");
  const sha1 = "1111111111111111111111111111111111111111";

  async function setup() {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    store.setGitConfig(proj.id, gitConfigBody() as never);
    store.createStage(proj.id, { name: "staging", branch: "stage", autoDeploy: true, host: "" });
    const secret = store.ensureWebhookSecret(proj.id);
    const trigger = { enqueue: vi.fn().mockReturnValue({ id: "build_fake", status: "queued" }) };
    const router = createRouter();
    registerWebhookRoutes(router, store, trigger as BuildTrigger);
    const send = (event: string, body: string, signSecret = secret) =>
      router(
        new Request(`http://x/projects/${proj.id}/webhooks/github`, {
          method: "POST",
          body,
          headers: { "x-hub-signature-256": sign(signSecret, body), "x-github-event": event },
        }),
      );
    return { store, proj, trigger, send };
  }

  const addEphemeral = (store: Store, projectId: string, branch: string) =>
    store.createEphemeralStage(projectId, {
      branch,
      host: `${branch.replace(/\W+/g, "-")}--acme.127.0.0.1.sslip.io`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      label: "",
    });

  it("a push to a branch no environment uses is ignored", async () => {
    const { trigger, send } = await setup();
    const res = await send("push", fixture("push_branch"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored", reason: "not the production branch" });
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  it("a push to an ephemeral environment's branch builds it", async () => {
    const { store, proj, trigger, send } = await setup();
    const stage = addEphemeral(store, proj.id, "feature/x");
    const res = await send("push", fixture("push_branch"));
    expect(res.status).toBe(202);
    expect(trigger.enqueue).toHaveBeenCalledWith(proj.id, sha1, { stageId: stage.id });
    expect(store.getStage(stage.id).lastSeenSha).toBe(sha1);
  });

  it("an ephemeral environment being removed (or removed) takes no more builds", async () => {
    const { store, proj, trigger, send } = await setup();
    const stage = addEphemeral(store, proj.id, "feature/x");
    for (const removal of ["removing", "removal-failed", "removed"] as const) {
      store.updateStage(stage.id, { removal });
      const res = await send("push", fixture("push_branch"));
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("ignored");
    }
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  it("a branch deletion is ignored: removing an ephemeral environment is its maker's call, or its expiry's", async () => {
    const { store, proj, trigger, send } = await setup();
    const stage = addEphemeral(store, proj.id, "feature/x");
    const res = await send("push", fixture("push_deleted"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ignored");
    expect(store.getStage(stage.id).removal).toBe("");
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  it("every pull_request delivery is ignored: the hosted dashboard handles pull requests", async () => {
    const { trigger, send } = await setup();
    for (const body of [
      fixture("pull_request_opened"),
      fixture("pull_request_closed"),
      fixture("pull_request_fork"),
      JSON.stringify({ action: "opened" }),
    ]) {
      const res = await send("pull_request", body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "ignored",
        reason: "pull requests are handled by the hosted dashboard",
      });
    }
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  it("Production and stage pushes go to the build queue", async () => {
    const { proj, trigger, send } = await setup();
    expect((await send("push", JSON.stringify({ ref: "refs/heads/main", after: sha1 }))).status).toBe(202);
    expect(trigger.enqueue).toHaveBeenCalledWith(proj.id, sha1);
    expect((await send("push", JSON.stringify({ ref: "refs/heads/stage", after: sha1 }))).status).toBe(202);
    expect(trigger.enqueue).toHaveBeenCalledTimes(2);
  });

  it("a malformed after is 200 ignored on a branch no environment uses, 400 on an ephemeral environment's", async () => {
    const { store, proj, send } = await setup();
    const body = JSON.stringify({ ref: "refs/heads/feature/x", after: "nope" });
    const off = await send("push", body);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ status: "ignored", reason: "not the production branch" });
    addEphemeral(store, proj.id, "feature/x");
    expect((await send("push", body)).status).toBe(400);
  });

  it("a tag push is ignored", async () => {
    const { trigger, send } = await setup();
    const res = await send("push", JSON.stringify({ ref: "refs/tags/v1", after: sha1 }));
    expect(res.status).toBe(200);
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  it("a body over 5 MiB is 413 before the signature is checked", async () => {
    const { trigger, send } = await setup();
    const res = await send("push", "x".repeat(5 * 1024 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  it("a body over 5 MiB with a bad signature is 413 and records nothing", async () => {
    const { store, proj, trigger, send } = await setup();
    const res = await send("push", "x".repeat(5 * 1024 * 1024 + 1), "wrong");
    expect(res.status).toBe(413);
    expect(store.getProject(proj.id).lastWebhookAt).toBe("");
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  it("a body over 5 MiB without a content-length is 413 too", async () => {
    const { proj, store } = await setup();
    const router = createRouter();
    registerWebhookRoutes(router, store, undefined);
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 7) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await router(
      new Request(`http://x/projects/${proj.id}/webhooks/github`, {
        method: "POST",
        body,
        duplex: "half",
        headers: { "x-github-event": "push" },
      } as RequestInit),
    );
    expect(res.status).toBe(413);
  });

  it("records last_webhook_at on every verified delivery, ping and ignored events included", async () => {
    const { store, proj, send } = await setup();
    expect(store.getProject(proj.id).lastWebhookAt).toBe("");
    await send("ping", "{}");
    expect(store.getProject(proj.id).lastWebhookAt).not.toBe("");
    store.updateProject(proj.id, { lastWebhookAt: "" });
    await send("star", "{}");
    expect(store.getProject(proj.id).lastWebhookAt).not.toBe("");
    store.updateProject(proj.id, { lastWebhookAt: "" });
    await send("push", JSON.stringify({ ref: "refs/heads/zzz" }));
    expect(store.getProject(proj.id).lastWebhookAt).not.toBe("");
  });

  it("a bad signature is 401 and records nothing", async () => {
    const { store, proj, trigger, send } = await setup();
    const res = await send("pull_request", fixture("pull_request_opened"), "wrong");
    expect(res.status).toBe(401);
    expect(store.getProject(proj.id).lastWebhookAt).toBe("");
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });
});

describe("push replay: every project's head moves by compare-and-set", () => {
  const X = "1".repeat(40);
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);
  const zeros = "0".repeat(40);
  const at = (s: number) => ({ repository: { pushed_at: 1_700_000_000 + s } });
  async function setup() {
    const store = await openTestStore();
    const proj = store.createProject("acme");
    // A project with no GitHub link: the per-project webhook only.
    store.setGitConfig(proj.id, gitConfigBody() as never);
    const staging = store.createStage(proj.id, { name: "staging", branch: "stage", autoDeploy: true, host: "" });
    const secret = store.ensureWebhookSecret(proj.id);
    let n = 0;
    const trigger: BuildTrigger = { enqueue: vi.fn(() => ({ id: `build_${++n}`, status: "queued" }) as never) };
    const router = createRouter();
    registerWebhookRoutes(router, store, trigger);
    const push = async (body: Record<string, unknown>) => {
      const payload = JSON.stringify(body);
      const res = await router(
        new Request(`http://x/projects/${proj.id}/webhooks/github`, {
          method: "POST",
          body: payload,
          headers: { "x-hub-signature-256": sign(secret, payload), "x-github-event": "push" },
        }),
      );
      return { status: res.status, json: (await res.json()) as { status: string } };
    };
    return { store, proj, staging, trigger, push, at };
  }

  it("the first push after the project is made builds; A then B in order both build, B last", async () => {
    const { store, proj, trigger, push, at } = await setup();
    expect((await push({ ref: "refs/heads/main", before: X, after: A, ...at(1) })).json.status).toBe("queued");
    expect((await push({ ref: "refs/heads/main", before: A, after: B, ...at(2) })).json.status).toBe("queued");
    expect(vi.mocked(trigger.enqueue).mock.calls.map((c) => c[1])).toEqual([A, B]);
    expect(store.getProject(proj.id).lastSeenSha).toBe(B);
  });

  it("a replayed older push never builds, with or without its pushed_at", async () => {
    const { store, proj, trigger, push, at } = await setup();
    const old = { ref: "refs/heads/main", before: X, after: A, ...at(1) };
    await push(old);
    await push({ ref: "refs/heads/main", before: A, after: B, ...at(2) });
    const replay = await push(old);
    expect(replay.status).toBe(200);
    expect(replay.json.status).toBe("ignored");
    const { repository: _r, ...bare } = old;
    expect((await push(bare)).json.status).toBe("ignored");
    expect(trigger.enqueue).toHaveBeenCalledTimes(2);
    expect(store.getProject(proj.id).lastSeenSha).toBe(B);
  });

  it("the newest push delivered again builds once", async () => {
    const { trigger, push, at } = await setup();
    const p = { ref: "refs/heads/main", before: X, after: A, ...at(1) };
    await push(p);
    expect((await push(p)).json.status).toBe("ignored");
    expect(trigger.enqueue).toHaveBeenCalledTimes(1);
  });

  it("a force push (before is the old head) builds", async () => {
    const { trigger, push, at } = await setup();
    await push({ ref: "refs/heads/main", before: X, after: A, ...at(1) });
    expect((await push({ ref: "refs/heads/main", before: A, after: C, forced: true, ...at(2) })).json.status).toBe(
      "queued",
    );
    expect(trigger.enqueue).toHaveBeenLastCalledWith(expect.any(String), C);
  });

  it("a branch-creation push (before all zeros) builds; replayed after a newer push it doesn't", async () => {
    const { store, staging, trigger, push, at } = await setup();
    const created = { ref: "refs/heads/stage", before: zeros, after: A, created: true, ...at(1) };
    expect((await push(created)).json.status).toBe("queued");
    await push({ ref: "refs/heads/stage", before: A, after: B, ...at(2) });
    expect((await push(created)).json.status).toBe("ignored");
    expect(trigger.enqueue).toHaveBeenCalledTimes(2);
    expect(store.getStage(staging.id).lastSeenSha).toBe(B);
  });

  it("a push and the poller build one commit once, whichever comes first", async () => {
    const { store, proj, trigger, push, at } = await setup();
    // The push first: the poller's compare-and-set from the head it read misses.
    await push({ ref: "refs/heads/main", before: X, after: A, ...at(1) });
    expect(store.advanceHead(proj.id, A, undefined, "", { at: Date.now() })).toBe(false);
    // The poller first (it read A, saw B): the push for B is then already seen.
    expect(store.advanceHead(proj.id, B, undefined, A, { at: (1_700_000_000 + 5) * 1000 })).toBe(true);
    expect((await push({ ref: "refs/heads/main", before: A, after: B, ...at(2) })).json.status).toBe("ignored");
    expect(trigger.enqueue).toHaveBeenCalledTimes(1);
  });

  it("a head left stale (a manual build of an older commit) doesn't block a newer push", async () => {
    const { store, proj, push, at } = await setup();
    store.advanceHead(proj.id, C, undefined, undefined, { at: (1_700_000_000 + 1) * 1000 });
    expect((await push({ ref: "refs/heads/main", before: A, after: B, ...at(2) })).json.status).toBe("queued");
    expect(store.getProject(proj.id).lastSeenSha).toBe(B);
  });

  it("a head set by setup (updateProject, updateStage) records its time: an older push replayed after it doesn't build", async () => {
    const { store, proj, staging, trigger, push, at } = await setup();
    store.updateProject(proj.id, { lastSeenSha: B });
    store.updateStage(staging.id, { lastSeenSha: B });
    expect(store.headSeenAt(proj.id)).toBeGreaterThan(0);
    expect(store.headSeenAt(proj.id, staging.id)).toBeGreaterThan(0);
    expect((await push({ ref: "refs/heads/main", before: X, after: A, ...at(1) })).json.status).toBe("ignored");
    expect((await push({ ref: "refs/heads/stage", before: X, after: A, ...at(1) })).json.status).toBe("ignored");
    expect(trigger.enqueue).not.toHaveBeenCalled();
  });

  it("an upgraded head stored without a time gets one at start, so a replayed older push doesn't build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-webhooks-upgrade-"));
    const path = join(dir, "test.db");
    const first = createStore(path);
    const proj = first.createProject("acme");
    first.setGitConfig(proj.id, gitConfigBody() as never);
    const staging = first.createStage(proj.id, { name: "staging", branch: "stage", autoDeploy: true, host: "" });
    const secret = first.ensureWebhookSecret(proj.id);
    first.close();
    // As an older NBO left it: a head, and no time with it.
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE projects SET last_seen_sha = ?, last_seen_at = 0").run(B);
    raw.prepare("UPDATE stages SET last_seen_sha = ?, last_seen_at = 0 WHERE id = ?").run(B, staging.id);
    raw.close();
    const store = createStore(path);
    openStores.push(store);
    expect(store.headSeenAt(proj.id)).toBeGreaterThan(0);
    expect(store.headSeenAt(proj.id, staging.id)).toBeGreaterThan(0);
    const enqueue = vi.fn(() => ({ id: "build_1", status: "queued" }) as never);
    const router = createRouter();
    registerWebhookRoutes(router, store, { enqueue });
    for (const ref of ["refs/heads/main", "refs/heads/stage"]) {
      const payload = JSON.stringify({ ref, before: X, after: A, ...at(1) });
      const res = await router(
        new Request(`http://x/projects/${proj.id}/webhooks/github`, {
          method: "POST",
          body: payload,
          headers: { "x-hub-signature-256": sign(secret, payload), "x-github-event": "push" },
        }),
      );
      expect(((await res.json()) as { status: string }).status).toBe("ignored");
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a failed enqueue puts the head back, so the retry builds", async () => {
    const { store, proj, trigger, push, at } = await setup();
    vi.mocked(trigger.enqueue).mockImplementationOnce(() => {
      throw new Error("queue down");
    });
    const p = { ref: "refs/heads/main", before: X, after: A, ...at(1) };
    expect((await push(p)).status).toBe(500);
    expect(store.getProject(proj.id).lastSeenSha).toBe("");
    expect((await push(p)).json.status).toBe("queued");
  });
});
