// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { nodeToFetch } from "@nbo/nodehost";
import { createStore, type Store } from "./store/store.js";
import { ErrStrandedSettings } from "./store/migrate.js";
import { createMux } from "./http/handlers.js";
import { triggerDeploy, type Orchestrator, type TriggerDeployOptions } from "./deploys/deploy.js";
import { run } from "./deploys/scheduler.js";
import { wireV2, recoverInterruptedWork } from "./v2.js";
import { sweepStaleGitKeys } from "./git/git-credentials.js";
import { createCloudSetup } from "./clouds/cloud-setup.js";
import { runPoller } from "./git/poller.js";
import { runStageExpiry } from "./stages/stage-expiry.js";
import { parseMode } from "./mode.js";
import { ErrSecretKey, loadOrCreateKey, secretKeyPath } from "./store/secrets.js";
import { createArtifactStore, resolveArtifactsDir } from "./builds/artifacts.js";
import { httpDrainSource, startInsightsDrain, type InsightsSink } from "./insights/drain.js";
import { clusterEdgeActive, createClusterDrainSource, storeKubeconfig } from "./edge/edge-table.js";
import { parseServiceAnnotations } from "./edge/edge-manifests.js";
import { createSuppliedValues } from "./variables/supplied-values.js";
import { parsePublicUrl } from "./http/public-url.js";
import { createDispatcher } from "./link/dispatch.js";
import { startLinkClient } from "./link/client.js";
import { enrollFromEnvironment } from "./link/enroll.js";
import { createLinkControl } from "./link/routes.js";

// resolveControlPlaneAddr picks the listen address — loopback-only by
// default, since this API triggers real deploys and its only authentication
// is API tokens (api-tokens.ts; no header means the loopback rule), so it
// shouldn't be reachable from the network unless NBO_CONTROL_PLANE_ADDR is set
// explicitly to opt in — port of main's own addr resolution (main.go
// lines 18-25).
export function resolveControlPlaneAddr(env: Record<string, string | undefined>): { host: string; port: number } {
  const addr = env.NBO_CONTROL_PLANE_ADDR;
  if (!addr) return { host: "127.0.0.1", port: 8081 };
  const idx = addr.lastIndexOf(":");
  return { host: addr.slice(0, idx), port: Number(addr.slice(idx + 1)) };
}

// resolveEdgeConfig says where the edge's admin API is (the
// control-plane pushes each project's split there) and which public
// port its data plane serves on (part of each project's domain URL).
export function resolveEdgeConfig(env: Record<string, string | undefined>): { adminUrl: string; publicPort: number } {
  const port = Number(env.NBO_EDGE_PUBLIC_PORT);
  return {
    adminUrl: env.NBO_EDGE_ADMIN_URL || "http://127.0.0.1:9444",
    publicPort: Number.isInteger(port) && port > 0 ? port : 9443,
  };
}

// initSecretKey loads (or creates) the key at keyPath, hands it to the
// store, and proves it opens every sealed secret — a wrong key file must
// stop startup, not surface later as a failed deploy.
export function initSecretKey(store: Store, keyPath: string): void {
  const sealed = store.hasSealedSecrets();
  store.setSecretKey(loadOrCreateKey(keyPath, { hasSealedData: sealed }));
  if (!sealed) return;
  try {
    store.verifySecretKey();
  } catch (err) {
    if (err instanceof ErrSecretKey) {
      throw new ErrSecretKey(
        `secret key file ${keyPath} does not decrypt the secrets stored in this database — restore the original key file or set NBO_SECRET_KEY_FILE to it`,
      );
    }
    throw err;
  }
}

// Started is what main hands back: the port once the server listens, and
// close(), which stops the background loops and the server (tests use it).
export interface Started {
  listening: Promise<number>;
  close(): Promise<void>;
}

// MainExtras are what an embedding product plugs in. Core has no Speed
// Insights storage, so with no insightsSink nothing drains the edge.
export interface MainExtras {
  insightsSink?: InsightsSink;
}

