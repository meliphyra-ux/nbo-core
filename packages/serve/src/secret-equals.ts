// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createHash, timingSafeEqual } from "node:crypto";

// secretEquals compares a value a visitor sent with a secret in constant
// time: both are hashed to sha256 first, so the compare takes the same time
// whatever the lengths and wherever they first differ.
export function secretEquals(provided: string, secret: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(a, b);
}
