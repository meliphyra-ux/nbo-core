// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { b64u, keyFingerprint, type Envelope, type LinkMessage, type SignedInstruction } from "@nbo/link-protocol";
import { createStore } from "../../store/store.js";
import {
  makeEnvelope,
  makeLinkTestKeys,
  signInstruction,
  type LinkTestKeys,
  type TestMemberKey,
} from "../../__tests__/link-keys-fixture.js";
import { makeTestKey, startFakePlatform, type FakePlatform } from "../../__tests__/link-fake-platform.js";

// The refusal suite: every case goes through a real WebSocket to a real
// main(), enrolled with a code. Each checks the reply's status, that the
// reason starts with "link: ", the journal row, and that the store did not
// change. A refusal by the verifier is a journal row with accepted false; a
// refusal after the verifier (a forbidden body field, an unsealed secret) is
// the accepted row with the status and reason the handler stage gave.

let keys: LinkTestKeys;
let ownerFp: string;
beforeAll(async () => {
  keys = await makeLinkTestKeys();
  ownerFp = await keyFingerprint(keys.owner.publicKey);
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

const CODE = "enr_7Hq2VnYc8TzPw3KdRm";
const SEEDED = "s3cret-seeded-value";
const GIT_TOKEN = "ghp_seededGitToken0123456789abcdef";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

interface World {
  p: FakePlatform;
  port: number;
  base: string;
  dbPath: string;
  projectId: string;
  stageId: string;
  buildId: string;
  revalidateToken: string;
  repoPath: string;
  branchSha: string;
  tagOnlySha: string;
}

async function boot(): Promise<World> {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const p = await startFakePlatform(keys, { codes: [CODE] });
  cleanups.push(() => p.close());
  const dir = await mkdtemp(join(tmpdir(), "nbo-link-refusals-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));

  // A local git repository: a commit on a branch, and one reachable only from a tag.
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repoPath]);
  git(repoPath, "config", "user.email", "test@example.com");
  git(repoPath, "config", "user.name", "Test");
  await writeFile(join(repoPath, "package.json"), "{}");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-q", "-m", "initial");
  const branchSha = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "checkout", "-q", "--detach");
  git(repoPath, "commit", "-q", "--allow-empty", "-m", "tag only");
  const tagOnlySha = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "tag", "only-a-tag");
  git(repoPath, "checkout", "-q", "main");

  const dbPath = join(dir, "nbo.db");
  const keyFile = join(dir, "nbo-secret.key");
  const secretKey = randomBytes(32);
  await writeFile(keyFile, secretKey);
  const seed = createStore(dbPath, { secretKey });
  const project = seed.createProject("shop");
  // No polling: the poller would build the new commit and write the project row.
  seed.updateProject(project.id, { pollingEnabled: false });
  const stage = seed.productionStage(project.id);
  seed.setGitConfig(project.id, {
    repo: repoPath,
    productionBranch: "main",
    framework: "static",
    buildCommand: "mkdir dist && echo hi > dist/index.html",
    outputDir: "dist",
  });
  seed.setEnv({ projectId: project.id }, "SEEDED", SEEDED, true);
  seed.setEnv({ projectId: project.id }, "PLAIN_NAME", "visible", false);
  seed.setGitCredential(project.id, { kind: "token", token: GIT_TOKEN });
  const revalidateToken = seed.ensureRevalidateToken(stage.id).token;
  const build = seed.createBuild(project.id, branchSha);
  seed.appendBuildLog(build.id, `building\nSEEDED=${SEEDED}\ntoken ${GIT_TOKEN}\nreval ${revalidateToken}\ndone\n`);
  seed.completeBuild(build.id, "succeeded");
  // The admin and developer keys exist already; the owner key comes from enrollment.
  for (const m of [keys.admin, keys.developer]) {
    seed.addMemberKey({ keyId: m.keyId, memberId: m.memberId, role: m.role, publicKey: m.publicKey, addedBy: "test" });
  }
  seed.close();

  const { main } = await import("../../main.js");
  const before = process.exitCode;
  const started = main({
    NBO_CONTROL_PLANE_DB: dbPath,
    NBO_SECRET_KEY_FILE: keyFile,
    NBO_CONTROL_PLANE_ADDR: "127.0.0.1:0",
    NBO_EDGE_ADMIN_URL: "http://127.0.0.1:9",
    NBO_LINK_ENROLL_URL: p.url,
    NBO_LINK_ENROLL_CODE: CODE,
    NBO_LINK_OWNER_KEY: ownerFp,
  });
  cleanups.push(async () => {
    process.exitCode = before;
    await started?.close();
  });
  expect(started).toBeDefined();
  const port = await started!.listening;
  await p.waitFor(() => p.connects.length > 0, 15_000);
  return {
    p,
    port,
    base: `http://127.0.0.1:${port}`,
    dbPath,
    projectId: project.id,
    stageId: stage.id,
    buildId: build.id,
    revalidateToken,
    repoPath,
    branchSha,
    tagOnlySha,
  };
}

