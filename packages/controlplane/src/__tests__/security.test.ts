// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach } from "vitest";
import { startHarness, staticSetup, type Harness } from "./v2-harness.js";
import { isAllowedRequest } from "../handlers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("cross-site and DNS-rebinding guard", () => {
  it("refuses a cross-site browser POST that would run a build command", async () => {
    h = await startHarness();
    const res = await h.call("POST", "/projects/setup", staticSetup(), { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(h.store.listProjects()).toHaveLength(0);
  });

  it("refuses an opaque (null) origin", async () => {
    h = await startHarness();
    expect((await h.call("POST", "/projects/setup", staticSetup(), { origin: "null" })).status).toBe(403);
  });

  it("refuses a request whose Host isn't loopback (DNS rebinding), even a GET", async () => {
    h = await startHarness();
    expect((await h.call("GET", "/projects/summary", undefined, { host: "rebind.evil.example:8081" })).status).toBe(403);
  });

  it("allows the dashboard's own loopback origins and plain server-to-server calls", () => {
    const req = (headers: Record<string, string>) => new Request("http://cp/projects", { method: "POST", headers });
    expect(isAllowedRequest(req({}))).toBe(true);
    expect(isAllowedRequest(req({ origin: "http://localhost:5174", host: "localhost:5174" }))).toBe(true);
    expect(isAllowedRequest(req({ origin: "http://127.0.0.1:5173", host: "127.0.0.1:8081" }))).toBe(true);
    expect(isAllowedRequest(req({ origin: "http://[::1]:5174", host: "[::1]:8081" }))).toBe(true);
    expect(isAllowedRequest(req({ origin: "http://localhost.evil.example" }))).toBe(false);
    expect(isAllowedRequest(req({ host: "127.0.0.1.evil.example" }))).toBe(false);
  });
});
