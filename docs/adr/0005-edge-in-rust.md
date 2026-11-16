# 0005: The edge is written in Rust

Date: 2026-11-08. Status: accepted, pending the gate below (the maintainer asked for the rewrite; the remaining calls are Claude's, listed in the spec).

## Context

Every visitor request to every site passes through the edge. The TypeScript edge (`packages/edge`) runs on Node.js: each request is turned into a Fetch `Request`, sent on with `undici`, and turned back. `fetch` decompresses the backend's gzip or brotli answer, so visitors get uncompressed bytes. One Node process uses one core, and garbage collection adds latency spikes.

## Decision

`packages/edge-rs` is a Cargo crate building one binary, `nbo-edge`, with the same modes, environment variables, ports, admin API, route table, headers and behaviour as the TypeScript edge. It is the second exception to the TypeScript rule, after the Terraform provider (ADR 0004). It has no `package.json`, so pnpm and turbo ignore it, and `.dockerignore` keeps its `target/` out of images. `rust-toolchain.toml` pins Rust 1.96.0 and `Cargo.toml` pins every dependency to an exact version, with `Cargo.lock` committed.

Parity is proven two ways. Golden vectors written by the TypeScript code (`packages/edge/scripts/golden.ts` into `packages/edge-rs/tests/golden`) are the Rust unit tests for sticky picks, histogram buckets, route normalisation and tag insertion. A black-box Vitest suite in `packages/edge` runs against whichever binary `NBO_EDGE_BIN` names, and both edges must pass it.

Matching Node bit for bit needed one thing beyond a straight port: `Math.log` in V8 is fdlibm's `log`, and the platform `ln` (the Windows CRT, glibc) rounds the last bit differently on some inputs. At a histogram bucket edge that bit decides the bucket (290 of the 2,500 golden values moved). `src/jsmath.rs` carries fdlibm's `log` translated line by line, used for buckets and sticky scores, so results don't depend on the platform's math library.

The TypeScript package stays as a library (the control-plane imports its histogram, route and tag helpers) and as an in-process fake edge for tests. Only its `main.ts` binary role ends, once the gate holds.

## Gate

The Rust edge becomes the default only when the black-box suite passes against both edges, the Slice 3 load test shows zero failed requests across a weight shift, a one-core benchmark shows at least 3 times the Node edge's requests per second at a 99th percentile no worse, and it has served a page over HTTPS in a real cluster. Until then `NBO_EDGE_IMPL=ts` keeps the Node image.

## Measurements

Taken 2026-11-08, when the Rust edge was built.

**Gate 2, the Slice 3 load test:** `scripts/verify-slice3-loadtest.sh` with `NBO_EDGE_BIN` set to the Rust release binary passed with zero failed requests (50 requests/s, 10 s per phase, 1%, 10%, 50%, 100% toward the second backend: 321, 323, 323 and 317 requests, all answered, every split honoured). It ran with `NBO_LOADTEST_SECOND=kubernetes`: the second backend was a second copy of `next-app` on the local kind cluster instead of Cloud Run, since no cloud account is used for tests. The edge does the same work either way (an HTTPS backend with its own certificate check off).

**Gate 3, the benchmark.**

- Machine: AMD Ryzen 7 7800X3D (8 cores, 16 threads), 31 GB, Windows 11, Node 24.14.1, Rust 1.96 release build.
- One CPU each: each edge process ran pinned to logical CPU 2 (`ProcessorAffinity = 0x4`), with its twin hyperthread (CPU 3) left idle. The fake backend and the load generator ran on CPUs 4 to 15. The edge's CPU time per 35 s run (34 s or so when it had the core to itself) confirms the edge, not the generator, was the limit.
- Dev mode, one target with one plain-HTTP backend, Speed Insights off. A fresh edge process for every run.
- Backend and load generator: a small Go program written for this (`edgebench`, standard library only, not in the repository). The backend answers `ok` (2 bytes) or a 100 KB body with `content-length`. The generator is closed-loop HTTP/1.1 with keep-alive: 64 or 256 connections, one request in flight on each, 5 s warm-up, then 30 s measured. A request counts only when it got a 200 with the full body; no request failed in any run.
- Three runs per case, edges alternating (Node, Rust, Node, ...). The table shows medians; "Runs" lists each run's requests per second. Peak memory is the process's peak working set.

| Backend | Connections | Edge | Requests/s | p50 ms | p99 ms | Peak memory | Runs (requests/s)      |
| ------- | ----------- | ---- | ---------- | ------ | ------ | ----------- | ---------------------- |
| 2 bytes | 64          | Node | 3,196      | 11.5   | 117.0  | 355 MB      | 3,196, 2,562, 4,334    |
| 2 bytes | 64          | Rust | 19,043     | 2.5    | 22.6   | 14 MB       | 20,143, 10,353, 19,043 |
| 2 bytes | 256         | Node | 3,981      | 51.7   | 199.2  | 388 MB      | 3,232, 3,981, 4,169    |
| 2 bytes | 256         | Rust | 13,274     | 17.0   | 63.5   | 28 MB       | 13,274, 7,096, 18,638  |
| 100 KB  | 64          | Node | 2,735      | 18.4   | 49.1   | 216 MB      | 2,735, 2,724, 2,754    |
| 100 KB  | 64          | Rust | 13,325     | 4.0    | 33.5   | 22 MB       | 13,223, 13,336, 13,325 |
| 100 KB  | 256         | Node | 2,248      | 112.4  | 173.6  | 316 MB      | 2,322, 2,248, 1,920    |
| 100 KB  | 256         | Rust | 9,429      | 25.5   | 65.2   | 58 MB       | 9,878, 9,429, 7,664    |

Ratios of the medians, Rust over Node: 6.0x, 3.3x, 4.9x and 4.2x the requests per second, with a lower 99th percentile in all four cases. The gate's "at least 3x at a p99 no worse" holds on medians.

How much to trust it: the machine was not quiet. Other programs used about 60% of the CPU during the runs, and Windows scheduled some of them on the edge's core, so the 2-byte runs vary a lot (the edge got as little as 20 s of CPU in a 35 s run; one Rust run at 256 connections had a p99 of 207 ms against Node's 199 ms in its neighbouring run). The 100 KB runs at 64 connections, where the edge kept its core, vary by under 1% on both edges; at 256 connections one run of each edge was slowed the same way. A short earlier check on the same setup (5 s runs, 64 connections) gave Node 4,000 to 6,000 and Rust 26,500 to 28,500 requests per second for the 2-byte answer. Latencies cluster near whole milliseconds, which looks like Windows' timer granularity and affects both edges alike. A Linux run with `taskset` on a quiet machine would give cleaner numbers; nothing here suggests the ratio would fall under 3x.

## Cost

A third toolchain. `pnpm test` doesn't run the crate's tests: use `cargo test` (and `cargo clippy -- -D warnings`) in `packages/edge-rs`. The registry and admin parsing exist twice, kept equal by the golden vectors and the black-box suite, so a change to the route table, admin API or headers must be made in both. A few Node quirks are copied on purpose (JavaScript's whitespace set for `trim`, latin1 header text, the URL parser's host rules through the `url` crate), and a few known differences remain on input no real caller sends: the detail of an invalid-JSON error, weights beyond the `i64` range (refused), and JavaScript's habit of putting integer-like object keys first (which only changes which of several errors a route table reports).
