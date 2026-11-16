// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { startHarness, deployedProject, type Harness } from "./v2-harness.js";
import { transferConfig } from "../deploys/transfer.js";
import { createSuppliedValues } from "../variables/supplied-values.js";
import { createRunner } from "../builds/runner.js";
import { createBuildQueue } from "../builds/build-queue.js";
import type { GitConfig } from "../git/git.js";

// dbFileText is the database file and any journal or WAL beside it, as text.
async function dbFileText(dbPath: string): Promise<string> {
  const parts: string[] = [];
  for (const p of [dbPath, `${dbPath}-journal`, `${dbPath}-wal`])
    if (existsSync(p)) parts.push((await readFile(p)).toString("latin1"));
  return parts.join("\n");
}

const namesOnlyMessage = "This NBO doesn't store variable values. Send them with each deploy.";
const waitingNote =
  "Waiting for variable values: this NBO doesn't store them. Deploy with values in POST /projects/{id}/builds or from Terraform (nbo_deployment).";

const SECRET = "s3cr3t-token-value-XYZ";
const PLAIN = "https://plain-value.example";
const SHORT = "prod";
const values = { SECRET_TOKEN: SECRET, API_URL: PLAIN, SHORT_NAME: SHORT };

const printVar = (name: string) =>
  process.platform === "win32" ? `echo VAL_${name}=%${name}%` : `echo VAL_${name}=$${name}`;
const echoAll = ["SECRET_TOKEN", "API_URL", "SHORT_NAME"].map(printVar).join(" && ");

let h: Harness;
const defaultStepDelayMs = transferConfig.stepDelayMs;
beforeEach(async () => {
  transferConfig.stepDelayMs = 10;
  h = await startHarness();
  h.store.setSecretKey(randomBytes(32));
});
afterEach(async () => {
  transferConfig.stepDelayMs = defaultStepDelayMs;
  await h.close();
});

const turnOn = () => h.call("PATCH", "/system/workspace-settings", { storeEnvValues: false, confirm: "delete values" });

// namesOnlyProject: a deployed project, then names-only on, with a secret,
// a long plain and a short plain name declared for Production.
async function namesOnlyProject(): Promise<string> {
  const id = await deployedProject(h);
  expect((await turnOn()).status).toBe(200);
  expect((await h.call("PUT", `/projects/${id}/env/SECRET_TOKEN`, { secret: true })).status).toBe(200);
  expect((await h.call("PUT", `/projects/${id}/env/API_URL`, { secret: false })).status).toBe(200);
  expect((await h.call("PUT", `/projects/${id}/env/SHORT_NAME`, { secret: false })).status).toBe(200);
  return id;
}

function setBuildCommand(id: string, buildCommand: string): void {
  const git: GitConfig = h.store.getGitConfig(id);
  h.store.setGitConfig(id, { ...git, buildCommand });
}

async function allFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(p);
  }
  return out;
}

