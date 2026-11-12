// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { runWith, type ToolContext } from "./run.js";

// pushImage tags a local image under its Artifact Registry remote tag
// and pushes it. Cloud Run deploys only from a registry — there's no
// local-load shortcut the way `kind load docker-image` gives
// Kubernetes — port of PushImage (image.go lines 20-32).
export async function pushImage(localTag: string, remoteTag: string, ctx?: ToolContext): Promise<void> {
  await runWith(ctx, "docker", ["tag", localTag, remoteTag]);
  await runWith(ctx, "docker", ["push", remoteTag]);
}
