// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import {
  type KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import type { Store } from "../store/store.js";

export interface Jwk {
  kty: "RSA";
  alg: "RS256";
  kid: string;
  use: "sig";
  n: string;
  e: string;
}

export interface GoogleIdentity {
  id: string;
  issuer: string;
  subject: string;
  provider: string;
  keyId: string;
  jwks: { keys: Jwk[] };
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

// The core's Google identity: made once, kept sealed in server_settings
// (the id and the private key), and independent of the platform link.
function ensure(store: Store): { id: string; privateKeyPem: string } {
  const id = store.getGoogleIdentityId();
  const pem = store.getServerSecret("google_identity_key");
  if (id !== undefined && pem !== undefined) return { id, privateKeyPem: pem };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fresh = randomBytes(8).toString("hex");
  store.setServerSecret("google_identity_key", privateKeyPem);
  store.setGoogleIdentityId(fresh);
  return { id: fresh, privateKeyPem };
}

function jwkOf(key: KeyObject): Jwk {
  const { n, e } = createPublicKey(key).export({ format: "jwk" }) as {
    n: string;
    e: string;
  };
  // RFC 7638: required members only, in lexicographic order.
  const kid = createHash("sha256").update(`{"e":"${e}","kty":"RSA","n":"${n}"}`).digest("base64url");
  return { kty: "RSA", alg: "RS256", kid, use: "sig", n, e };
}

export function googleIdentity(store: Store): GoogleIdentity {
  const { id, privateKeyPem } = ensure(store);
  return identityOf(id, jwkOf(createPrivateKey(privateKeyPem)));
}

function identityOf(id: string, jwk: Jwk): GoogleIdentity {
  return {
    id,
    issuer: `https://core-${id}.nbo.invalid`,
    subject: `core-${id}`,
    provider: `core-${id}`,
    keyId: jwk.kid,
    jwks: { keys: [jwk] },
  };
}

export function googleAudience(projectNumber: string, provider: string): string {
  return `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/nbo-cores/providers/${provider}`;
}

// signGoogleToken: an RS256 JWT for Google's token exchange. iat is backdated
// 60 s (Google rejects a future iat, so a fast clock still works); exp is 1 h.
export function signGoogleToken(store: Store, audience: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const { id, privateKeyPem } = ensure(store);
  const key = createPrivateKey(privateKeyPem);
  const identity = identityOf(id, jwkOf(key));
  const header = b64url(JSON.stringify({ alg: "RS256", kid: identity.keyId, typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: identity.issuer,
      sub: identity.subject,
      aud: audience,
      iat: nowSec - 60,
      exp: nowSec + 3600,
    }),
  );
  const input = `${header}.${claims}`;
  const sig = sign("RSA-SHA256", Buffer.from(input), key);
  return `${input}.${b64url(sig)}`;
}
