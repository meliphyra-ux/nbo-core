// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { Agent, fetch as undiciFetch } from "undici";
import { parseRouteTable } from "./route-table.js";
import type { Registry } from "./registry.js";
import type { CertStore, ChallengeStore } from "./cert-store.js";
import type { CloudflareTrust } from "./cloudflare-trust.js";

export interface KubeSourceDeps {
  apiBase: string;
  token: () => string;
  ca?: string;
  namespace: string;
  fetch?: typeof fetch;
  intervalMs?: number;
  registry: Registry;
  certs: CertStore;
  challenges: ChallengeStore;
  cloudflareTrust?: CloudflareTrust;
  log?: (msg: string) => void;
}

const ROUTES_CONFIGMAP = "nbo-edge-routes";
const ROUTES_KEY = "routes.json";

interface SecretList {
  items?: { metadata?: { name?: string }; data?: Record<string, string> }[];
}

// startKubeSource polls the cluster API for the route table (a ConfigMap) and
// the certificate Secrets, and applies them to the registry and cert store.
export function startKubeSource(deps: KubeSourceDeps): { stop(): void; ready: Promise<void> } {
  const log = deps.log ?? ((m: string) => console.error(m));
  const intervalMs = deps.intervalMs ?? 5000;
  const dispatcher = deps.ca ? new Agent({ connect: { ca: deps.ca } }) : undefined;
  const doFetch: typeof fetch =
    deps.fetch ?? (((url: string, init: RequestInit) => undiciFetch(url, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch);
  const known = new Set<string>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function get(path: string): Promise<Response> {
    return doFetch(`${deps.apiBase}${path}`, { headers: { authorization: `Bearer ${deps.token()}`, accept: "application/json" } });
  }

  async function pollRoutes(): Promise<void> {
    const res = await get(`/api/v1/namespaces/${deps.namespace}/configmaps/${ROUTES_CONFIGMAP}`);
    if (res.status === 404) {
      await res.body?.cancel();
      deps.registry.replaceAll({});
      deps.challenges.replace({});
      deps.cloudflareTrust?.replace([]);
      return;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`configmap: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data?: Record<string, string> };
    try {
      const table = parseRouteTable(body.data?.[ROUTES_KEY] ?? "");
      deps.registry.replaceAll(table.targets);
      deps.challenges.replace(table.challenges);
      deps.cloudflareTrust?.replace(table.cloudflareRanges ?? []);
    } catch (err) {
      log(`edge: route table rejected, keeping the last good one: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function pollCerts(): Promise<void> {
    const res = await get(`/api/v1/namespaces/${deps.namespace}/secrets?labelSelector=nbo.dev%2Fedge-cert%3Dtrue`);
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`secrets: HTTP ${res.status}`);
    }
    const list = (await res.json()) as SecretList;
    const seen = new Set<string>();
    for (const item of list.items ?? []) {
      const name = item.metadata?.name;
      const crt = item.data?.["tls.crt"];
      const key = item.data?.["tls.key"];
      if (!name || !crt || !key) continue;
      seen.add(name);
      deps.certs.set(name, Buffer.from(crt, "base64").toString("utf8"), Buffer.from(key, "base64").toString("utf8"));
    }
    for (const name of known) if (!seen.has(name)) deps.certs.remove(name);
    known.clear();
    for (const n of seen) known.add(n);
  }

  async function pollOnce(): Promise<void> {
    for (const step of [pollRoutes, pollCerts]) {
      try {
        await step();
      } catch (err) {
        log(`edge: kubernetes poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const ready = pollOnce().then(() => {
    if (!stopped) timer = setTimeout(loop, intervalMs);
  });
  async function loop(): Promise<void> {
    await pollOnce();
    if (!stopped) timer = setTimeout(loop, intervalMs);
  }

  return {
    ready,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      void dispatcher?.close();
    },
  };
}
