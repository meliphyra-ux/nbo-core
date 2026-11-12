// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Copied verbatim from adapters/k8s/templates/Dockerfile.tmpl and
// Dockerfile.function.tmpl — neither has a {{.Field}} of its own, so
// these are plain constants, no interpolation needed.

// node:24-slim, not FROM scratch: once cmd/nbo is Node source, the
// deployed app needs a real Node runtime plus its own node_modules
// (sharp, re2's native bindings) — confirmed directly that Node's own
// single-executable-application feature cannot embed a native addon
// (ERR_UNKNOWN_BUILTIN_MODULE on require("sharp")), so there is no
// scratch-compatible alternative.
//
// Ruling (Task 11): node:24-slim does NOT ship a CA certificate
// bundle — confirmed directly (a bare `node:24-slim` container has no
// /etc/ssl/certs at all), contradicting this plan's own original
// assumption that its Debian-slim base included one. The old `FROM
// scratch` Dockerfile needed a separate Alpine builder stage for this
// exact reason; node:24-slim is itself Debian, so the fix is simpler
// — install the distro's own ca-certificates package directly, no
// second stage needed. Cost if wrong: every outbound HTTPS call from
// inside a deployed app (a remote image fetch, the ISR cache service)
// would fail with an unknown-CA error — caught here by this file's
// own "includes CA certificates for outbound HTTPS" test against a
// real build, not assumed.
// Ruling (final review, finding C2): re2's own install script
// compiles/fetches a platform-specific native binary at install time
// (not a prebuilt optional-dependency package pnpm's --os/--cpu/--libc
// flags can redirect, unlike sharp) - confirmed directly: the cli
// deploy dir's own re2.node is still the HOST's binary (Windows) even
// after a Linux-targeted "pnpm deploy". Re-running its install script
// here, inside the real target container, is the fix - confirmed
// directly against a real deploy output. Guarded by "if": a fixture
// with no re2 in it at all (every image.test.ts fixture before a real
// deploy-dir test exists) has nothing for find to match, and must not
// fail the build over that.
//
// Layer order: Docker reuses a cached layer only while every
// instruction before it is unchanged, so the CLI bundle (identical
// across deploys of the same platform version) and re2's native
// rebuild come first, and the per-deploy inputs (.nbo/, the baked
// function URLs and env) come last — otherwise every deploy recompiles
// re2. templates.test.ts asserts this order.
//
// cliImagePrefix is the part shared with the ISR cache image (Ruling R1):
// the base image, CA certificates, the CLI bundle under /app/cli and
// re2's in-container rebuild, which `nbo isrcache` needs too (its
// static imports reach re2 through serve and the router).
const cliImagePrefix = `FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY cli /app/cli
WORKDIR /app/cli
RUN re2_pkg="$(find . -path '*/node_modules/re2/package.json' | head -1)"; \\
    if [ -n "$re2_pkg" ]; then \\
      re2_dir="$(dirname "$re2_pkg")"; \\
      rm -rf "$re2_dir/build"; \\
      (cd "$re2_dir" && npm run install); \\
    fi
`;

export const appDockerfile = `${cliImagePrefix}COPY app /app/app
COPY carry /app/carry
COPY functions.json /functions.json
COPY env.json /env.json
ENTRYPOINT ["node", "dist/main.js", "serve", "/app/app", "--port", "8080", "--carry", "/app/carry"]
`;

// renderIsrcacheDockerfile is the ISR cache image's Dockerfile: the app
// image's CLI prefix as-is (so its build context puts the bundle under
// cli/, as buildImage does), then the cache's listen address and
// entrypoint. It has no per-deploy inputs: its tag (isrcacheImageTag)
// changes only when NBO's code or this text does.
export function renderIsrcacheDockerfile(): string {
  return `${cliImagePrefix}ENV NBO_ISRCACHE_ADDR=:8080
ENTRYPOINT ["node", "dist/main.js", "isrcache"]
`;
}

// Already cache-friendly: the shared host comes first, the function's
// own files after it.
export const functionDockerfile = `FROM node:24-slim
COPY host.mjs /app/host.mjs
COPY bundle /app/bundle
COPY function.json /app/function.json
COPY env.json /app/env.json
# cwd must be the bundle dir itself, not /app: Next's own bundled runtime
# does cwd-relative lookups (e.g. .next/routes-manifest.json) assuming it
# IS the project root, exactly like funcproxy.NewLocalSpawner's cmd.Dir =
# bundleDir for the same reason locally.
WORKDIR /app/bundle
ENTRYPOINT ["node", "/app/host.mjs", "/app/bundle"]
`;
