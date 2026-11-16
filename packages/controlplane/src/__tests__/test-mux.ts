// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createMux, type Mux } from "../http/handlers.js";

// withHost: every real client sends Host, and a request without one is not
// loopback (isLoopbackRequest). A test's `new Request(url)` has none, so this
// gives such requests a loopback Host, as a local caller's would have.
export function withHost(mux: Mux): Mux {
  const wrapped = (request: Request): Promise<Response> => {
    if (request.headers.has("host")) return mux(request);
    const headers = new Headers(request.headers);
    headers.set("host", "localhost");
    return mux(new Request(request, { headers }));
  };
  return Object.assign(wrapped, { routes: () => mux.routes(), match: (r: Request) => mux.match(r) });
}

// createTestMux is createMux for tests that call it with host-less Requests.
export function createTestMux(...args: Parameters<typeof createMux>): Mux {
  return withHost(createMux(...args));
}
