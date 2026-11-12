// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cliDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "main.js");

describe("nbo isrcache", () => {
  it("starts the cache service and answers /healthz", async () => {
    const child = spawn("node", [cliDist, "isrcache"], { env: { ...process.env, NBO_ISRCACHE_ADDR: "127.0.0.1:0" } });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("never listened")), 10000);
        child.stdout.on("data", (chunk: Buffer) => {
          const m = chunk.toString().match(/isrcache: listening on :(\d+)/);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
        child.on("exit", (c) => reject(new Error(`exited ${c}`)));
      });
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      child.kill();
    }
  }, 20000);
});