describe("workspace setting: don't store variable values", () => {
  it("GET /workspace/settings says whether values are stored", async () => {
    expect((await h.call("GET", "/workspace/settings")).json).toEqual({ storeEnvValues: true });
    await turnOn();
    expect((await h.call("GET", "/workspace/settings")).json).toEqual({ storeEnvValues: false });
  });

  it('turning it on needs confirm: "delete values"', async () => {
    const res = await h.call("PATCH", "/system/workspace-settings", { storeEnvValues: false });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/delete values/);
    expect((await h.call("GET", "/workspace/settings")).json).toEqual({ storeEnvValues: true });
  });

  it("a token can't change it (403)", async () => {
    const { secret } = h.store.createApiToken("ci");
    const res = await h.call(
      "PATCH",
      "/system/workspace-settings",
      { storeEnvValues: false, confirm: "delete values" },
      { authorization: `Bearer ${secret}` },
    );
    expect(res.status).toBe(403);
    expect((await h.call("GET", "/workspace/settings")).json).toEqual({ storeEnvValues: true });
  });

  it("turning it on blanks every value and keeps names, stages and secret flags; the key check still passes", async () => {
    const id = await deployedProject(h);
    h.store.setEnv({ projectId: null }, "WS_PLAIN", "plain-before-clear-1", false);
    h.store.setEnv({ projectId: id }, "PROJ_SECRET", "secret-before-clear-1", true, "preview");
    h.store.setEnv({ projectId: id }, "PROJ_PLAIN", "plain-before-clear-2", false);
    expect((await turnOn()).status).toBe(200);

    const db = new DatabaseSync(h.dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT project_id, name, value, secret, stage, has_value FROM env_vars ORDER BY name")
        .all();
      expect(rows).toEqual([
        { project_id: id, name: "PROJ_PLAIN", value: "", secret: 0, stage: "production", has_value: 0 },
        { project_id: id, name: "PROJ_SECRET", value: "", secret: 1, stage: "preview", has_value: 0 },
        { project_id: null, name: "WS_PLAIN", value: "", secret: 0, stage: "production", has_value: 0 },
      ]);
    } finally {
      db.close();
    }
    const list = (await h.call("GET", `/projects/${id}/env`)).json as Record<string, unknown>[];
    expect(list.map((v) => [v.name, v.hasValue, "value" in v])).toEqual([
      ["PROJ_PLAIN", false, false],
      ["PROJ_SECRET", false, false],
      ["WS_PLAIN", false, false],
    ]);
    // The old values are gone from the file itself, not only from the rows.
    const bytes = (await readFile(h.dbPath)).toString("latin1");
    expect(bytes).not.toContain("plain-before-clear-1");
    expect(bytes).not.toContain("plain-before-clear-2");
    // A blanked secret is no sealed data: a restart with any key still starts.
    expect(h.store.hasSealedSecrets()).toBe(false);
    h.store.setSecretKey(randomBytes(32));
    expect(() => h.store.verifySecretKey()).not.toThrow();
  });

  it("turning it off is always allowed; names stay without values and resolve to nothing", async () => {
    const id = await deployedProject(h);
    h.store.setEnv({ projectId: id }, "API_URL", "https://x.example", false);
    await turnOn();
    const off = await h.call("PATCH", "/system/workspace-settings", { storeEnvValues: true });
    expect(off.status).toBe(200);
    expect(off.json).toEqual({ storeEnvValues: true });
    const list = (await h.call("GET", `/projects/${id}/env`)).json as Record<string, unknown>[];
    expect(list).toEqual([expect.objectContaining({ name: "API_URL", hasValue: false })]);
    expect(h.store.resolveEnv(id, "production").vars).toEqual({});
  });
});

