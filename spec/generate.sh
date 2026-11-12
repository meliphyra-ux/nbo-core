#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail
cd "$(dirname "$0")"

for name in manifest static-index routes function bundle-index prerender; do
  pascal=$(node -e "const n=process.argv[1]; console.log(n.split('-').map(s=>s[0].toUpperCase()+s.slice(1)).join(''))" "$name")
  ts_file="generated/ts/$name.ts"
  # --just-types: quicktype otherwise emits a `Convert` class in every
  # generated file; barreling all three through generated/ts/index.ts via
  # `export *` then collides ("Module has already exported a member named
  # 'Convert'") since nothing in this repo calls Convert.*. Keep only the
  # interfaces/types so the barrel re-exports cleanly and stays idempotent.
  npx --yes quicktype -s schema -l typescript --just-types --top-level "$pascal" \
    -o "$ts_file" "$name.schema.json"

  if [ "$name" = "function" ]; then
    # quicktype names Artifact.type's enum "Type", which collides with
    # manifest.ts's own `Type` (Binding.type) once both barrel through
    # generated/ts/index.ts. The TS field is lowercase `type`, never
    # `Type`, so a plain word-boundary rename is safe.
    sed -i -E 's/\bType\b/ArtifactType/g' "$ts_file"
  fi

  if [ "$name" = "routes" ]; then
    # With has/missing gone, quicktype names Action.type's enum "Type",
    # which collides with manifest.ts's `Type` in the barrel (TS2308).
    # Keep the name it had before: ActionType.
    sed -i -E 's/\bType\b/ActionType/g' "$ts_file"
  fi

  if [ "$name" = "bundle-index" ]; then
    # quicktype names this file's per-entry interface "File", which
    # collides with static-index.ts's own `File`.
    sed -i -E 's/\bFile\b/BundleFileEntry/g' "$ts_file"
  fi
done
