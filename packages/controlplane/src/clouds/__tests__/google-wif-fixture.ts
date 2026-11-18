// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Shared by the keyless (workload identity federation) tests: a core whose
// Google identity id is pinned, so a fixed connection code names it.
import { generateKeyPairSync } from "node:crypto";
import type { Store } from "../../store/store.js";

export const FIXTURE_ID = "0123456789abcdef";
export const FIXTURE_PROVIDER = `core-${FIXTURE_ID}`;
export const FIXTURE_ISSUER = `https://core-${FIXTURE_ID}.nbo.invalid`;

// The code the setup command prints for project acme (number 123456789012)
// and the core above: Python's json.dumps spacing, base64url, no padding.
// The dashboard's setup-script test holds the same literal.
export const FIXTURE_CODE =
  "nbo-gcp1.eyJwcm9qZWN0IjogImFjbWUiLCAicHJvamVjdE51bWJlciI6ICIxMjM0NTY3ODkwMTIiLCAicG9vbCI6ICJuYm8tY29yZXMiLCAicHJvdmlkZXIiOiAiY29yZS0wMTIzNDU2Nzg5YWJjZGVmIiwgInNlcnZpY2VBY2NvdW50IjogIm5iby1kZXBsb3llckBhY21lLmlhbS5nc2VydmljZWFjY291bnQuY29tIiwgImlzc3VlciI6ICJodHRwczovL2NvcmUtMDEyMzQ1Njc4OWFiY2RlZi5uYm8uaW52YWxpZCJ9";

// pinIdentity gives the store the fixture's Google identity id (with a
// fresh key), as googleIdentity would have made it.
export function pinIdentity(store: Store): void {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  store.setServerSecret("google_identity_key", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  store.setGoogleIdentityId(FIXTURE_ID);
}

// saveWifConnection stores a keyless connection to project p, as
// connectWithWif saves it.
export function saveWifConnection(store: Store, project = "p", region = "us-east1", pullerKey = "{}"): void {
  pinIdentity(store);
  store.saveGoogleConnection(
    {
      project,
      region,
      arRepo: `${region}-docker.pkg.dev/${project}/nbo`,
      deployer: `nbo-deployer@${project}.iam.gserviceaccount.com`,
      puller: `nbo-puller@${project}.iam.gserviceaccount.com`,
      auth: "wif",
      projectNumber: "123456789012",
      pool: "nbo-cores",
      provider: FIXTURE_PROVIDER,
    },
    { deployerKey: "", pullerKey },
  );
}
