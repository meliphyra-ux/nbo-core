// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Traced asset keys are repo-root-relative (e.g.
// "fixtures/next-app/.next/server/app/page.js"), but Next's own runtime
// looks up files like .next/routes-manifest.json relative to the bundle's
// own root — stripping the project's own repo-relative prefix makes the
// bundle's layout match what a real `next start` working directory looks
// like. This must be the ONLY place that strips it: the writer just
// copies files to whatever key it's given, so dispatch metadata (built
// from this same function) and the actual copy destination can never
// disagree.
export function stripProjectRoot(relPath, projectRoot) {
  const normalized = relPath.replace(/\\/g, "/");
  const prefix = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}
