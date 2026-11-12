// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { resolveEdgeAddrs } from "../main.js";

describe("resolveEdgeAddrs", () => {
  it("defaults when no env vars are set", () => {
    expect(resolveEdgeAddrs({})).toEqual({ dataPort: 9443, adminHost: "127.0.0.1", adminPort: 9444 });
  });

  it("NBO_EDGE_ADDR overrides the data-plane port", () => {
    expect(resolveEdgeAddrs({ NBO_EDGE_ADDR: ":1111" })).toMatchObject({ dataPort: 1111 });
  });

  it("NBO_EDGE_ADMIN_ADDR overrides the admin host and port independently", () => {
    expect(resolveEdgeAddrs({ NBO_EDGE_ADMIN_ADDR: "0.0.0.0:2222" })).toMatchObject({ adminHost: "0.0.0.0", adminPort: 2222 });
  });
});