describe("names only", () => {
  it("PUT with a value is refused; without one it declares the name", async () => {
    const id = await deployedProject(h);
    await turnOn();
    const refused = await h.call("PUT", `/projects/${id}/env/API_URL`, { value: "https://x.example", secret: false });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe(namesOnlyMessage);
    expect(
      (await h.call("PUT", "/workspace/env/API_URL", { value: "https://x.example", secret: false })).json.error,
    ).toBe(namesOnlyMessage);
    const declared = await h.call("PUT", `/projects/${id}/env/API_URL`, { secret: true });
    expect(declared.status).toBe(200);
    expect(declared.json).toMatchObject({ name: "API_URL", secret: true, hasValue: false, stage: "production" });
    expect("value" in declared.json).toBe(false);
  });

  it("GET /env/fingerprint is null", async () => {
    const id = await namesOnlyProject();
    expect((await h.call("GET", `/projects/${id}/env/fingerprint`)).json).toEqual({ fingerprint: null });
  });

  it("POST /builds without values lists the missing names; an undeclared name is refused", async () => {
    const id = await namesOnlyProject();
    const missing = await h.call("POST", `/projects/${id}/builds`, {});
    expect(missing.status).toBe(400);
    expect(missing.json.error).toMatch(/API_URL/);
    expect(missing.json.error).toMatch(/SECRET_TOKEN/);
    expect(missing.json.error).toMatch(/SHORT_NAME/);
    const undeclared = await h.call("POST", `/projects/${id}/builds`, { values: { ...values, OTHER: "x" } });
    expect(undeclared.status).toBe(400);
    expect(undeclared.json.error).toMatch(/OTHER/);
    expect(undeclared.json.error).toMatch(/declare it first, plain or secret/);
    const badShape = await h.call("POST", `/projects/${id}/builds`, { values: { API_URL: 3 } });
    expect(badShape.status).toBe(400);
    expect(h.store.listBuilds(id).filter((b) => b.manual)).toEqual([]);
  });

  it("with stored values, a body with values is refused; an empty map is fine", async () => {
    const id = await deployedProject(h);
    const res = await h.call("POST", `/projects/${id}/builds`, { values: { API_URL: "https://x.example" } });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(
      "This NBO stores variable values, so a deploy takes none: set them with PUT /projects/{id}/env/{name} or Terraform's nbo_env_var",
    );
    expect((await h.call("POST", `/projects/${id}/builds`, { values: {} })).status).toBe(202);
    await h.v2.queue.idle(id);
  });

  it("a build with values hands them to the build command and the deploy, then forgets them", async () => {
    const id = await namesOnlyProject();
    setBuildCommand(id, `${echoAll} && mkdir dist && echo hi > dist/index.html`);
    const res = await h.call("POST", `/projects/${id}/builds`, { values });
    expect(res.status).toBe(202);
    await h.v2.queue.idle(id);
    const build = h.store.getBuild(res.json.id);
    expect(build.status).toBe("succeeded");
    const opts = h.deploys.options.at(-1)!;
    expect(opts.env!.vars).toEqual(values);
    expect(opts.env!.secretNames).toEqual(["SECRET_TOKEN"]);
    // Secrets and plain values of 6+ characters reach the deploy's redaction list.
    expect(opts.redact).toEqual(expect.arrayContaining([SECRET, PLAIN]));
    expect(opts.redact).not.toContain(SHORT);
    expect(build.input?.variables).toEqual([
      { name: "API_URL", secret: false },
      { name: "SECRET_TOKEN", secret: true },
      { name: "SHORT_NAME", secret: false },
    ]);
    expect(build.input?.envFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(h.v2.supplied.size()).toBe(0);
  });

  it("a push build with declared names is recorded skipped at once and never clones", async () => {
    const id = await namesOnlyProject();
    const sha = await h.commit("push");
    const build = h.v2.queue.enqueue(id, sha);
    expect(build.status).toBe("skipped");
    expect(build.note).toBe(waitingNote);
    await h.v2.queue.idle(id);
    expect(h.store.getBuild(build.id).log).not.toMatch(/git clone/);
  });

  it("a push without values never replaces a queued build that has them", async () => {
    const id = await namesOnlyProject();
    h.deploys.delayMs = 300;
    const running = await h.call("POST", `/projects/${id}/builds`, { values });
    const queued = await h.call("POST", `/projects/${id}/builds`, { values });
    expect(h.store.getBuild(queued.json.id).status).toBe("queued");
    const push = h.v2.queue.enqueue(id, await h.commit("push"));
    expect(push.status).toBe("skipped");
    expect(h.store.getBuild(queued.json.id).status).toBe("queued");
    await h.v2.queue.idle(id);
    expect(h.store.getBuild(running.json.id).status).toBe("succeeded");
    expect(h.store.getBuild(queued.json.id).status).toBe("succeeded");
    expect(h.v2.supplied.size()).toBe(0);
  });

  it("the runner backstop: a queued job of a stage with declared names and no values is skipped with the note", async () => {
    const id = await namesOnlyProject();
    const job = h.store.createQueuedBuild(id, h.head);
    await createRunner(h.store, h.deploys).runBuild(job.id);
    const row = h.store.getBuild(job.id);
    expect(row.status).toBe("skipped");
    expect(row.note).toBe(waitingNote);
    expect(row.log).not.toMatch(/git clone/);
  });

  it("a stage with no declared names builds on push as usual", async () => {
    const id = await deployedProject(h);
    await turnOn();
    const build = h.v2.queue.enqueue(id, await h.commit("push"));
    expect(build.status).not.toBe("skipped");
    await h.v2.queue.idle(id);
    expect(h.store.getBuild(build.id).status).toBe("succeeded");
  });

  it("Review Focus 5: no value reaches the database file, a build row, a log or an error, whatever the outcome", async () => {
    const id = await namesOnlyProject();
    h.deploys.delayMs = 200;
    // 1. succeeds (the build command prints every value); it reads its
    // settings as it starts, so the command can change right after.
    setBuildCommand(id, `${echoAll} && mkdir dist && echo hi > dist/index.html`);
    const ok = await h.call("POST", `/projects/${id}/builds`, { values });
    expect(ok.status).toBe(202);
    expect(h.store.getBuild(ok.json.id).status).toBe("running");
    setBuildCommand(id, `${echoAll} && exit 1`);
    // 2. superseded while 1 runs
    const superseded = await h.call("POST", `/projects/${id}/builds`, { values });
    // 3. replaces 2 and fails at the build command, which echoes the values
    const failing = await h.call("POST", `/projects/${id}/builds`, { values });
    expect(h.store.getBuild(superseded.json.id).status).toBe("skipped");
    // The superseded job's values are dropped at once; 3's wait in memory.
    expect(h.v2.supplied.size()).toBe(1);
    await h.v2.queue.idle(id);
    // 4. skipped (a push: no values)
    const skipped = h.v2.queue.enqueue(id, await h.commit("push"));
    await h.v2.queue.idle(id);

    expect(h.store.getBuild(ok.json.id).status).toBe("succeeded");
    expect(h.store.getBuild(superseded.json.id).status).toBe("skipped");
    expect(h.store.getBuild(failing.json.id).status).toBe("failed");
    expect(h.store.getBuild(skipped.id).status).toBe("skipped");
    // The build commands did print the values; the log shows them redacted.
    for (const b of [ok.json.id, failing.json.id]) {
      const log = h.store.getBuild(b).log;
      expect(log).toMatch(/VAL_SECRET_TOKEN=/);
      expect(log).toMatch(/VAL_API_URL=/);
      // A short plain value may appear (documented).
      expect(log).toContain(`VAL_SHORT_NAME=${SHORT}`);
    }

    expect(h.v2.supplied.size()).toBe(0);
    const longValues = [SECRET, PLAIN];
    const rows = JSON.stringify(h.store.listBuilds(id));
    const deployments = JSON.stringify(
      h.store
        .listEnvironments(id, { includeArchived: true, allStages: true })
        .flatMap((e) => h.store.listDeployments(e.id)),
    );
    const dbBytes = (await readFile(h.dbPath)).toString("latin1");
    const artifactFiles = await allFiles(join(h.dbPath, "..", "artifacts"));
    const artifactText = (await Promise.all(artifactFiles.map((f) => readFile(f, "latin1")))).join("\n");
    for (const v of longValues) {
      expect(rows).not.toContain(v);
      expect(deployments).not.toContain(v);
      expect(dbBytes).not.toContain(v);
      expect(artifactText).not.toContain(v);
    }
  }, 60_000);

  it("Deploy this build carries values to the promote job; without them it lists the missing names", async () => {
    const id = await namesOnlyProject();
    const built = await h.call("POST", `/projects/${id}/builds`, { values });
    await h.v2.queue.idle(id);
    const [k8s] = h.store.listEnvironments(id);
    const missing = await h.call("POST", `/builds/${built.json.id}/deploy`, { environmentId: k8s!.id });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toMatch(/SECRET_TOKEN/);
    const other = { ...values, API_URL: "https://other-value.example" };
    const res = await h.call("POST", `/builds/${built.json.id}/deploy`, { environmentId: k8s!.id, values: other });
    expect(res.status).toBe(202);
    await h.v2.queue.idle(id);
    expect(h.store.getBuild(res.json.id).status).toBe("succeeded");
    expect(h.deploys.options.at(-1)!.env!.vars).toEqual(other);
    expect(h.v2.supplied.size()).toBe(0);
  });

  it("with stored values, Deploy this build refuses values", async () => {
    const id = await deployedProject(h);
    const [k8s] = h.store.listEnvironments(id);
    const live = h.store.listBuilds(id).at(-1)!;
    const res = await h.call("POST", `/builds/${live.id}/deploy`, { environmentId: k8s!.id, values: { A: "b" } });
    expect(res.status).toBe(400);
  });

  it("a transfer carries values to its promote job; without them it is refused", async () => {
    const id = await namesOnlyProject();
    await h.call("POST", `/projects/${id}/builds`, { values });
    await h.v2.queue.idle(id);
    const refused = await h.call("POST", `/projects/${id}/transfer`, { target: "cloudrun", mode: "auto" });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/API_URL/);
    const res = await h.call("POST", `/projects/${id}/transfer`, { target: "cloudrun", mode: "auto", values });
    expect(res.status).toBe(202);
    await h.v2.transfers.settled(id);
    expect(h.store.getTransfer(res.json.id).status).toBe("done");
    const cr = h.store.listEnvironments(id).find((e) => e.target === "cloudrun")!;
    const i = h.deploys.deployed.lastIndexOf(cr.id);
    expect(h.deploys.options[i]!.env!.vars).toEqual(values);
    expect(h.v2.supplied.size()).toBe(0);
  });
});

