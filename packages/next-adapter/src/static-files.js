// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// toStaticEntry maps one outputs.staticFiles entry to the {pathname, cache}
// @nbo/writer's addStatic needs.
//
// Next 16.4.2 has a real bug on Windows: pathname for files under
// `_next/static/` comes back with literal backslashes as path separators
// (e.g. "/_next/static/\\<hash>\\_buildManifest.js" instead of
// "/_next/static/<hash>/_buildManifest.js") — a URL path must never
// contain a raw backslash, so this normalizes before using it as a
// static.index.json key. The same bug corrupts Next's own immutableHash
// detection for exactly these entries (it comes back undefined), so this
// doesn't rely on immutableHash alone: per docs/nbo-spec.md's Producer
// rules, anything under /_next/static/ is unconditionally immutable
// (Next's own hashed build-output convention), independent of whether
// immutableHash survived Next's bug.
export function toStaticEntry(f) {
  const pathname = f.pathname.replace(/\\/g, "/").replace(/\/+/g, "/");
  const cache = pathname.startsWith("/_next/static/") || f.immutableHash ? "immutable" : "revalidate";
  return { pathname, cache };
}
