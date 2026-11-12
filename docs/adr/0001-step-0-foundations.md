# ADR 0001: Step 0 foundations — switch semantics, target order, language split

- Status: Accepted
- Date: 2026-10-22

## Context

Three decisions block any code in Step 0 (the first build step). Each had a
proposed default from the original planning conversation (docs/context.md).
The owner accepted all three defaults as proposed, unchanged, on 2026-10-22.

## Decision 1: what "switch" means in v1

A target is a per-environment setting (e.g. production → Kubernetes,
staging → Cloud Run). Moving a project means running a planned migration
workflow (provision → deploy → health-check → shift traffic → drain →
decommission, Slice 3) that ends with one environment pointed at the new
target. There is no live active-active serving of the same environment
from two clouds at once in v1.

## Decision 2: MVP target order

Kubernetes (any IaaS) first, as the portable baseline. Cloud Run second,
as the first native-serverless adapter. AWS Lambda third, as the stress
test for the spec (payload limits, no streaming by default, event shim).
Spec 1.0 is tagged only once the Next.js suite passes on all three
(Slice 5).

## Decision 3: language split

TypeScript for framework-facing code: `packages/writer`,
`packages/producer-static`, `packages/next-adapter`. Go for
platform-facing code: `router/`, `cmd/nbo`, `adapters/k8s`, and later the
control plane. Rationale: producers live next to framework build tools,
which are all Node-based; the router, CLI and adapters want one fast,
single-binary, easily-cross-compiled runtime with a standard library RE2
regex engine (`regexp`) that matches the spec's routing rule directly.

## Consequences

- Two toolchains in one repo: pnpm workspaces for TS, a root `go.mod` for
  Go. CI must run both.
- `spec/` JSON Schemas are the shared contract; TS and Go types are both
  generated from them (quicktype), never hand-duplicated.
- `cmd/nbo validate` and `cmd/nbo serve` are Go from Step 0 onward — no
  temporary TypeScript CLI to migrate away from later.