// snapshot: every table's rows except the journal, builds (the poller and the
// queue write them) and the link state (its high sequence number moves).
function snapshot(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    )
      .map((t) => t.name)
      .filter((n) => !["link_journal", "link_state", "builds"].includes(n));
    return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
  } finally {
    db.close();
  }
}

interface Answer {
  id: string;
  status: number;
  body: string;
  // wire: every byte sequence the platform received for this instruction, as text and decoded.
  wire: string;
}

function answerOf(p: FakePlatform, id: string, which = 0): Answer | undefined {
  const msgs = p.messagesFor(id);
  const starts = msgs.filter((m) => m.type === "response" || m.type === "stream-start");
  const first = starts[which];
  if (!first) return undefined;
  let body: string;
  if (first.type === "response") {
    body = new TextDecoder().decode(b64u.decode(first.body));
  } else {
    if (!msgs.some((m) => m.type === "stream-end")) return undefined;
    const chunks = msgs
      .filter((m): m is Extract<LinkMessage, { type: "stream-chunk" }> => m.type === "stream-chunk")
      .sort((a, b) => a.index - b.index);
    body = Buffer.concat(chunks.map((c) => b64u.decode(c.data))).toString("utf8");
  }
  const wire = msgs.map((m) => JSON.stringify(m)).join("\n") + "\n" + body;
  return { id, status: (first as { status: number }).status, body, wire };
}

async function ask(w: World, over: Partial<Envelope>, opts: { member?: TestMemberKey } = {}): Promise<Answer> {
  const id = await w.p.sendInstruction(over, opts);
  return w.p.waitFor(() => answerOf(w.p, id), 10_000);
}

// sendSigned: a prepared instruction as is (twice for a replay, altered for a forgery).
async function sendSigned(w: World, i: SignedInstruction): Promise<void> {
  w.p.send({ type: "instruction", linkVersion: 1, instruction: i });
}

async function journalOf(
  w: World,
  id: string,
): Promise<{ id: string | null; status: number; reason: string; accepted: boolean }[]> {
  // The reply is sent after the journal row is written, but a stream outcome is written when the stream ends.
  const res = await fetch(`${w.base}/link/journal?limit=200`);
  const rows = (await res.json()) as { id: string | null; status: number; reason: string; accepted: boolean }[];
  return rows.filter((r) => r.id === id);
}

function refusedWith(a: Answer, status: number, reason: RegExp): void {
  expect(a.status).toBe(status);
  const error = (JSON.parse(a.body) as { error: string }).error;
  expect(error.startsWith("link: ")).toBe(true);
  expect(error).toMatch(reason);
}

