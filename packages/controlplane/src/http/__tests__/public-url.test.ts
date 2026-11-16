// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { startHarness, noCommands } from "../../__tests__/v2-harness.js";
import { isPublicHost, parsePublicUrl } from "../public-url.js";

const root = join(import.meta.dirname, "..", "..", "..", "..", "..");

afterEach(() => vi.restoreAllMocks());

describe("NBO_PUBLIC_URL", () => {
  it("refuses http:// and a path, naming the variable", () => {
    expect(() => parsePublicUrl("http://nbo.example.com")).toThrow(/NBO_PUBLIC_URL.*https/);
    expect(() => parsePublicUrl("https://nbo.example.com/x")).toThrow(/NBO_PUBLIC_URL.*path/);
  });
  it("accepts a bare https address", () => {
    expect(parsePublicUrl("https://nbo.example.com")!.host).toBe("nbo.example.com");
  });
});

describe("the public host without a token", () => {
  it("is 403 on the API, naming what the address accepts; the tunnel keeps working", async () => {
    const h = await startHarness({ v2: { run: noCommands, publicUrl: parsePublicUrl("https://nbo.example.com") } });
    try {
      const api = await h.mux(
        new Request("https://nbo.example.com/projects", { headers: { host: "nbo.example.com" } }),
      );
      expect(api.status).toBe(403);
      expect(((await api.json()) as { error: string }).error).toMatch(/only API tokens and webhooks/);
      expect(
        (await h.mux(new Request("http://localhost:8081/projects", { headers: { host: "localhost:8081" } }))).status,
      ).toBe(200);
    } finally {
      await h.close();
    }
  });
});

describe("the public host, any spelling", () => {
  const spellings = ["nbo.example.com:443", "NBO.EXAMPLE.COM.", "NBO.EXAMPLE.COM:8443", "nbo.example.com.:443"];
  it.each(spellings)("Host %s: a token and a per-project webhook get through, nothing else does", async (host) => {
    const h = await startHarness({ v2: { run: noCommands, publicUrl: parsePublicUrl("https://nbo.example.com") } });
    try {
      const { secret } = h.store.createApiToken("ci");
      const auth = { host, authorization: `Bearer ${secret}` };
      expect(
        (await h.mux(new Request("https://nbo.example.com/projects", { headers: auth }))).status,
        "token GET",
      ).toBe(200);
      // The handler answers (no name), not the gate.
      expect(
        (await h.mux(new Request("https://nbo.example.com/projects", { method: "POST", headers: auth, body: "{}" })))
          .status,
        "token POST",
      ).toBe(400);
      // A webhook reaches its handler, which knows no project p1.
      expect(
        (
          await h.mux(
            new Request("https://nbo.example.com/projects/p1/webhooks/github", {
              method: "POST",
              headers: { host },
              body: "{}",
            }),
          )
        ).status,
        "webhook",
      ).toBe(404);
      const refused: Array<[string, Request]> = [
        ["plain", new Request("https://nbo.example.com/projects", { headers: { host } })],
        [
          "plain POST",
          new Request("https://nbo.example.com/projects", { method: "POST", headers: { host }, body: "{}" }),
        ],
        [
          "the old app webhook",
          new Request("https://nbo.example.com/github/webhook", { method: "POST", headers: { host }, body: "{}" }),
        ],
        ["token on /system", new Request("https://nbo.example.com/system/api-tokens", { headers: auth })],
      ];
      for (const [what, req] of refused) expect((await h.mux(req)).status, what).toBe(403);
    } finally {
      await h.close();
    }
  });
  it("normalises IPv6 brackets and ports for a public address on an IP", () => {
    const pub = parsePublicUrl("https://[2001:db8::1]")!;
    const req = (host: string) => new Request("https://x/", { headers: { host } });
    expect(isPublicHost(req("[2001:DB8::1]:443"), pub)).toBe(true);
    expect(isPublicHost(req("[2001:db8::2]"), pub)).toBe(false);
    expect(isPublicHost(req("localhost:8081"), pub)).toBe(false);
  });
});

describe("compose.public.yaml", () => {
  const base = parse(readFileSync(join(root, "compose.yaml"), "utf8"));
  const pub = parse(readFileSync(join(root, "compose.public.yaml"), "utf8"));

  it("adds Caddy, pinned, on 80 and 443 only", () => {
    expect(pub.services.caddy.image).toBe("caddy:2.8.4");
    expect(pub.services.caddy.ports.map(String)).toEqual(expect.arrayContaining(["80:80", "443:443"]));
    expect(pub.services.caddy.ports).toHaveLength(2);
    expect(pub.services.caddy.command.join(" ")).toContain("reverse-proxy");
    expect(pub.services.caddy.command.join(" ")).toContain("nbo:8081");
  });
  it("gives nbo its public address and leaves its port on loopback", () => {
    expect(pub.services.nbo.environment.NBO_PUBLIC_URL).toBe("https://${NBO_PUBLIC_HOST:?set NBO_PUBLIC_HOST in .env}");
    expect(pub.services.nbo.ports).toBeUndefined();
    expect(base.services.nbo.ports.every((p: string) => p.startsWith("127.0.0.1:"))).toBe(true);
    expect(base.services.caddy).toBeUndefined();
  });
  it("keeps the healthcheck on /healthz, which needs no token", () => {
    expect(base.services.nbo.healthcheck.test.join(" ")).toContain("http://127.0.0.1:8081/healthz");
  });
});
