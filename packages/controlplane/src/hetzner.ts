// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { Store } from "./store.js";

// Hetzner load balancer location detection.
const hetznerLocation = "load-balancer.hetzner.cloud/location";
const hetznerZone = "load-balancer.hetzner.cloud/network-zone";

// A key in the saved annotations that carries detection's note to the install
// job log. It is never an annotation: readers take it out first.
export const noteKey = "nbo.dev/note";

export const operatorSetsLocation = (annotations: Record<string, string>): boolean => annotations[hetznerLocation] !== undefined || annotations[hetznerZone] !== undefined;

// hetznerAnnotations merges the Hetzner load balancer location, read from
// `kubectl get nodes -o json`, into the operator's NBO_LB_ANNOTATIONS. The
// operator's own location or network-zone always wins and stops detection.
// A note is returned when the nodes are Hetzner's but name no location.
export function hetznerAnnotations(nodesJson: string, existing: Record<string, string>): { annotations: Record<string, string>; note?: string } {
  if (operatorSetsLocation(existing)) return { annotations: existing };
  let items: { metadata?: { labels?: Record<string, string> }; spec?: { providerID?: string } }[];
  try {
    const i = nodesJson.indexOf("{");
    const parsed = JSON.parse(i > 0 ? nodesJson.slice(i) : nodesJson) as { items?: typeof items };
    items = Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return { annotations: existing };
  }
  const isHetzner = (n: (typeof items)[number]): boolean =>
    /^(hcloud|hetzner):\/\//.test(n.spec?.providerID ?? "") || Object.keys(n.metadata?.labels ?? {}).some((k) => /hetzner/.test(k));
  const nodes = items.filter(isHetzner);
  if (nodes.length === 0) return { annotations: existing };
  for (const n of nodes) {
    const labels = n.metadata?.labels ?? {};
    const location = labels["topology.kubernetes.io/region"] || labels["csi.hetzner.cloud/location"];
    if (location) return { annotations: { ...existing, [hetznerLocation]: location } };
  }
  return {
    annotations: existing,
    note: `Hetzner Cloud: the nodes name no load balancer location. Set ${hetznerLocation}=<location> in NBO_LB_ANNOTATIONS if the load balancer is not created`,
  };
}

// detectAndSave reads the nodes with admin credentials (readNodes) and saves
// what was found on the cluster's row ({} when nothing applies). A failure is
// logged and leaves the saved value as it was.
export async function detectAndSave(store: Store, clusterId: string, readNodes: () => Promise<string>): Promise<void> {
  try {
    const { annotations, note } = hetznerAnnotations(await readNodes(), {});
    store.setClusterLbAnnotations(clusterId, note ? { ...annotations, [noteKey]: note } : annotations);
    if (note) console.error(`control-plane: ${note}`);
  } catch (err) {
    console.error(`control-plane: reading the cluster's nodes failed, so no load balancer location was detected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// lbAnnotationsFor merges the cluster's saved annotations under the
// operator's NBO_LB_ANNOTATIONS (the operator wins; an operator location or
// network-zone ignores the saved value). `saved` null means never detected.
export function lbAnnotationsFor(saved: Record<string, string> | null, configured: Record<string, string>): Record<string, string> {
  if (saved === null || operatorSetsLocation(configured)) return configured;
  return { ...saved, ...configured };
}
