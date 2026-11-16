// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { createSecureContext, type SecureContext } from "node:tls";
import { normalizeHost, type Registry } from "./registry.js";

// CertStore holds one TLS context per Kubernetes Secret name. A host finds
// its certificate through its target's `tls` name in the registry.
export interface CertStore {
  set(secretName: string, certPem: string, keyPem: string): void;
  remove(secretName: string): void;
  contextFor(host: string, registry: Registry): SecureContext | undefined;
}

export function createCertStore(): CertStore {
  const contexts = new Map<string, SecureContext>();
  return {
    set(secretName, certPem, keyPem) {
      try {
        contexts.set(secretName, createSecureContext({ cert: certPem, key: keyPem }));
      } catch (err) {
        // A bad pair never takes the edge down; the host just has no certificate.
        console.error(
          `edge: certificate ${JSON.stringify(secretName)} skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
        contexts.delete(secretName);
      }
    },
    remove(secretName) {
      contexts.delete(secretName);
    },
    contextFor(host, registry) {
      const name = registry.get(normalizeHost(host))?.tls;
      return name === undefined ? undefined : contexts.get(name);
    },
  };
}

// ChallengeStore maps ACME HTTP-01 tokens to key authorizations. A Map, so
// a token such as "__proto__" is only ever its own entry.
export type ChallengeStore = ReturnType<typeof createChallengeStore>;

export function createChallengeStore() {
  let challenges = new Map<string, string>();
  return {
    replace(c: Record<string, string>): void {
      challenges = new Map(Object.entries(c));
    },
    get(token: string): string | undefined {
      return challenges.get(token);
    },
  };
}
