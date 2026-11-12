// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveControlPlaneAddr, initSecretKey } from "../main.js";
import { createStore } from "../store.js";
import { ErrSecretKey } from "../secrets.js";

describe("initSecretKey", () => {
  it("refuses to start with a key that does not open the sealed secrets, and starts with the right one", () => {
    const dir = mkdtempSync(join(tmpdir(), "controlplane-main-"));
    const dbPath = join(dir, "nbo.db");
    const keyA = randomBytes(32);
    const sealer = createStore(dbPath, { secretKey: keyA });
    sealer.saveGoogleConnection({ project: "p", region: "r", arRepo: "nbo", deployer: "d", puller: "q" }, { deployerKey: "a", pullerKey: "b" });
    sealer.close();

    const pathA = join(dir, "a.key");
    const pathB = join(dir, "b.key");
    writeFileSync(pathA, keyA);
    writeFileSync(pathB, randomBytes(32));

    const s1 = createStore(dbPath);
    expect(() => initSecretKey(s1, pathB)).toThrow(ErrSecretKey);
    expect(() => initSecretKey(s1, pathB)).toThrow(/b\.key/);
    s1.close();

    const s2 = createStore(dbPath);
    expect(() => initSecretKey(s2, pathA)).not.toThrow();
    expect(s2.getGoogleSecrets().deployerKey).toBe("a");
    s2.close();
  });
});

describe("resolveControlPlaneAddr", () => {
  it("defaults to loopback-only when NBO_CONTROL_PLANE_ADDR is unset", () => {
    expect(resolveControlPlaneAddr({})).toEqual({ host: "127.0.0.1", port: 8081 });
  });

  it("uses the exact host/port NBO_CONTROL_PLANE_ADDR gives", () => {
    expect(resolveControlPlaneAddr({ NBO_CONTROL_PLANE_ADDR: "0.0.0.0:9000" })).toEqual({ host: "0.0.0.0", port: 9000 });
  });
});

describe("resolveEdgeConfig", () => {
  it("reads NBO_EDGE_ADMIN_URL and NBO_EDGE_PUBLIC_PORT with defaults", async () => {
    const { resolveEdgeConfig } = await import("../main.js");
    expect(resolveEdgeConfig({})).toEqual({ adminUrl: "http://127.0.0.1:9444", publicPort: 9443 });
    expect(resolveEdgeConfig({ NBO_EDGE_ADMIN_URL: "http://127.0.0.1:7000", NBO_EDGE_PUBLIC_PORT: "8080" })).toEqual({ adminUrl: "http://127.0.0.1:7000", publicPort: 8080 });
  });
});

describe("main", () => {
  it("ignores NBO_DASHBOARD_DIR: starts, and / is the API router's 404", async () => {
    const { main } = await import("../main.js");
    const dir = mkdtempSync(join(tmpdir(), "controlplane-main-"));
    const before = process.exitCode;
    const started = main({
      NBO_CONTROL_PLANE_DB: join(dir, "nbo.db"),
      NBO_SECRET_KEY_FILE: join(dir, "nbo-secret.key"),
      NBO_CONTROL_PLANE_ADDR: "127.0.0.1:0",
      // An empty folder: the old dashboard serving refused to start on it.
      NBO_DASHBOARD_DIR: join(dir, "no-dashboard"),
      // Nothing listens here, so the background loops call nothing real.
      NBO_EDGE_ADMIN_URL: "http://127.0.0.1:9",
    });
    try {
      expect(process.exitCode).toBe(before);
      expect(started).toBeDefined();
      const port = await started!.listening;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(404);
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      process.exitCode = before;
      await started?.close();
    }
  });

  it("close() waits for a background tick that is running before it closes the database", async () => {
    const { main } = await import("../main.js");
    const { createServer } = await import("node:http");
    // A fake edge that holds the drain request until released.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let arrived!: () => void;
    const requested = new Promise<void>((r) => (arrived = r));
    const edge = createServer((req, res) => {
      arrived();
      void released.then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ batches: [] }));
      });
    });
    const edgePort = await new Promise<number>((r) => edge.listen(0, "127.0.0.1", () => r((edge.address() as { port: number }).port)));
    const dir = mkdtempSync(join(tmpdir(), "controlplane-main-"));
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    const started = main(
      {
        NBO_CONTROL_PLANE_DB: join(dir, "nbo.db"),
        NBO_SECRET_KEY_FILE: join(dir, "nbo-secret.key"),
        NBO_CONTROL_PLANE_ADDR: "127.0.0.1:0",
        NBO_EDGE_ADMIN_URL: `http://127.0.0.1:${edgePort}`,
      },
      { insightsSink: { write: async () => {} } },
    );
    try {
      expect(started).toBeDefined();
      await started!.listening;
      await requested;
      let closed = false;
      const closing = started!.close().then(() => (closed = true));
      await new Promise((r) => setTimeout(r, 150));
      expect(closed).toBe(false);
      release();
      await closing;
      expect(closed).toBe(true);
      // The tick finished on an open database.
      expect(errors.filter((e) => /drain/.test(e))).toEqual([]);
    } finally {
      console.error = origError;
      release();
      edge.close();
    }
  });
});
