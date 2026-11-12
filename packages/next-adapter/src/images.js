// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// nextPatternToRe2 converts one Next.js wildcard pattern (as used by
// remotePatterns/localPatterns' own hostname/pathname fields — "Single
// `*` matches a single path segment. Double `**` matches any number of
// path segments", confirmed against the real, installed
// next/dist/shared/lib/image-config.d.ts) into an anchored RE2 string,
// since spec/manifest.schema.json's own images.remotePatterns/
// localPatterns fields are RE2 patterns, not Next's own wildcard
// syntax. separator is "." for a hostname (a single "*" stops at a
// subdomain boundary) or "/" for a pathname (stops at a path segment
// boundary).
const DOUBLE_STAR_PLACEHOLDER = "\u0000DOUBLE_STAR\u0000";

export function nextPatternToRe2(pattern, separator) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const withPlaceholder = escaped.replace(/\*\*/g, DOUBLE_STAR_PLACEHOLDER);
  const singleStarClass = separator === "." ? "[^.]*" : "[^/]*";
  const withSingleStars = withPlaceholder.replace(/\*/g, singleStarClass);
  const final = withSingleStars.split(DOUBLE_STAR_PLACEHOLDER).join(".*");
  return `^${final}$`;
}

// A pattern without a pathname matches any path: Next reads it as "**".
function translateRemotePattern(p) {
  return {
    protocol: p.protocol,
    hostname: nextPatternToRe2(p.hostname, "."),
    pathname: nextPatternToRe2(p.pathname ?? "**", "/"),
  };
}

function translateLocalPattern(p) {
  return { pathname: nextPatternToRe2(p.pathname ?? "**", "/") };
}

// translateLocalPatterns follows Next: an unset localPatterns allows every
// local path, written as one pattern for any path (so a reader needs no
// default). Next's explicit [] allows none; it is written as a pattern that
// no local path matches, because an empty list means "any local path" to
// readers of builds this producer made before spec 1.0 final (it wrote []
// for an unset list).
const ANY_LOCAL_PATH = { pathname: "^/.*$" };
const NO_LOCAL_PATH = { pathname: "^$" };

function translateLocalPatterns(list) {
  if (list === undefined || list === null) return [ANY_LOCAL_PATH];
  if (list.length === 0) return [NO_LOCAL_PATH];
  return list.map(translateLocalPattern);
}

// fromNextImages translates Next's own next.config.ts images block
// (ImageConfigComplete, confirmed against the real, installed
// next/dist/shared/lib/image-config.d.ts) into manifest.json's own
// images shape (spec/manifest.schema.json).
export function fromNextImages(config) {
  const widths = [...new Set([...config.deviceSizes, ...config.imageSizes])].sort((a, b) => a - b);
  return {
    widths,
    formats: config.formats,
    qualities: config.qualities,
    remotePatterns: (config.remotePatterns ?? []).map(translateRemotePattern),
    localPatterns: translateLocalPatterns(config.localPatterns),
    minimumCacheTTLSec: config.minimumCacheTTL,
    allowSvg: config.dangerouslyAllowSVG,
  };
}
