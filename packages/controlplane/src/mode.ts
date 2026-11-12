// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export type Mode = "dev" | "production";

// parseMode reads NBO_MODE once at startup. Unset means dev, which keeps
// every pre-existing behaviour; anything unrecognised is refused rather
// than silently treated as dev.
export function parseMode(env: Record<string, string | undefined>): Mode {
  const v = env.NBO_MODE;
  if (v === undefined || v === "" || v === "dev") return "dev";
  if (v === "production") return "production";
  throw new Error('NBO_MODE must be "dev" or "production"');
}
