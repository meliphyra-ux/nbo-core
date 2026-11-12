// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect, vi } from "vitest";
import { K8S_CLI_EXPORTS, K8S_PURE_EXPORTS, CLOUDRUN_CLI_EXPORTS, CLOUDRUN_PURE_EXPORTS, UnstubbedCLIError } from "./cli-guard.js";

// Mocked exactly the way the target tests mock the adapters, minus their
// stubs: whatever they leave unstubbed must throw, never spawn.
vi.mock("@nbo/adapter-k8s", async (importOriginal) => {
  const { guardCLI, K8S_CLI_EXPORTS } = await import("./cli-guard.js");
  return guardCLI(await importOriginal<typeof import("@nbo/adapter-k8s")>(), "adapter-k8s", K8S_CLI_EXPORTS);
});
vi.mock("@nbo/adapter-cloudrun", async (importOriginal) => {
  const { guardCLI, CLOUDRUN_CLI_EXPORTS } = await import("./cli-guard.js");
  return guardCLI(await importOriginal<typeof import("@nbo/adapter-cloudrun")>(), "adapter-cloudrun", CLOUDRUN_CLI_EXPORTS);
});

const k8s = (await import("@nbo/adapter-k8s")) as unknown as Record<string, unknown>;
const cr = (await import("@nbo/adapter-cloudrun")) as unknown as Record<string, unknown>;

function functionNames(mod: Record<string, unknown>): string[] {
  return Object.keys(mod)
    .filter((k) => typeof mod[k] === "function" || k === "capabilities")
    .sort();
}

describe("CLI guard for mocked adapters", () => {
  it.each([
    ["adapter-k8s", k8s, K8S_CLI_EXPORTS],
    ["adapter-cloudrun", cr, CLOUDRUN_CLI_EXPORTS],
  ] as const)("every CLI export of %s left unstubbed throws instead of spawning", async (_name, mod, names) => {
    for (const name of names) {
      const fn = mod[name] as (...args: unknown[]) => unknown;
      expect(() => fn("proj", "app"), name).toThrow(UnstubbedCLIError);
    }
  });

  it.each([
    ["adapter-k8s", "@nbo/adapter-k8s", K8S_CLI_EXPORTS, K8S_PURE_EXPORTS],
    ["adapter-cloudrun", "@nbo/adapter-cloudrun", CLOUDRUN_CLI_EXPORTS, CLOUDRUN_PURE_EXPORTS],
  ] as const)("every export of %s is classified as CLI or pure", async (_name, spec, cli, pure) => {
    const actual = await vi.importActual<Record<string, unknown>>(spec);
    expect(functionNames(actual)).toEqual([...cli, ...pure].sort());
  });
});
