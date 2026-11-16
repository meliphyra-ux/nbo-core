// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { startHarness, deployedProject, bearer, type Harness } from "../../__tests__/v2-harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

interface Call {
  url: string;
  authorization: string | null;
  body: string;
}

// dev: a dev harness whose store has a secret key (main.ts always loads
// one) and whose revalidation calls go to a fake fetch.
async function dev(
  answer: () => Response = () => new Response(null, { status: 204 }),
): Promise<{ h: Harness; calls: Call[] }> {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: String(init?.body ?? ""),
    });
    return answer();
  }) as typeof globalThis.fetch;
  const h = await startHarness({ v2: { revalidateFetch: fetch } });
  h.store.setSecretKey(randomBytes(32));
  harnesses.push(h);
  return { h, calls };
}

const base = (projectId: string, stageId: string) => `/projects/${projectId}/stages/${stageId}`;

describe("POST .../revalidate-secret and .../rotate", () => {
  it("reveal creates the secret and returns the same one again; rotate returns a different one", async () => {
    const { h } = await dev();
    const id = await deployedProject(h);
    const stage = h.store.productionStage(id);
    expect(h.store.getRevalidateToken(stage.id)).toBeUndefined();
    const first = await h.call("POST", `${base(id, stage.id)}/revalidate-secret`);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), createdAt: expect.any(String) });
    expect(h.store.getRevalidateToken(stage.id)?.token).toBe(first.json.secret);
    const again = await h.call("POST", `${base(id, stage.id)}/revalidate-secret`);
    expect(again.json.secret).toBe(first.json.secret);
    const rotated = await h.call("POST", `${base(id, stage.id)}/revalidate-secret/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.json.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated.json.secret).not.toBe(first.json.secret);
    expect(h.store.getRevalidateToken(stage.id)?.token).toBe(rotated.json.secret);
  });

  it("is 404 for a stage of another project", async () => {
    const { h } = await dev();
    const id = await deployedProject(h);
    const other = h.store.createProject("other");
    const foreign = h.store.productionStage(other.id);
    expect((await h.call("POST", `${base(id, foreign.id)}/revalidate-secret`)).status).toBe(404);
    expect((await h.call("POST", `${base(id, foreign.id)}/revalidate-secret/rotate`)).status).toBe(404);
    expect((await h.call("POST", `${base(id, foreign.id)}/revalidate`, { tags: ["a"] })).status).toBe(404);
    expect(h.store.getRevalidateToken(foreign.id)).toBeUndefined();
  });
});

describe("POST .../revalidate", () => {
  it("refuses bad bodies with 400 and a message", async () => {
    const { h, calls } = await dev();
    const id = await deployedProject(h);
    const stage = h.store.productionStage(id);
    h.store.ensureRevalidateToken(stage.id);
    for (const body of [
      {},
      { tags: [] },
      { tags: [1] },
      { tags: ["x".repeat(257)] },
      { paths: Array.from({ length: 257 }, (_, i) => `/${i}`) },
      { paths: ["blog"] },
      { tags: ["a"], all: true },
    ]) {
      const res = await h.call("POST", `${base(id, stage.id)}/revalidate`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof res.json.error).toBe("string");
    }
    expect(calls).toHaveLength(0);
  });

  it("is 409 'Nothing in this environment uses ISR yet' without a secret", async () => {
    const { h, calls } = await dev();
    const id = await deployedProject(h);
    const stage = h.store.productionStage(id);
    const res = await h.call("POST", `${base(id, stage.id)}/revalidate`, { tags: ["a"] });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("Nothing in this environment uses ISR yet");
    expect(calls).toHaveLength(0);
  });

  it("posts through the edge with the stage's secret and answers per cloud, never with the secret", async () => {
    const { h, calls } = await dev();
    const id = await deployedProject(h);
    const stage = h.store.productionStage(id);
    const { token } = h.store.ensureRevalidateToken(stage.id);
    const env = h.store.listEnvironments(id)[0]!;
    const res = await h.call("POST", `${base(id, stage.id)}/revalidate`, { paths: ["/blog/x"] });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, results: [{ environmentId: env.id, cloud: "Kubernetes", status: 204 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://${h.store.getProject(id).edgeHost}:9443/_nbo/revalidate`);
    expect(calls[0]!.authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(calls[0]!.body)).toEqual({ paths: ["/blog/x"] });
    expect(res.text).not.toContain(token);
  });
});

describe("API tokens", () => {
  it("an API token may reveal, rotate and revalidate; a token made for a Developer while sign-in was on may not", async () => {
    const { h } = await dev();
    const id = await deployedProject(h);
    const stage = h.store.productionStage(id);
    const token = bearer(h.store.createApiToken("ci").secret);
    const secretPath = `${base(id, stage.id)}/revalidate-secret`;
    const shown = await h.call("POST", secretPath, undefined, token);
    expect(shown.status).toBe(200);
    const rotated = await h.call("POST", `${secretPath}/rotate`, undefined, token);
    expect(rotated.status).toBe(200);
    expect(rotated.json.secret).not.toBe(shown.json.secret);
    expect((await h.call("POST", `${base(id, stage.id)}/revalidate`, { tags: ["a"] }, token)).status).toBe(200);

    // A token row sign-in once made for a Developer (owner and role set).
    const { token: row, secret } = h.store.createApiToken("dev-token");
    const db = new DatabaseSync(h.dbPath);
    try {
      db.prepare("UPDATE api_tokens SET user_id = 'usr_dev', role = 'developer' WHERE id = ?").run(row.id);
    } finally {
      db.close();
    }
    for (const path of [secretPath, `${secretPath}/rotate`, `${base(id, stage.id)}/revalidate`]) {
      expect((await h.call("POST", path, { tags: ["a"] }, bearer(secret))).status, path).toBe(401);
    }
  });
});
