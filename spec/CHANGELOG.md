# Neutral Build Output spec changelog

## 1.0.0 (unreleased until tagged)

Decisions and reasons: `docs/adr/0007-spec-1-0.md`. The spec: `docs/nbo-spec.md`.

### Changes from the draft of 2026-10-22

- **File shape.** The manifest points to split files (`routes.json`, `static.index.json`, `prerender.json`, one `function.json` and `bundle.index.json` per function) by digest. Function folders hold `function.json` and `bundle/`, with `bundle.index.json` inside `bundle/`.
- **Reserved names.** Draft features nothing implemented are rejected by the 1.0 schemas and kept for later minors: runtime kinds `edge`, `container`, `python`; `concurrency: "single"`; function fields `group`, `platform`, `placement`, `scaling`, `env`, `bindings`; route actions `transform` and rewrite `url`; conditions `has` and `missing`; static `variants`; `cleanUrls: false`, `caseSensitive: false`; non-UTC cron zones; headers `x-nbo-request-id`, `forwarded`, `x-nbo-geo-*`.
- **Removed capability ids.** `route.middleware` and `cron` are reserved; the ids a 1.0 writer can require are an enumerated set.
- **Canonical JSON.** Every JSON file in `.nbo/` is RFC 8785 canonical, so a digest of the bytes equals a digest of the parsed file.
- **New validate checks.** Spec version first; canonical JSON; `prerender.json` digest present or absent with the file; every file under `bundle/` listed and a regular file; references between files (functions, seeds, 404 file); cron grammar; `x-` extension keys declared; `\u{...}` and other JS-only regex escapes refused. `manifest.digests` must name `static.index.json`, `routes.json` and every `function.json` (every reference writer always has). Three things are warnings (errors with `--strict`): a static key under `/_nbo/`, an unlisted root `dispatch.json`, a duplicate prerender id.
- **Version check.** `specVersion` is `"MAJOR.MINOR"`, read from `spec/version.json` (`@nbo/spec/version.json`). A consumer accepts its own major and a minor not newer than its own.
- **`dispatch.json` in the digest.** The reference writer now lists `dispatch.json` in `bundle.index.json`, so the content id covers every byte a function runs.
- **`minimumCacheTTLSec` fix.** `nbo serve` read `minimumCacheTtlSec`, a different spelling from the manifest's, so resized images never got the configured lifetime. It reads the manifest's name. An `images` block without widths, qualities or a lifetime now answers cleanly (`400` for an unlisted width or quality, TTL 0) instead of throwing.
- **next/image default.** With no `images.localPatterns` in `next.config`, the Next.js producer wrote `localPatterns: []`, so `nbo serve` refused every local image with `400`; Next allows every local path then. The producer now writes `[{ "pathname": "^/.*$" }]`, a pattern without `pathname` means any path, and `nbo serve` treats an absent or empty `localPatterns` as every local path, so stored builds behave as Next does too.
- **Plan notes.** An adapter may attach a note to a capability it plans; the plan shows it and it never fails the plan. The Kubernetes and Cloud Run adapters have none today: their deploys run the ISR cache and set the revalidation token.
- **Production ISR.** Deploys run one ISR cache per app and give each environment a generated revalidation token (`NBO_PRERENDER_BYPASS`). Cache keys start with the content id, a slow or failing cache reads as a miss, and the edge fans `POST /_nbo/revalidate` out to every backend of a host (`204`, the shared status with an empty body, or `502` with a per-backend list; always `x-nbo-edge-fanout` and `cache-control: no-store`; `413` over 64 KiB, `400` for an unreadable body, the unknown-host `404` for a host with no backends).
- **Remote image sources.** `nbo serve` follows at most 3 redirects for a remote image, checks each target against `remotePatterns` and every address its hostname resolves to (loopback, private, link-local, CGNAT, unspecified, multicast, reserved, benchmarking and unique-local ranges are refused, IPv4 inside IPv6 and 6to4 included), connects to the address it checked, and requires an `image/*` answer. Refusals are `502` with no detail in the body.
- **`x-nbo-edge-backend` value.** The header carries the backend's stable id (the environment id) instead of its URL, and is absent for a backend without an id. The edge's `502` for an unreachable backend says `edge: backend unreachable`, a relay's says `relay: upstream unreachable`, and the revalidation fan-out lists a backend without an id as `null`; the detail goes to the log.
- **Next.js draft-mode keys in the determinism rule.** Inside a container Next makes new draft-mode keys on every build and has no setting to supply them, so two builds of one commit may also differ in those keys (`.next/server/preview-props.json` and the `preview` object of `.next/prerender-manifest.json` in a function bundle, plus the `bundle.index.json`, `function.json` and manifest digest they move). The server-actions key must be supplied (`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`) for builds to match.
- **Other behaviour made explicit.** Middleware headers, revalidation answers (`400` for an array body), platform behaviour (`/_nbo/` paths, carried files, deployment id), determinism rule, producers' limits, and the conformance transcripts in `packages/conformance/transcripts/spec-1.0/`.

### Upgrade note

The first new build of each project with functions deploys once: its content id differs from the live one because `dispatch.json` is now in the digest, even when the code did not change. Builds already stored keep their content ids and keep validating and promoting (validate accepts exactly one unlisted `dispatch.json` at a bundle root). Next.js builds also get a new content id once, because their `images` block now carries `localPatterns: [{ "pathname": "^/.*$" }]` instead of `[]` (and `^.*$` for a pattern without `pathname`). Static and SPA builds do not change. After rolling NBO back, builds made by a newer NBO can't be promoted; rebuild them.

### For producers

- Write `specVersion` from `spec/version.json`, never a newer value than you implement.
- Write every JSON file in canonical form (the reference writer does).
- Declare every `x-` key you use in `requires.extensions`.
- List every file under `bundle/` in `bundle.index.json`, `dispatch.json` included.
- Run `nbo validate --strict` on a fresh build in your tests.

### For consumers

- Refuse a manifest whose minor is newer than yours ("upgrade NBO") and any other major; still run the other checks.
- Accept an old build's unlisted `dispatch.json` at a bundle root (non-strict only).
- Upgrade consumers before producers.

### Known limits

- The Node major that ran the build is part of the content id (`runtime.version` is `>=<major>`), so a different Node gives a different id.
- Next.js builds of one commit may differ in build-time rendered pages (seed files and `x-nbo-ppr.postponedState`); the rule and the CI check are in the spec's Determinism section.
- The Next.js producer refuses the edge runtime, the Pages Router, dynamic route segments, middleware matchers with `has` or `missing`, and prerenders with `revalidate: false`; it ignores `next.config` redirects, rewrites and headers.
- Production ISR has no persistent cache: a restarted cache starts empty and pages render again on demand. Tracked in `docs/points-to-improve-or-fix.md` item 17.
- A middleware's own extra `x-nbo-*` response headers reach the visitor (same item).