// main starts the control-plane from env. It returns undefined, with
// process.exitCode set, when a setting stops startup.
export function main(
  env: Record<string, string | undefined> = process.env,
  extras: MainExtras = {},
): Started | undefined {
  const dbPath = env.NBO_CONTROL_PLANE_DB;
  if (!dbPath) {
    console.error("control-plane: NBO_CONTROL_PLANE_DB must be set to a SQLite file path");
    process.exitCode = 1;
    return undefined;
  }

  let mode;
  try {
    mode = parseMode(env);
  } catch (err) {
    console.error(`control-plane: ${(err as Error).message}`);
    process.exitCode = 1;
    return undefined;
  }
  // Each build's .nbo/ is kept here (NBO_ARTIFACTS_DIR, default
  // artifacts/ next to the database).
  const artifactsDir = resolveArtifactsDir(env, dbPath);
  mkdirSync(artifactsDir, { recursive: true });
  let store: Store;
  try {
    store = createStore(dbPath, { artifactsDir });
  } catch (err) {
    if (err instanceof ErrStrandedSettings) {
      console.error(`control-plane: ${err.message}`);
      process.exitCode = 1;
      return undefined;
    }
    throw err;
  }
  // A database from before the core split keeps the tables of the features
  // that moved out; say so once, so nobody mistakes them for live data.
  const legacy = store.legacyTablesInUse();
  if (legacy.length > 0) {
    console.log(
      `control-plane: this database holds data from features that moved to the hosted dashboard (${legacy.join(", ")}); it is kept, unused, until you migrate`,
    );
  }
  const artifacts = createArtifactStore(artifactsDir, (projectId) => store.listBuilds(projectId).map((b) => b.id));
  try {
    initSecretKey(store, secretKeyPath(env, dbPath));
  } catch (err) {
    if (err instanceof ErrSecretKey) {
      console.error(`control-plane: ${err.message}`);
      process.exitCode = 1;
      return undefined;
    }
    throw err;
  }
  const orchestrator: Orchestrator = { store, mode };
  const deploymentTrigger = {
    triggerDeploy: (environmentId: string, nboDir: string, opts?: TriggerDeployOptions) =>
      triggerDeploy(orchestrator, environmentId, nboDir, opts),
  };
  recoverInterruptedWork(store);
  // Deploy key files a stopped process left behind (before any git step runs).
  sweepStaleGitKeys();
  const edge = resolveEdgeConfig(env);
  let loadBalancerAnnotations: Record<string, string>;
  try {
    loadBalancerAnnotations = parseServiceAnnotations(env.NBO_LB_ANNOTATIONS);
  } catch (err) {
    console.error(`control-plane: ${(err as Error).message}`);
    process.exitCode = 1;
    return undefined;
  }
  // NBO_PUBLIC_URL: NBO's own https address. A bad value stops startup.
  let publicUrl: URL | undefined;
  try {
    publicUrl = parsePublicUrl(env.NBO_PUBLIC_URL);
  } catch (err) {
    console.error(`control-plane: ${(err as Error).message}`);
    process.exitCode = 1;
    return undefined;
  }
  // The link routes exist before the link client does; the client is
  // attached once started below.
  const link = createLinkControl();
  const v2 = wireV2(store, {
    link,
    publicUrl,
    // Deploy keys check host keys against this file, next to the database.
    knownHostsFile: join(dirname(dbPath), "known_hosts"),
    // Projects linked to the old per-server GitHub App (github-legacy.ts).
    githubApiUrl: "https://api.github.com",
    deploymentTrigger,
    mode,
    cloudSetup: createCloudSetup(undefined, { cacheMs: 15_000, mode, store }),
    edgeAdminUrl: edge.adminUrl,
    edgePublicPort: edge.publicPort,
    artifacts,
    loadBalancerAnnotations,
    // Values deploy requests bring when NBO keeps names only: memory only.
    supplied: createSuppliedValues(),
  });
  // The API alone: the dashboard is not part of NBO core, and the old
  // setting that pointed at its files is ignored.
  const mux = createMux(store, deploymentTrigger, v2.queue, v2);

  const stop = new AbortController();
  // The background loops; close() waits for a tick that is running.
  const loops: Promise<unknown>[] = [];
  loops.push(run({ store }, stop.signal));
  loops.push(
    runPoller(
      {
        store,
        queue: v2.queue,
        edgeSync: v2.edgeSync,
        lsRemoteHeads: v2.lsRemoteHeads,
        gitAuth: v2.gitAuth,
        poller: v2.poller,
        setup: v2.setup,
      },
      stop.signal,
    ),
  );
  // Ephemeral stages: remove the expired ones every 10 minutes.
  loops.push(runStageExpiry(v2.stageExpiry, stop.signal));
  // Speed Insights: with a sink supplied, pull the edge's Web Vitals every
  // 60 s — from the edge cluster's pods once the public edge is in use, else
  // the dev edge. No sink (core alone): the edge is never drained.
  const devDrain = httpDrainSource(edge.adminUrl);
  const clusterDrain = createClusterDrainSource({ store, run: v2.run, kubeconfigFor: storeKubeconfig(store) });
  const drainSource = () => (clusterEdgeActive(store, mode) ? clusterDrain() : devDrain());
  const drain = startInsightsDrain(store, extras.insightsSink, { source: drainSource }, stop.signal);
  if (drain) loops.push(drain);
  // Domains: DNS checks and Let's Encrypt certificates every 60 s, in
  // production (each tick does nothing until an edge is installed).
  if (mode === "production") loops.push(v2.domains.run(stop.signal));

  // The link to a hosted dashboard, outside `loops`: it runs in the
  // background, does nothing while unlinked, and nothing above waits on it.
  const dispatcher = createDispatcher({ store, mux, supplied: v2.supplied, github: v2.legacyGitHub });
  const linkClient = startLinkClient({ store, dispatcher, signal: stop.signal });
  link.attach(linkClient);
  // Install-time enrollment (NBO_LINK_ENROLL_*): in the background too; a
  // linked core ignores the settings, a refusal is one log line.
  const enrolling = enrollFromEnvironment(env, { store, signal: stop.signal, onLinked: () => link.restart() });

  const { host, port } = resolveControlPlaneAddr(env);
  // clientIp: the socket's address reaches handlers as x-nbo-client-ip (a
  // visitor's own value is replaced).
  const server = createServer(nodeToFetch(mux, { clientIp: true }));
  const listening = new Promise<number>((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const p = typeof address === "object" && address ? address.port : port;
      console.log(`control-plane: listening on ${host}:${p} (db ${dbPath})`);
      resolve(p);
    });
  });
  return {
    listening,
    close: async () => {
      stop.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // A tick already running finishes on an open database.
      await Promise.allSettled([...loops, linkClient.stop(), enrolling]);
      store.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main();
}
