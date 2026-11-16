// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Let's Encrypt client, HTTP-01 challenge store, certificate Secret writer and the edge probe.
import { X509Certificate } from "node:crypto";
import { request } from "node:http";
import * as acmeLib from "acme-client";
import type { ClientAutoOptions } from "acme-client";
import { redact, type CommandRunner } from "@nbo/deploy";
import type { Store } from "../store/store.js";
import { renderCertSecret } from "../edge/edge-manifests.js";
import { withEdgeCluster } from "../edge/edge-table.js";
import { errText } from "./cert-policy.js";

export interface AcmeClient {
  issue(
    host: string,
    onChallenge: (token: string, keyAuth: string) => Promise<void>,
    onCleanup: (token: string) => Promise<void>,
  ): Promise<{ certPem: string; keyPem: string; notAfter: string }>;
}

// AcmeLib is the slice of acme-client createAcmeClient uses (tests fake it).
export interface AcmeLib {
  directory: { production: string; staging: string };
  createPrivateKey(): Promise<Buffer>;
  createCsr(data: { commonName: string; altNames: string[] }): Promise<[Buffer, Buffer]>;
  createClient(opts: { directoryUrl: string; accountKey: string }): { auto(opts: ClientAutoOptions): Promise<string> };
}

const realAcmeLib: AcmeLib = {
  directory: acmeLib.directory.letsencrypt,
  createPrivateKey: () => acmeLib.crypto.createPrivateKey(),
  createCsr: (data) => acmeLib.crypto.createCsr(data),
  createClient: (opts) => new acmeLib.Client(opts),
};

// createAcmeClient: one Let's Encrypt account per NBO; its key is created
// on first use and kept sealed (platform secret acme_account_key).
export function createAcmeClient(store: Store, lib: AcmeLib = realAcmeLib): AcmeClient {
  let creatingKey: Promise<string> | null = null;
  const accountKey = (): Promise<string> => {
    const existing = store.getServerSecret("acme_account_key");
    if (existing) return Promise.resolve(existing);
    creatingKey ??= lib
      .createPrivateKey()
      .then((k) => {
        const pem = k.toString();
        store.setServerSecret("acme_account_key", pem);
        return pem;
      })
      .finally(() => {
        creatingKey = null;
      });
    return creatingKey;
  };
  return {
    async issue(host, onChallenge, onCleanup) {
      const settings = store.getServerSettings();
      const client = lib.createClient({
        directoryUrl: lib.directory[settings.acmeDirectory],
        accountKey: await accountKey(),
      });
      const [key, csr] = await lib.createCsr({ commonName: host, altNames: [host] });
      const certPem = await client.auto({
        csr,
        email: settings.acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ["http-01"],
        // The domain loop already proved the edge serves the answer
        // (through the edge's own address, as Let's Encrypt will see it).
        skipChallengeVerification: true,
        challengeCreateFn: async (_authz, challenge, keyAuthorization) =>
          onChallenge(challenge.token, keyAuthorization),
        challengeRemoveFn: async (_authz, challenge) => onCleanup(challenge.token),
      });
      return {
        certPem,
        keyPem: key.toString(),
        notAfter: new Date(new X509Certificate(certPem).validTo).toISOString(),
      };
    },
  };
}

// ChallengeStore holds the pending HTTP-01 answers every route table write
// publishes (wired as V2Options.edgeChallenges).
export interface ChallengeStore {
  set(token: string, keyAuth: string): void;
  delete(token: string): void;
  snapshot(): Record<string, string>;
}

export function createChallengeStore(): ChallengeStore {
  const m = new Map<string, string>();
  return {
    set: (t, k) => void m.set(t, k),
    delete: (t) => void m.delete(t),
    snapshot: () => Object.fromEntries(m),
  };
}

export interface CertWriter {
  writeCert(name: string, certPem: string, keyPem: string): Promise<void>;
  deleteCert(name: string): Promise<void>;
}

// createCertWriter writes (and deletes) a host's TLS Secret in nbo-edge of
// the edge cluster; the key never reaches an argument or an error message.
export function createCertWriter(deps: {
  store: Store;
  run: CommandRunner;
  kubeconfigFor: (clusterId: string) => Promise<string>;
}): CertWriter {
  return {
    async writeCert(name, certPem, keyPem) {
      try {
        await withEdgeCluster(deps, (kubectl) =>
          kubectl(["apply", "-f", "-"], renderCertSecret(name, certPem, keyPem)),
        );
      } catch (err) {
        // eslint-disable-next-line preserve-caught-error -- the cause may carry the private key; the message is redacted by hand
        throw new Error(`writing the certificate Secret ${name} failed: ${redact(errText(err), [keyPem])}`);
      }
    },
    async deleteCert(name) {
      await withEdgeCluster(deps, (kubectl) => kubectl(["delete", "secret", name, "--ignore-not-found"]));
    },
  };
}

// httpProbe asks the edge itself (its public address, port 80) for the
// challenge with the domain's Host, as Let's Encrypt will.
export function httpProbe(
  edgeAddress: () => string,
): (host: string, token: string, keyAuth: string) => Promise<boolean> {
  return (host, token, keyAuth) =>
    new Promise((resolve) => {
      const req = request(
        {
          host: edgeAddress().replace(/^\[(.*)\]$/, "$1"),
          port: 80,
          path: `/.well-known/acme-challenge/${token}`,
          headers: { host },
          timeout: 5_000,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            if (body.length < 4096) body += c;
          });
          res.on("end", () => resolve(res.statusCode === 200 && body === keyAuth));
          res.on("error", () => resolve(false));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => resolve(false));
      req.end();
    });
}
