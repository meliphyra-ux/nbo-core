// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { proxyRequestOrFail, type Resolver } from "./proxy.js";

// createStaticURLs returns a resolver proxying each name directly to
// its given base URL — the Kubernetes case, where the function is
// already running as its own Deployment/Service and nothing here
// spawns anything — port of NewStaticURLs (funcproxy.go lines 175-194).
export function createStaticURLs(urls: Record<string, string>): Resolver {
  const targets = new Map<string, URL>();
  for (const [name, rawURL] of Object.entries(urls)) {
    try {
      targets.set(name, new URL(rawURL));
    } catch {
      continue;
    }
  }

  return (name: string) => {
    const target = targets.get(name);
    if (!target) {
      throw new Error(`funcproxy: no static URL for function "${name}"`);
    }
    return (request: Request) => proxyRequestOrFail(request, target);
  };
}
