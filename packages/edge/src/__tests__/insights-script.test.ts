// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { runInNewContext } from "node:vm";
import { buildScript, loaderSource, scriptResponse, setWebVitalsReaderForTest } from "../insights/script.js";

type Cb = (m: { name: string; value: number }) => void;

function fakeVitals(values: Record<string, number>) {
  const v: Record<string, (cb: Cb) => void> = {};
  for (const name of ["LCP", "INP", "CLS", "FCP", "TTFB"]) {
    v[`on${name}`] = (cb) => {
      if (name in values) cb({ name, value: values[name]! });
    };
  }
  return v;
}

interface Env {
  dataset?: Record<string, string>;
  pathname?: string;
  random?: number;
  mobile?: boolean;
  userAgent?: string;
  innerWidth?: number;
  beacon?: boolean;
}

function runLoader(env: Env, webVitals: unknown, rate = 100) {
  const sent: { url: string; body: unknown; via: string }[] = [];
  const ctx = {
    webVitals,
    document: { currentScript: { dataset: env.dataset ?? {} } },
    location: { pathname: env.pathname ?? "/" },
    innerWidth: env.innerWidth ?? 1280,
    Math: Object.assign(Object.create(Math), { random: () => env.random ?? 0 }),
    navigator: {
      userAgent: env.userAgent ?? "Mozilla/5.0 (Windows NT 10.0) Chrome/130",
      userAgentData: env.mobile === undefined ? undefined : { mobile: env.mobile },
      sendBeacon:
        env.beacon === false
          ? undefined
          : (url: string, body: string) => {
              sent.push({ url, body: JSON.parse(body), via: "beacon" });
              return true;
            },
    },
    fetch: (url: string, init: { body: string; keepalive: boolean }) => {
      sent.push({ url, body: JSON.parse(init.body), via: init.keepalive ? "fetch-keepalive" : "fetch" });
      return Promise.resolve();
    },
    JSON,
    String,
    Number,
  };
  runInNewContext(loaderSource(rate), ctx);
  return sent;
}

describe("loader", () => {
  it("runs once per page: a second copy of the script sends nothing", () => {
    const sent: unknown[] = [];
    const registered: string[] = [];
    const vitals: Record<string, (cb: Cb) => void> = {};
    for (const name of ["LCP", "INP", "CLS", "FCP", "TTFB"]) {
      vitals[`on${name}`] = (cb) => {
        registered.push(name);
        cb({ name, value: 1 });
      };
    }
    const ctx: Record<string, unknown> = {
      webVitals: vitals,
      document: { currentScript: { dataset: {} } },
      location: { pathname: "/" },
      innerWidth: 1280,
      Math: Object.assign(Object.create(Math), { random: () => 0 }),
      navigator: { userAgent: "Chrome", sendBeacon: (_u: string, b: string) => (sent.push(JSON.parse(b)), true) },
      JSON,
      String,
      Number,
    };
    ctx.window = ctx;
    runInNewContext(loaderSource(100), ctx);
    runInNewContext(loaderSource(100), ctx);
    expect(registered).toHaveLength(5);
    expect(sent).toHaveLength(5);
  });

  it("sends one beacon per metric with route, device and data-e/data-d", () => {
    const sent = runLoader({ dataset: { e: "env_a", d: "sha256:x" }, pathname: "/users/42/edit" }, fakeVitals({ LCP: 1200, CLS: 0.02, INP: 80, FCP: 600, TTFB: 90 }));
    expect(sent.map((s) => (s.body as { metric: string }).metric).sort()).toEqual(["CLS", "FCP", "INP", "LCP", "TTFB"]);
    expect(sent[0]).toEqual({
      url: "/_nbo/insights/v1/vitals",
      via: "beacon",
      body: { metric: "LCP", value: 1200, route: "/users/[id]/edit", device: "desktop", environmentId: "env_a", contentId: "sha256:x" },
    });
  });

  it("omits environmentId/contentId when the tag has none (manual mode)", () => {
    const [s] = runLoader({}, fakeVitals({ LCP: 1 }));
    expect(s!.body).toEqual({ metric: "LCP", value: 1, route: "/", device: "desktop" });
  });

  it("uses userAgentData.mobile, else the UA / width", () => {
    expect((runLoader({ mobile: true }, fakeVitals({ LCP: 1 }))[0]!.body as { device: string }).device).toBe("mobile");
    expect((runLoader({ userAgent: "Mozilla/5.0 (iPhone) Mobile Safari" }, fakeVitals({ LCP: 1 }))[0]!.body as { device: string }).device).toBe("mobile");
    expect((runLoader({ innerWidth: 400 }, fakeVitals({ LCP: 1 }))[0]!.body as { device: string }).device).toBe("mobile");
  });

  it("falls back to fetch with keepalive without sendBeacon", () => {
    expect(runLoader({ beacon: false }, fakeVitals({ LCP: 1 }))[0]!.via).toBe("fetch-keepalive");
  });

  it("samples: data-s overrides the embedded rate", () => {
    expect(runLoader({ random: 0.3 }, fakeVitals({ LCP: 1 }), 25)).toHaveLength(0);
    expect(runLoader({ random: 0.2 }, fakeVitals({ LCP: 1 }), 25)).toHaveLength(1);
    expect(runLoader({ random: 0.3, dataset: { s: "50" } }, fakeVitals({ LCP: 1 }), 25)).toHaveLength(1);
    expect(runLoader({ random: 0.6, dataset: { s: "50" } }, fakeVitals({ LCP: 1 }), 100)).toHaveLength(0);
  });

  it("never throws", () => {
    expect(() => runLoader({}, undefined)).not.toThrow();
    const throwing = {
      onLCP: () => {
        throw new Error("x");
      },
    };
    expect(() => runLoader({}, throwing)).not.toThrow();
    expect(() => runInNewContext(loaderSource(100), {})).not.toThrow();
  });
});

describe("buildScript", () => {
  it("bundles web-vitals' IIFE build scoped inside a function, without a source map comment", () => {
    const js = buildScript(100);
    expect(js).toContain("webVitals");
    expect(js).toContain("onINP");
    expect(js).not.toContain("sourceMappingURL");
    expect(js.trimStart().startsWith("(function(){")).toBe(true);
  });

  it("runs in a page-less sandbox without throwing", () => {
    expect(() => runInNewContext(buildScript(100), { document: {}, navigator: {}, location: { pathname: "/" } })).not.toThrow();
  });

  it("is served as JavaScript cached for an hour", async () => {
    const res = scriptResponse(50);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await res.text()).toBe(buildScript(50));
  });
});

describe("scriptResponse without web-vitals", () => {
  it("answers 503 no-store instead of throwing, and recovers once it loads again", async () => {
    const restore = setWebVitalsReaderForTest(() => {
      throw new Error("ENOENT");
    });
    try {
      const res = scriptResponse(10);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      setWebVitalsReaderForTest(restore);
    }
    expect(scriptResponse(10).status).toBe(200);
  });
});