describe("the link refusals, end to end", () => {
  it("refuses an unsigned instruction", async () => {
    const w = await boot();
    const before = snapshot(w.dbPath);
    const env = makeEnvelope(keys, new Date(), { method: "POST", routePattern: "/projects", body: { name: "evil" } });
    await sendSigned(w, { envelope: env, platformSignature: "" });
    const a = await w.p.waitFor(() => answerOf(w.p, env.id), 10_000);
    refusedWith(a, 401, /signature is not valid/);
    const rows = await journalOf(w, env.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accepted: false, status: 401 });
    expect(rows[0]!.reason).toMatch(/signature/);
    expect(snapshot(w.dbPath)).toBe(before);
  });

  it("refuses a replayed instruction", async () => {
    const w = await boot();
    const env = makeEnvelope(keys, new Date(), { method: "GET", routePattern: "/projects" });
    const signed = await signInstruction(keys, env);
    await sendSigned(w, signed);
    const first = await w.p.waitFor(() => answerOf(w.p, env.id), 10_000);
    expect(first.status).toBe(200);
    const before = snapshot(w.dbPath);
    await sendSigned(w, signed);
    const second = await w.p.waitFor(() => answerOf(w.p, env.id, 1), 10_000);
    refusedWith(second, 409, /already received/);
    const rows = await journalOf(w, env.id);
    expect(rows.filter((r) => r.accepted)).toHaveLength(1);
    const refused = rows.filter((r) => !r.accepted);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ status: 409 });
    expect(snapshot(w.dbPath)).toBe(before);
  });

  it("refuses an expired instruction", async () => {
    const w = await boot();
    const before = snapshot(w.dbPath);
    const a = await ask(w, {
      method: "POST",
      routePattern: "/projects",
      body: { name: "late" },
      expiresAt: Date.now() - 120_000,
    });
    refusedWith(a, 401, /expired/);
    const rows = await journalOf(w, a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accepted: false, status: 401 });
    expect(snapshot(w.dbPath)).toBe(before);
  });

  it("refuses a Tier 2 without a valid member signature", async () => {
    const w = await boot();
    const before = snapshot(w.dbPath);
    // No member signature at all.
    const none = await ask(w, { method: "POST", routePattern: "/projects", body: { name: "evil" } });
    refusedWith(none, 403, /member signature/);
    // A real owner signature, but over a different instruction.
    const other = makeEnvelope(keys, new Date(), {
      method: "POST",
      routePattern: "/projects",
      body: { name: "other" },
    });
    const otherSigned = await signInstruction(keys, other, { member: keys.owner });
    const env = makeEnvelope(keys, new Date(), { method: "POST", routePattern: "/projects", body: { name: "evil2" } });
    const forged = await signInstruction(keys, env);
    forged.tier2Signature = otherSigned.tier2Signature!;
    await sendSigned(w, forged);
    const wrong = await w.p.waitFor(() => answerOf(w.p, env.id), 10_000);
    refusedWith(wrong, 403, /member signature/);
    for (const id of [none.id, env.id]) {
      const rows = await journalOf(w, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ accepted: false, status: 403 });
    }
    expect(snapshot(w.dbPath)).toBe(before);
  });

  it("refuses a Tier 2 signed by a key the platform registered without an Owner's signature", async () => {
    const w = await boot();
    const before = snapshot(w.dbPath);
    const planted: TestMemberKey = { ...(await makeTestKey()), memberId: "mem_planted", role: "owner" };
    // The platform asks core to register an Owner key, signing it alone.
    const reg = await ask(w, {
      method: "POST",
      routePattern: "/link/member-keys",
      body: { memberId: planted.memberId, role: "owner", publicKey: planted.publicKey },
    });
    refusedWith(reg, 403, /member signature/);
    // And then uses that key anyway.
    const use = await ask(
      w,
      { method: "POST", routePattern: "/projects", body: { name: "evil" } },
      { member: planted },
    );
    refusedWith(use, 403, /member signature/);
    for (const id of [reg.id, use.id]) {
      const rows = await journalOf(w, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ accepted: false, status: 403 });
    }
    expect(snapshot(w.dbPath)).toBe(before);
    const members = (await (await fetch(`${w.base}/link/member-keys`)).json()) as { keyId: string }[];
    expect(members.some((m) => m.keyId === planted.keyId)).toBe(false);
  });

  it("refuses a Developer-role key on a Tier 2 route", async () => {
    const w = await boot();
    const before = snapshot(w.dbPath);
    const a = await ask(
      w,
      { method: "POST", routePattern: "/projects", body: { name: "evil" } },
      { member: keys.developer },
    );
    refusedWith(a, 403, /role developer can't sign/);
    const rows = await journalOf(w, a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accepted: false, status: 403 });
    expect(snapshot(w.dbPath)).toBe(before);
  });

  it("refuses a /system route outside the allowlist", async () => {
    const w = await boot();
    const before = snapshot(w.dbPath);
    const made = await ask(
      w,
      { method: "POST", routePattern: "/system/api-tokens", body: { name: "evil", role: "admin" } },
      { member: keys.owner },
    );
    refusedWith(made, 403, /route is not allowed over the link: POST \/system\/api-tokens/);
    const provider = await ask(w, { method: "GET", routePattern: "/system/terraform-provider" });
    refusedWith(provider, 403, /route is not allowed over the link: GET \/system\/terraform-provider/);
    for (const id of [made.id, provider.id]) {
      const rows = await journalOf(w, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ accepted: false, status: 403 });
    }
    expect(snapshot(w.dbPath)).toBe(before);
    const tokens = (await (await fetch(`${w.base}/system/api-tokens`)).json()) as unknown[];
    expect(tokens).toEqual([]);
  });

  it("refuses a clear-text admin credential", async () => {
    const w = await boot();
    const before = snapshot(w.dbPath);
    const kubeconfig = "apiVersion: v1\nkind: Config\nclusters: []\n";
    const a = await ask(
      w,
      { method: "POST", routePattern: "/system/edge/install", body: { cluster: "default", admin: { kubeconfig } } },
      { member: keys.owner },
    );
    refusedWith(a, 400, /admin\.kubeconfig must be sealed/);
    // The verifier accepted the signed instruction; core's next check refused it, and the row says so.
    const rows = await journalOf(w, a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accepted: true, status: 400 });
    expect(rows[0]!.reason).toMatch(/must be sealed/);
    expect(a.wire).not.toContain("apiVersion");
    expect(snapshot(w.dbPath)).toBe(before);
  });

  it("refuses a build of another repository", async () => {
    const w = await boot();
    const before = snapshot(w.dbPath);
    const buildsBefore = ((await (await fetch(`${w.base}/projects/${w.projectId}/builds`)).json()) as unknown[]).length;
    const a = await ask(w, {
      method: "POST",
      routePattern: "/projects/{projectID}/builds",
      params: { projectID: w.projectId },
      body: { repo: "https://example.invalid/someone/else.git", revision: w.branchSha },
    });
    refusedWith(a, 400, /repo can't be sent over the link/);
    const rows = await journalOf(w, a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accepted: true, status: 400 });
    expect(rows[0]!.reason).toMatch(/repo/);
    const buildsAfter = ((await (await fetch(`${w.base}/projects/${w.projectId}/builds`)).json()) as unknown[]).length;
    expect(buildsAfter).toBe(buildsBefore);
    expect(snapshot(w.dbPath)).toBe(before);
  });

  it("fails a build of a commit reachable only from a tag", async () => {
    const w = await boot();
    const a = await ask(w, {
      method: "POST",
      routePattern: "/projects/{projectID}/builds",
      params: { projectID: w.projectId },
      body: { revision: w.tagOnlySha },
    });
    expect(a.status).toBeLessThan(300);
    const id = (JSON.parse(a.body) as { id: string }).id;
    let failed: { status: string; error: string } | undefined;
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const b = (await (await fetch(`${w.base}/builds/${id}`)).json()) as { status: string; error: string };
      if (b.status === "failed" || b.status === "succeeded") {
        failed = b;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("is not on a branch");
    // Nothing was deployed: the seeded build is the only one that succeeded.
    const all = (await (await fetch(`${w.base}/projects/${w.projectId}/builds`)).json()) as {
      id: string;
      status: string;
    }[];
    expect(all.filter((b) => b.status === "succeeded").map((b) => b.id)).toEqual([w.buildId]);
  }, 60_000);

  it("never returns a seeded secret", async () => {
    const w = await boot();
    const before = snapshot(w.dbPath);
    const seeded = [SEEDED, GIT_TOKEN, w.revalidateToken];
    const answers: Answer[] = [];
    answers.push(
      await ask(w, { method: "GET", routePattern: "/projects/{projectID}/env", params: { projectID: w.projectId } }),
    );
    answers.push(
      await ask(w, { method: "GET", routePattern: "/projects/{projectID}/git", params: { projectID: w.projectId } }),
    );
    answers.push(
      await ask(
        w,
        {
          method: "POST",
          routePattern: "/projects/{projectID}/stages/{stageID}/revalidate-secret",
          params: { projectID: w.projectId, stageID: w.stageId },
        },
        { member: keys.owner },
      ),
    );
    answers.push(
      await ask(w, {
        method: "GET",
        routePattern: "/builds/{buildID}/log",
        params: { buildID: w.buildId },
        query: { follow: "1" },
      }),
    );
    // The routes answered, so the check below looks at real replies.
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
    expect(answers[0]!.body).toContain("SEEDED");
    expect(answers[3]!.body).toContain("SEEDED=");
    for (const a of answers) {
      const b64 = (s: string) => Buffer.from(s).toString("base64");
      for (const s of seeded) {
        expect(a.wire, a.id).not.toContain(s);
        expect(a.wire, a.id).not.toContain(b64(s));
        expect(a.wire, a.id).not.toContain(b64u.encode(Buffer.from(s)));
      }
    }
    // The secret is in the store (the redaction is the link's, not an empty seed).
    expect(snapshot(w.dbPath)).toBe(before);
    const sealedRow = new DatabaseSync(w.dbPath, { readOnly: true });
    try {
      expect(sealedRow.prepare("SELECT COUNT(*) AS n FROM stage_revalidate_tokens").get()).toEqual({ n: 1 });
    } finally {
      sealedRow.close();
    }
  });

  it("an accepted Tier 1 deploy runs", async () => {
    const w = await boot();
    const a = await ask(w, {
      method: "POST",
      routePattern: "/projects/{projectID}/builds",
      params: { projectID: w.projectId },
      body: { revision: w.branchSha },
    });
    expect(a.status).toBeLessThan(300);
    const rows = await journalOf(w, a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accepted: true });
    const id = (JSON.parse(a.body) as { id: string }).id;
    // The build ran: cloned, built and produced .nbo/. The project has no cloud to
    // deploy to (dev mode, no cluster), so it ends there, and says so.
    let build: { status: string; error: string; log: string } | undefined;
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const b = (await (await fetch(`${w.base}/builds/${id}`)).json()) as {
        status: string;
        error: string;
        log: string;
      };
      if (b.status === "failed" || b.status === "succeeded") {
        build = b;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(build).toBeDefined();
    expect(build!.log).toContain("build command done");
    expect(build!.log).toContain("produce .nbo done");
    expect(build!.error).not.toContain("is not on a branch");
    expect(build!.error).toContain("has no environments to deploy to");
  }, 60_000);
});
