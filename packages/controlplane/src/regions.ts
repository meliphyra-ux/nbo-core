// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import type { CommandRunner, ToolContext } from "@nbo/deploy";

// Regions where Cloud Run domain mapping (preview) is supported, copied from
// Google's docs on the date below. Re-check periodically; Google changes it.
export const domainMappingRegions: { regions: readonly string[]; source: string; takenOn: string } = {
  regions: ["asia-east1", "asia-northeast1", "asia-southeast1", "europe-north1", "europe-west1", "europe-west4", "us-central1", "us-east1", "us-east4", "us-west1"],
  source: "https://cloud.google.com/run/docs/mapping-custom-domains",
  takenOn: "2026-11-03",
};

// project is passed explicitly: the credential's own gcloud config has no
// default project, and the region list is a per-project call.
export async function listCloudRunRegions(run: CommandRunner, ctx: ToolContext, project: string): Promise<{ id: string; domainMapping: boolean }[]> {
  const out = await run("gcloud", ["run", "regions", "list", "--project", project, "--format=value(locationId)"], { env: ctx.env });
  const supported = new Set(domainMappingRegions.regions);
  // Real runners merge stderr into the output; keep only region ids so a
  // gcloud warning line never shows up as a region.
  const ids = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^[a-z]+-[a-z]+\d+$/.test(s));
  return [...new Set(ids)].sort().map((id) => ({ id, domainMapping: supported.has(id) }));
}
