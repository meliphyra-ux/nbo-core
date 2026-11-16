// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { LINK_ROUTE_TIERS, LINK_SEALED_FIELDS, linkTierOf, tier2SignerRole } from "@nbo/link-protocol";
import {
  routeLinkTier,
  settingsTier,
  stagePatchTier,
  environmentPatchTier,
  suppliedValuesTier,
  stageCreateTier,
  stageDeleteTier,
} from "../../http/access.js";
import { requiredRole, sealedFields } from "../tiers.js";

const probes: unknown[] = [
  null,
  [],
  "x",
  3,
  {},
  { values: null },
  { values: { A: "1" } },
  { revision: "main" },
  { pollingEnabled: true },
  { expiresAt: 1 },
  { autoDeploy: true },
  { autoDeploy: true, project: "p" },
  { buildCommand: "x" },
  { kind: "ephemeral" },
  { kind: "ephemeral", branch: "b" },
  { kind: "custom" },
  { kind: 1 },
];

describe("link tier data equals the control-plane tables", () => {
  it("has exactly the same route keys", () => {
    expect(Object.keys(LINK_ROUTE_TIERS).sort()).toEqual(Object.keys(routeLinkTier).sort());
  });
  it("answers like each route's tier for every probe body", () => {
    for (const [key, tier] of Object.entries(routeLinkTier)) {
      for (const body of probes) {
        const got = linkTierOf(key, body);
        if (typeof tier !== "function") {
          expect(got, key).toBe(tier);
          continue;
        }
        if (
          tier === settingsTier ||
          tier === stagePatchTier ||
          tier === environmentPatchTier ||
          tier === suppliedValuesTier ||
          tier === stageCreateTier
        ) {
          expect(got, `${key} ${JSON.stringify(body)}`).toBe(tier({ body, params: {}, store: undefined as never }));
        } else {
          expect(tier, `${key}: new function row, add it to the protocol data and this test`).toBe(stageDeleteTier);
          expect(got, key).toBe("core");
        }
      }
    }
  });
  it("sealed fields and signer roles match", () => {
    expect(LINK_SEALED_FIELDS).toEqual(sealedFields);
    for (const key of Object.keys(routeLinkTier)) expect(tier2SignerRole(key), key).toBe(requiredRole(key));
  });
});
