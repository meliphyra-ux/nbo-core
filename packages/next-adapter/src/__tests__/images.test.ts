// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { describe, it, expect } from "vitest";
import { fromNextImages } from "../images.js";

function baseConfig(overrides = {}) {
  return {
    deviceSizes: [640, 750],
    imageSizes: [32, 48],
    formats: ["image/webp"],
    qualities: [75],
    remotePatterns: [],
    localPatterns: undefined,
    minimumCacheTTL: 14400,
    dangerouslyAllowSVG: false,
    ...overrides,
  };
}

describe("fromNextImages", () => {
  it("merges deviceSizes and imageSizes into one deduped, sorted widths array", () => {
    const images = fromNextImages(baseConfig({ deviceSizes: [750, 640], imageSizes: [48, 32, 640] }));
    expect(images.widths).toEqual([32, 48, 640, 750]);
  });

  it("passes qualities and formats straight through", () => {
    const images = fromNextImages(baseConfig({ qualities: [50, 75], formats: ["image/avif", "image/webp"] }));
    expect(images.qualities).toEqual([50, 75]);
    expect(images.formats).toEqual(["image/avif", "image/webp"]);
  });

  it("maps minimumCacheTTL to minimumCacheTTLSec and dangerouslyAllowSVG to allowSvg", () => {
    const images = fromNextImages(baseConfig({ minimumCacheTTL: 3600, dangerouslyAllowSVG: true }));
    expect(images.minimumCacheTTLSec).toBe(3600);
    expect(images.allowSvg).toBe(true);
  });

  it("writes an absent localPatterns as any local path (Next's default) and an absent remotePatterns as none", () => {
    const images = fromNextImages(baseConfig({ localPatterns: undefined, remotePatterns: undefined }));
    expect(images.localPatterns).toEqual([{ pathname: "^/.*$" }]);
    expect(images.remotePatterns).toEqual([]);
  });

  it("writes Next's explicit empty localPatterns (no local image allowed) as a pattern that matches no path", () => {
    const images = fromNextImages(baseConfig({ localPatterns: [] }));
    expect(images.localPatterns).toEqual([{ pathname: "^$" }]);
  });

  it("writes a pattern with no pathname as any path, as Next reads it", () => {
    const images = fromNextImages(
      baseConfig({
        localPatterns: [{ search: "" }],
        remotePatterns: [{ protocol: "https", hostname: "cdn.acme.com" }],
      }),
    );
    expect(images.localPatterns).toEqual([{ pathname: "^.*$" }]);
    expect(images.remotePatterns).toEqual([{ protocol: "https", hostname: "^cdn\\.acme\\.com$", pathname: "^.*$" }]);
  });

  it("anchors a literal remote hostname/pathname with every regex metacharacter escaped", () => {
    const images = fromNextImages(
      baseConfig({ remotePatterns: [{ protocol: "https", hostname: "cdn.acme.com", pathname: "/media/photo.jpg" }] }),
    );
    expect(images.remotePatterns).toEqual([
      { protocol: "https", hostname: "^cdn\\.acme\\.com$", pathname: "^/media/photo\\.jpg$" },
    ]);
  });

  it("converts a single * into a single-segment wildcard that doesn't cross the separator", () => {
    const images = fromNextImages(
      baseConfig({ remotePatterns: [{ protocol: "https", hostname: "*.acme.com", pathname: "/media/*" }] }),
    );
    expect(images.remotePatterns).toEqual([
      { protocol: "https", hostname: "^[^.]*\\.acme\\.com$", pathname: "^/media/[^/]*$" },
    ]);
  });

  it("converts a double ** into a cross-segment wildcard", () => {
    const images = fromNextImages(
      baseConfig({ remotePatterns: [{ protocol: "https", hostname: "**.acme.com", pathname: "/media/**" }] }),
    );
    expect(images.remotePatterns).toEqual([
      { protocol: "https", hostname: "^.*\\.acme\\.com$", pathname: "^/media/.*$" },
    ]);
  });

  it("drops port and search — not part of the target schema", () => {
    const images = fromNextImages(
      baseConfig({
        remotePatterns: [{ protocol: "https", hostname: "acme.com", port: "8080", pathname: "/x", search: "?v=1" }],
      }),
    );
    expect(images.remotePatterns).toEqual([{ protocol: "https", hostname: "^acme\\.com$", pathname: "^/x$" }]);
  });

  it("converts localPatterns the same way, with no protocol field", () => {
    const images = fromNextImages(baseConfig({ localPatterns: [{ pathname: "/assets/**" }] }));
    expect(images.localPatterns).toEqual([{ pathname: "^/assets/.*$" }]);
  });
});
