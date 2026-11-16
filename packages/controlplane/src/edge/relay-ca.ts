// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The private CA of one relay (spec A4): the edge pins it to verify the
// relay, so no public CA or DNS name is involved. ECDSA P-256, CA and server
// certificate both valid 5 years (rotation is re-enabling the relay).
import { webcrypto, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const validityYears = 5;
// A little slack for clocks that run behind NBO's.
const backdateMs = 5 * 60_000;

const serial = (): string => {
  const b = randomBytes(16);
  b[0] = b[0]! & 0x7f; // positive
  return b.toString("hex");
};

async function keyPem(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", key as webcrypto.CryptoKey)).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

// caBundle joins PEM CAs for a rotation (the edge trusts every one of them);
// PEMs are put on lines of their own, whatever their trailing newline.
export function caBundle(...pems: string[]): string {
  return pems.map((p) => `${p.trim()}\n`).join("");
}

export async function createRelayCa(
  addresses: string[],
  now: Date = new Date(),
): Promise<{ caPem: string; caKeyPem: string; certPem: string; keyPem: string }> {
  const names = addresses.map((a) => a.replace(/^\[(.*)\]$/, "$1")).filter((a) => a !== "");
  if (names.length === 0) throw new Error("a relay certificate needs at least one address");
  const notBefore = new Date(now.getTime() - backdateMs);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + validityYears);

  const caSerial = serial();
  const caKeys = (await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: caSerial,
    // Unique per CA, so a rotation bundle never holds two CAs of one name.
    name: `CN=NBO relay CA ${caSerial.slice(0, 16)}`,
    notBefore,
    notAfter,
    signingAlgorithm: alg,
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });

  const keys = (await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: "CN=nbo-relay",
    issuer: ca.subject,
    notBefore,
    notAfter,
    signingAlgorithm: alg,
    publicKey: keys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(
        names.map((n) => (isIP(n) !== 0 ? { type: "ip" as const, value: n } : { type: "dns" as const, value: n })),
      ),
      await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });

  return {
    caPem: ca.toString("pem"),
    caKeyPem: await keyPem(caKeys.privateKey),
    certPem: cert.toString("pem"),
    keyPem: await keyPem(keys.privateKey),
  };
}
