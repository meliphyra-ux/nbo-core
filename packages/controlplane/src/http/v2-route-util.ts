// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Helpers the v2 route modules share: read a JSON body and turn an error into its response.
import { writeError, statusForStoreError, errorMessage } from "./handlers.js";

export async function readJSON(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function fail(err: unknown): Response {
  return writeError(statusForStoreError(err), errorMessage(err));
}
