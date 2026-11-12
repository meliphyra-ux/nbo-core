// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../store.js";
import { recoverInterruptedWork } from "../v2.js";

describe("recoverInterruptedWork", () => {
  it("fails leftover builds, setups and transfers a previous process never finished", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controlplane-recover-"));
    const store = createStore(join(dir, "test.db"));
    const p = store.createProject("acme");
    store.updateProject(p.id, { setupStatus: "provisioning" });
    const a = store.createEnvironment(p.id, "k8s", "kubernetes");
    const t = store.createTransfer(p.id, a.id, "");
    store.updateTransfer(t.id, { status: "shifting", weight: 10 });
    const b = store.createQueuedBuild(p.id, "a".repeat(40));
    store.startBuild(b.id);

    recoverInterruptedWork(store);

    expect(store.getProject(p.id)).toMatchObject({ setupStatus: "needs-setup", setupError: "interrupted: the control-plane restarted during setup — retry it" });
    expect(store.getTransfer(t.id)).toMatchObject({ status: "failed", weight: 10, error: "interrupted: the control-plane restarted during this transfer" });
    expect(store.getBuild(b.id).status).toBe("failed");
    store.close();
  });
});