describe("turning names only on scrubs the database file", () => {
  it("no old value or its ciphertext survives: current, edited, deleted earlier, in a build log or a deployment error", async () => {
    const id = await deployedProject(h);
    const raw = (sql: string, ...args: string[]) => {
      const db = new DatabaseSync(h.dbPath, { readOnly: true });
      try {
        return db.prepare(sql).all(...args) as Record<string, string>[];
      } finally {
        db.close();
      }
    };
    const put = async (name: string, value: string, secret: boolean) =>
      expect((await h.call("PUT", `/projects/${id}/env/${name}`, { value, secret })).status).toBe(200);
    // Edited: the first value is freed by the update.
    await put("KEEP_PLAIN", "edited-away-plain-000", false);
    await put("KEEP_PLAIN", "old-plain-value-222", false);
    await put("KEEP_SECRET", "old-secret-value-111", true);
    await put("DELETED_SECRET", "deleted-secret-333", true);
    await put("DELETED_PLAIN", "deleted-plain-444", false);
    await h.call("PUT", "/workspace/env/WS_SECRET", { value: "workspace-secret-555", secret: true });
    const ciphertexts = raw("SELECT value FROM env_vars WHERE secret = 1").map((r) => r.value!);
    expect(ciphertexts).toHaveLength(3);
    // Deleted while values are still stored (secure_delete was off then).
    expect((await h.call("DELETE", `/projects/${id}/env/DELETED_SECRET`)).status).toBe(204);
    expect((await h.call("DELETE", `/projects/${id}/env/DELETED_PLAIN`)).status).toBe(204);

    // A build log that printed values (stored mode redacts secrets only).
    setBuildCommand(
      id,
      `${printVar("KEEP_PLAIN")} && ${printVar("KEEP_SECRET")} && mkdir dist && echo hi > dist/index.html`,
    );
    const built = await h.call("POST", `/projects/${id}/builds`, {});
    await h.v2.queue.idle(id);
    expect(h.store.getBuild(built.json.id).log).toContain("VAL_KEEP_PLAIN=old-plain-value-222");
    // A recorded deployment error that names a value.
    const [k8s] = h.store.listEnvironments(id);
    const dep = h.store.createDeployment(k8s!.id);
    h.store.failDeployment(dep.id, "deploy failed: old-plain-value-222 rejected");

    const before = await dbFileText(h.dbPath);
    expect(before).toContain("old-plain-value-222");

    expect((await turnOn()).status).toBe(200);

    const after = await dbFileText(h.dbPath);
    for (const v of [
      "edited-away-plain-000",
      "old-plain-value-222",
      "old-secret-value-111",
      "deleted-secret-333",
      "deleted-plain-444",
      "workspace-secret-555",
      ...ciphertexts,
    ]) {
      expect(after.includes(v), v).toBe(false);
    }
    expect(h.store.getBuild(built.json.id).log).toMatch(/VAL_KEEP_PLAIN=\S/);
    expect(h.store.listDeployments(k8s!.id).find((d) => d.id === dep.id)!.error).toMatch(
      /^deploy failed: .+ rejected$/,
    );
  }, 30_000);
});

