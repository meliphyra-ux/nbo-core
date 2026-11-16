// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The domain loop's deps and interfaces, and the state its parts share (one per loop).
import type { Store } from "../store/store.js";
import type { Domain } from "./domains.js";
import type { CloudRunDomains } from "./cloudrun-domains.js";
import type { EdgeSync } from "../edge/edge-sync.js";
import type { Resolver } from "./dns-check.js";
import { flexibleCheck, reachCheck } from "./cloudflare-check.js";
import type { CloudflareRanges } from "./cloudflare-ranges.js";
import { createChallengeStore, httpProbe, type AcmeClient, type ChallengeStore } from "./cert-acme.js";
import { defaultSleep, errText } from "./cert-policy.js";

export interface DomainLoopDeps {
  store: Store;
  resolver: Resolver;
  acme: AcmeClient;
  edgeSync: Pick<EdgeSync, "push">;
  // Google's domain mappings, for domains served by Cloud Run itself.
  cloudRun?: Pick<CloudRunDomains, "targetFor" | "describe" | "create" | "remove">;
  challenges?: ChallengeStore;
  ranges: Pick<CloudflareRanges, "isCloudflare" | "refresh">;
  reach?: typeof reachCheck;
  flexible?: typeof flexibleCheck;
  writeCert: (name: string, certPem: string, keyPem: string) => Promise<void>;
  deleteCert: (name: string) => Promise<void>;
  now?: () => Date;
  probe?: (host: string, token: string, keyAuth: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

export interface DomainLoop {
  tick(): Promise<void>;
  run(signal: AbortSignal): Promise<void>;
  checkNow(domainId: string): Promise<Domain>;
  // moveToEdge and removeMapped run in the loop's queue, so they never
  // interleave with a pass that is talking to Google about the same row.
  moveToEdge(domainId: string): Promise<Domain>;
  removeMapped(domainId: string): Promise<void>;
  setBehindCloudflare(domainId: string, on: boolean): Promise<Domain>;
  pasteCert(domainId: string, certPem: string, keyPem: string): Promise<Domain>;
  removePastedCert(domainId: string): Promise<Domain>;
  // challenges: the pending answers, for every route table write.
  challenges(): Record<string, string>;
  deleteCert(name: string): Promise<void>;
}

// createLoopCtx: the pieces more than one part of a loop uses; each loop gets its own.
export function createLoopCtx(deps: DomainLoopDeps) {
  const { store } = deps;
  const challenges = deps.challenges ?? createChallengeStore();
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const probe = deps.probe ?? httpProbe(() => store.getServerSettings().edgeAddress);
  const reach = deps.reach ?? reachCheck;
  const flexible = deps.flexible ?? flexibleCheck;

  // Daily passes. In memory: a restart just runs them once more.
  const nextFlexible = new Map<string, number>();
  const nextPastedWrite = new Map<string, number>();

  const due = (d: Domain): boolean => d.nextAttemptAt === "" || Date.parse(d.nextAttemptAt) <= now().getTime();

  async function push(projectId: string): Promise<void> {
    try {
      await deps.edgeSync.push(projectId);
    } catch (err) {
      console.error(`control-plane: domains: updating the edge route table failed: ${errText(err)}`);
    }
  }

  return { deps, store, challenges, now, sleep, probe, reach, flexible, nextFlexible, nextPastedWrite, due, push };
}

export type LoopCtx = ReturnType<typeof createLoopCtx>;
