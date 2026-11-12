// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { caBundle, createRelayCa } from "../relay-ca.js";

describe("createRelayCa", () => {
  it("issues a 5-year server certificate for every address, signed by a 5-year CA", async () => {
    const now = new Date("2026-11-04T00:00:00Z");
    const r = await createRelayCa(["35.9.9.9", "2600:1900::1", "relay.example.com"], now);
    const ca = new X509Certificate(r.caPem);
    const cert = new X509Certificate(r.certPem);

    expect(ca.ca).toBe(true);
    expect(cert.ca).toBe(false);
    expect(cert.checkIssued(ca)).toBe(true);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(ca.verify(ca.publicKey)).toBe(true);

    const fiveYears = new Date("2031-11-04T00:00:00Z").getTime();
    for (const c of [ca, cert]) {
      expect(new Date(c.validFrom).getTime()).toBeLessThanOrEqual(now.getTime());
      expect(Math.abs(new Date(c.validTo).getTime() - fiveYears)).toBeLessThan(2 * 86_400_000);
    }

    expect(cert.checkIP("35.9.9.9")).toBe("35.9.9.9");
    expect(cert.checkIP("2600:1900::1")).toBeDefined();
    expect(cert.checkHost("relay.example.com")).toBe("relay.example.com");
    expect(cert.checkHost("other.example.com")).toBeUndefined();
    expect(cert.subjectAltName).toContain("IP Address:35.9.9.9");
    expect(cert.subjectAltName).toContain("DNS:relay.example.com");

    // P-256 keys, and each private key matches its certificate.
    expect(ca.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    const pub = (pem: string) => createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" });
    expect(pub(r.keyPem).equals(cert.publicKey.export({ type: "spki", format: "der" }))).toBe(true);
    expect(pub(r.caKeyPem).equals(ca.publicKey.export({ type: "spki", format: "der" }))).toBe(true);
  });

  it("refuses an empty address list", async () => {
    await expect(createRelayCa([])).rejects.toThrow(/address/);
  });
});

describe("a rotation bundle (old CA + new CA)", () => {
  it("lets a TLS client trust a relay serving either certificate", async () => {
    const { createServer } = await import("node:tls");
    const { connect } = await import("node:tls");
    const oldCa = await createRelayCa(["127.0.0.1"]);
    const newCa = await createRelayCa(["127.0.0.1"]);
    // Same join as the installer (a PEM may lack its final newline).
    const bundle = caBundle(oldCa.caPem, newCa.caPem);
    const handshake = async (served: { certPem: string; keyPem: string }, ca: string): Promise<boolean> => {
      const server = createServer({ cert: served.certPem, key: served.keyPem }, (s) => s.end());
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as { port: number }).port;
      try {
        return await new Promise<boolean>((resolve) => {
          const sock = connect({ host: "127.0.0.1", port, ca }, () => {
            sock.destroy();
            resolve(true);
          });
          sock.on("error", () => resolve(false));
        });
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    };
    expect(await handshake(oldCa, bundle)).toBe(true);
    expect(await handshake(newCa, bundle)).toBe(true);
    expect(await handshake(newCa, oldCa.caPem)).toBe(false);
  });
});
