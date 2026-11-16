// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathWith, runBash, withFakeTools } from "./helpers.mjs";

function setup() {
  const t = withFakeTools(["socat", "kubectl"]);
  const dir = mkdtempSync(join(tmpdir(), "nbo-hosts-"));
  const hosts = join(dir, "hosts");
  writeFileSync(hosts, "127.0.0.1 localhost\n");
  return {
    t,
    hosts,
    done: () => {
      t.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("NBO_CI_DIND=1: three forwards, kubeconfig server, hosts entries", async () => {
  const s = setup();
  try {
    const r = runBash("scripts/ci/dind-forward.sh", [], {
      NBO_CI_DIND: "1",
      NBO_HOSTS_FILE: s.hosts,
      PATH: pathWith(s.t.binDir),
    });
    assert.equal(r.code, 0, r.stderr);
    for (
      let i = 0;
      i < 50 && s.t.readLog().filter((a) => a.length && a.some((x) => x.startsWith("TCP-LISTEN"))).length < 3;
      i++
    ) {
      await new Promise((res) => setTimeout(res, 100));
    }
    const log = s.t.readLog();
    const socats = log.filter((a) => a[0].startsWith("TCP-LISTEN"));
    for (const p of [80, 443, 6443]) {
      assert.ok(
        socats.some((a) => a[0] === `TCP-LISTEN:${p},fork,reuseaddr` && a[1] === `TCP:docker:${p}`),
        `forward for ${p}`,
      );
    }
    assert.ok(log.some((a) => a.join(" ") === "config set-cluster kind-nbo-local --server=https://127.0.0.1:6443"));
    const hosts = readFileSync(s.hosts, "utf8");
    assert.match(hosts, /127\.0\.0\.1\s+next-app\.127\.0\.0\.1\.sslip\.io/);
    assert.match(hosts, /127\.0\.0\.1\s+ppr-app\.127\.0\.0\.1\.sslip\.io/);
  } finally {
    s.done();
  }
});

test("NBO_CI_DIND unset: does nothing, exits 0", () => {
  const s = setup();
  try {
    const r = runBash("scripts/ci/dind-forward.sh", [], {
      NBO_CI_DIND: "",
      NBO_HOSTS_FILE: s.hosts,
      PATH: pathWith(s.t.binDir),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(s.t.readLog(), []);
    assert.equal(readFileSync(s.hosts, "utf8"), "127.0.0.1 localhost\n");
  } finally {
    s.done();
  }
});
