// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { appDockerfile, functionDockerfile } from "../templates.js";

// Docker reuses a cached layer only while every instruction before it
// is unchanged. The per-deploy inputs (the .nbo/ app, the baked
// function URLs and env) must therefore come after the expensive,
// rarely-changing steps (the CLI bundle and re2's native rebuild), or
// every deploy recompiles re2.
function lineIndex(dockerfile: string, pattern: RegExp): number {
  const i = dockerfile.split("\n").findIndex((l) => pattern.test(l));
  expect(i, `${pattern} in:\n${dockerfile}`).toBeGreaterThanOrEqual(0);
  return i;
}

describe("appDockerfile layer order", () => {
  it("copies the CLI and rebuilds re2 before any per-deploy COPY", () => {
    const cli = lineIndex(appDockerfile, /^COPY cli /);
    const re2 = lineIndex(appDockerfile, /^RUN re2_pkg=/);
    const perDeploy = [/^COPY app /, /^COPY functions\.json /, /^COPY env\.json /].map((p) =>
      lineIndex(appDockerfile, p),
    );
    expect(cli).toBeLessThan(re2);
    for (const i of perDeploy) expect(re2).toBeLessThan(i);
  });

  it("runs the re2 rebuild inside the CLI directory", () => {
    const workdir = lineIndex(appDockerfile, /^WORKDIR \/app\/cli$/);
    expect(workdir).toBeLessThan(lineIndex(appDockerfile, /^RUN re2_pkg=/));
  });

  it("keeps the entrypoint serving /app/app on 8080", () => {
    expect(appDockerfile).toContain('ENTRYPOINT ["node", "dist/main.js", "serve", "/app/app", "--port", "8080"');
  });

  it("copies the carry after the app and before the entrypoint, and serves it", () => {
    const app = lineIndex(appDockerfile, /^COPY app \/app\/app$/);
    const carry = lineIndex(appDockerfile, /^COPY carry \/app\/carry$/);
    const entry = lineIndex(appDockerfile, /^ENTRYPOINT /);
    expect(app).toBeLessThan(carry);
    expect(carry).toBeLessThan(entry);
    expect(appDockerfile).toContain('"--carry", "/app/carry"]');
  });
});

describe("functionDockerfile layer order", () => {
  it("copies the shared host before the function's own files", () => {
    const host = lineIndex(functionDockerfile, /^COPY host\.mjs /);
    for (const p of [/^COPY bundle /, /^COPY function\.json /, /^COPY env\.json /])
      expect(host).toBeLessThan(lineIndex(functionDockerfile, p));
  });
});
