// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "@nbo/serve";
import { serveFetch } from "@nbo/nodehost";
import { run, type Transcript } from "@nbo/conformance";
import { loadTranscripts } from "../conformance.js";
import { buildStaticApp, buildSpaApp, buildFunctionApp, buildCarryApp, carryFiles, writeCarry, echoFunction } from "./spec-apps.js";

// The spec 1.0 conformance suite: small apps built with @nbo/writer, served
// in-process by @nbo/serve's createHandler (with a deployment id, a carry
// directory and an in-process function) behind a real HTTP listener, and
// checked with the transcripts in packages/conformance/transcripts/spec-1.0.

const transcriptsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "conformance", "transcripts", "spec-1.0");

type App = "static" | "spa" | "function" | "carry";
const minimumCounts: Record<App, number> = { static: 8, spa: 2, function: 3, carry: 2 };

interface Running {
  baseURL: string;
  vars: Record<string, string>;
}

const running = {} as Record<App, Running>;
const servers: Server[] = [];
let tmp: string;

async function start(nboDir: string, deploymentId: string, carryDir?: string): Promise<string> {
  const handler = await createHandler(nboDir, () => echoFunction, undefined, { deploymentId, carryDir });
  return new Promise((resolve) => {
    const server = serveFetch(handler, { port: 0, host: "127.0.0.1" }, (port) => resolve(`127.0.0.1:${port}`));
    servers.push(server);
  });
}

// substitute fills {{contentId}}, {{host}} and {{carriedFrom}} in the three
// fields that compare response values, and refuses any placeholder left over.
function substitute(transcripts: Transcript[], vars: Record<string, string>): Transcript[] {
  const fill = (s: string): string => {
    const out = s.replace(/\{\{(\w+)\}\}/g, (m, name: string) => vars[name] ?? m);
    if (out.includes("{{")) throw new Error(`unknown placeholder in ${JSON.stringify(s)}`);
    return out;
  };
  const fillMap = (m?: Record<string, string>) => (m === undefined ? undefined : Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fill(v)])));
  return transcripts.map((tr) => ({
    ...tr,
    expectHeaders: fillMap(tr.expectHeaders),
    expectHeaderPatterns: fillMap(tr.expectHeaderPatterns),
    expectBodyContains: tr.expectBodyContains === undefined ? undefined : fill(tr.expectBodyContains),
  }));
}

function load(app: App): Promise<Transcript[]> {
  return loadTranscripts(join(transcriptsRoot, app));
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nbo-spec-conformance-"));

  const s = await buildStaticApp(join(tmp, "static"));
  const sHost = await start(join(tmp, "static"), s.contentId);
  running.static = { baseURL: `http://${sHost}`, vars: { contentId: s.contentId, host: sHost } };

  const spa = await buildSpaApp(join(tmp, "spa"));
  const spaHost = await start(join(tmp, "spa"), spa.contentId);
  running.spa = { baseURL: `http://${spaHost}`, vars: { contentId: spa.contentId, host: spaHost } };

  const fn = await buildFunctionApp(join(tmp, "function"));
  const fnHost = await start(join(tmp, "function"), fn.contentId);
  running.function = { baseURL: `http://${fnHost}`, vars: { contentId: fn.contentId, host: fnHost } };

  // Build A, then B; B is served with A's immutable files carried.
  const a = await buildCarryApp(join(tmp, "carry-a"), "old");
  const b = await buildCarryApp(join(tmp, "carry-b"), "new");
  const carried = Object.fromEntries(Object.entries(carryFiles.old).map(([p, body]) => [p, { body, contentType: "text/javascript; charset=utf-8" }]));
  await writeCarry(join(tmp, "carry-dir"), a.contentId, carried);
  const cHost = await start(join(tmp, "carry-b"), b.contentId, join(tmp, "carry-dir"));
  running.carry = { baseURL: `http://${cHost}`, vars: { contentId: b.contentId, host: cHost, carriedFrom: a.contentId } };
}, 60_000);

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  rmSync(tmp, { recursive: true, force: true });
});

describe("spec 1.0 conformance against nbo serve", () => {
  for (const app of Object.keys(minimumCounts) as App[]) {
    it(`${app}: has at least ${minimumCounts[app]} transcripts`, async () => {
      expect((await load(app)).length).toBeGreaterThanOrEqual(minimumCounts[app]);
    });

    it(`${app}: every transcript passes`, async () => {
      const { baseURL, vars } = running[app];
      const errors = await run(baseURL, substitute(await load(app), vars), false);
      expect(errors).toEqual([]);
    });
  }

  it("substitutes the exact content id, not a pattern", async () => {
    const [home] = substitute(await load("static"), running.static.vars);
    expect(home!.expectHeaders!["x-nbo-deployment-id"]).toBe(running.static.vars.contentId);
    expect(running.static.vars.contentId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("the deployment-id transcripts fail when run with a wrong id", async () => {
    const wrong = "sha256:" + "1".repeat(64);
    for (const app of ["static", "function", "carry"] as const) {
      const withId = (await load(app)).filter((tr) => JSON.stringify(tr.expectHeaders ?? {}).includes("{{contentId}}"));
      expect(withId.length).toBeGreaterThan(0);
      const errors = await run(running[app].baseURL, substitute(withId, { ...running[app].vars, contentId: wrong }), false);
      // One error per transcript at least: each names its own path.
      expect(new Set(errors.map((e) => e.split(":")[0])).size).toBe(new Set(withId.map((tr) => tr.path)).size);
    }
  });

  it("the trailing-slash rewrite is not a redirect", async () => {
    // fetch() in run() follows redirects, so the transcript alone can't tell.
    const res = await fetch(`${running.static.baseURL}/about/`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    await res.text();
  });

  it("a file only in the new build carries no x-nbo-carried-from", async () => {
    const res = await fetch(`${running.carry.baseURL}/assets/shared.js`);
    expect(res.headers.get("x-nbo-carried-from")).toBeNull();
    await res.text();
  });
});
