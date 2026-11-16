// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

const ALPHABET = /^[A-Za-z0-9_-]*$/;

/** base64url without padding. */
export const b64u = {
  encode(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(s: string): Uint8Array {
    if (!ALPHABET.test(s) || s.length % 4 === 1) throw new TypeError("not base64url");
    const std = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(std);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};
