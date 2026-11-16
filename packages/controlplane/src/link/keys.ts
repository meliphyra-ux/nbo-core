// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  exportPublicKey,
  exportPrivateKey,
} from "@nbo/link-protocol";

export interface LinkKeys {
  identityPublic: string;
  identityPkcs8: string;
  encryptionPublic: string;
  encryptionPkcs8: string;
}

// createLinkKeys makes core's identity (signing) pair and its encryption pair.
// Both are extractable so the private halves can be exported once and sealed
// in the database; nothing else keeps them.
export async function createLinkKeys(): Promise<LinkKeys> {
  const identity = await generateSigningKeyPair(true);
  const encryption = await generateEncryptionKeyPair(true);
  return {
    identityPublic: await exportPublicKey(identity.publicKey),
    identityPkcs8: await exportPrivateKey(identity.privateKey),
    encryptionPublic: await exportPublicKey(encryption.publicKey),
    encryptionPkcs8: await exportPrivateKey(encryption.privateKey),
  };
}