describe("supplied values never outlive their job", () => {
  it("a transfer that fails before its promote job drops its values", async () => {
    const id = await namesOnlyProject();
    await h.call("POST", `/projects/${id}/builds`, { values });
    await h.v2.queue.idle(id);
    h.cloud.ensureError = new Error("PERMISSION_DENIED");
    const res = await h.call("POST", `/projects/${id}/transfer`, { target: "cloudrun", mode: "auto", values });
    expect(res.status).toBe(202);
    await h.v2.transfers.settled(id);
    expect(h.store.getTransfer(res.json.id).status).toBe("failed");
    expect(h.v2.supplied.size()).toBe(0);
  });

  it("a cancelled transfer drops its values", async () => {
    const id = await namesOnlyProject();
    await h.call("POST", `/projects/${id}/builds`, { values });
    await h.v2.queue.idle(id);
    // Hold provisioning open so the cancel lands before the promote job.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ensure = h.cloud.ensureCloudRun.bind(h.cloud);
    h.cloud.ensureCloudRun = async (...args) => {
      await gate;
      return ensure(...args);
    };
    const res = await h.call("POST", `/projects/${id}/transfer`, { target: "cloudrun", mode: "auto", values });
    expect(res.status).toBe(202);
    expect(h.v2.supplied.size()).toBe(1);
    expect((await h.call("POST", `/projects/${id}/transfer/cancel`)).status).toBe(200);
    release();
    await h.v2.transfers.settled(id);
    expect(h.store.getTransfer(res.json.id).status).toBe("cancelled");
    expect(h.v2.supplied.size()).toBe(0);
  });

  it("a runner that throws still leaves no values behind", async () => {
    const id = await namesOnlyProject();
    const supplied = createSuppliedValues();
    const queue = createBuildQueue(
      h.store,
      {
        async runBuild() {
          throw new Error("kaboom");
        },
      },
      supplied,
    );
    const b = queue.enqueue(id, h.head, { values });
    await queue.idle(id);
    expect(h.store.getBuild(b.id).status).toBe("failed");
    expect(supplied.size()).toBe(0);
  });
});

describe("SuppliedValues", () => {
  it("take removes; drop forgets; size counts jobs", () => {
    const s = createSuppliedValues();
    s.put("a", { X: "1" });
    s.put("b", { Y: "2" });
    expect(s.size()).toBe(2);
    expect(s.take("a")).toEqual({ X: "1" });
    expect(s.take("a")).toBeUndefined();
    s.drop("b");
    s.drop("missing");
    expect(s.size()).toBe(0);
  });
});
