# ADR 0002: `fallback`-only rewrite retry, with a no-op short-circuit

- Status: Accepted
- Date: 2026-10-22

## Context

Slice 1 Task 2 (`router/`, the six-phase routing engine) implements "a
rewrite to a path re-enters `filesystem` with the new path" and the
8-rewrite loop cap from `docs/nbo-spec.md`'s Routing section. The
task's planning brief proposed a specific reading: a path-target
rewrite, wherever it fires, re-checks the filesystem on its new path
immediately; on a miss, routing continues from the phase _after_ the
one the rewrite fired in, never re-running an earlier phase.

Taken completely literally — one rewrite attempt per phase, then
advance forward, with a `fallback`-phase miss falling straight to
`NotFound` since there is no phase after `fallback` — this means each
of the three rewrite-capable phases (`beforeFiles`, `afterFiles`,
`fallback`) can fire at most one rewrite per request, for a hard
ceiling of 3 rewrites total. The documented 8-rewrite cap (`508 Loop
Detected`) would then be unreachable dead code: no input could ever
drive the counter past 3. The task's own conformance test
(`TestRoute_RewriteLoopStopsAtEightWithLoopDetected`, two rules in
`fallback` that rewrite into each other, `/a` ↔ `/b`) requires the
cap to actually trip, so the literal reading cannot be what was
needed, and something had to change.

## Decision

Only `fallback` retries itself on a rewrite miss. `beforeFiles` and
`afterFiles` keep the single-attempt-then-advance behavior exactly as
originally planned: one rewrite attempt, and on a miss the pipeline
moves forward to the next phase using the rewritten path, never
re-scanning the phase that just ran.

`fallback`, having no phase after it, instead re-scans its own rule
list against the rewritten path when a rewrite misses — letting one
`fallback` rule hand off to another — but only while the rewrite is
making progress. The moment a rewrite's target equals the path that
produced it (a fixed point: re-matching the same rule(s) against an
unchanged path can only reproduce the same state forever), the retry
stops immediately and the request ends in a clean `404`, without
consuming the rewrite budget further. A genuine cycle between two or
more _different_ paths does not hit that fixed-point check and is
instead caught by the rewrite counter, which is a single value shared
across all three phases for the whole request (not reset per phase):
once it would exceed 8, routing ends immediately with `508 Loop
Detected`, before any further rule evaluation, header accumulation, or
`onMatch` run.

## Why

- **Applying retry-on-miss to every phase was rejected.** `beforeFiles`
  and `afterFiles` would then revisit paths the spec describes them as
  seeing only once — "earlier phases are never re-run against the
  rewritten path" would stop meaning anything if a phase could also
  re-run _itself_ an unbounded number of times before advancing. It
  would also make those two phases' behavior depend on rule ordering
  within the phase in a way nothing in the spec anticipates (a
  `beforeFiles` redirect rule and a `beforeFiles` rewrite rule could
  end up interleaved across retries). Restricting the retry to
  `fallback` keeps `beforeFiles`/`afterFiles` exactly as planned and
  confines the new behavior to the one phase whose own documentation
  already describes it as the catch-all, last-chance phase.
- **Never retrying `fallback` at all was rejected.** It makes the
  documented 8-rewrite cap literally unreachable (see Context), which
  would mean the spec's own "After 8 rewrites the router stops with
  `508 Loop Detected`" sentence describes behavior the implementation
  can never exhibit — a correctness gap worse than the one this
  decision accepts.
- **The no-op short-circuit is necessary, not optional.** Without it, a
  single always-matching `fallback` rule that rewrites unconditionally
  to a fixed path (a common real shape — e.g. `path: "^/", pathNot:
"\\.[A-Za-z0-9]+$"` rewriting to `/` for an SPA) would, on a miss,
  retry itself, match again, produce the identical target again, and
  keep doing so until it burned through the entire 8-rewrite budget —
  turning an ordinary "that file doesn't exist" 404 into a `508` that
  looks like a routing bug. Stopping the instant a rewrite reproduces
  its own input keeps that case a normal 404 while still letting a
  genuine multi-rule `fallback` chain, or a genuine cycle between
  different paths, use the full 8-rewrite budget before `508` kicks
  in.

## Consequences

- Task 3 (`internal/serve`, not started yet) inherits this behavior
  directly from `router.Route`: a `fallback`-phase rewrite loop that
  keeps producing new paths is indistinguishable, from the caller's
  side, from the `beforeFiles`/`afterFiles` case until it either
  serves, 404s, or trips the cap — callers do not need their own
  retry or cycle-detection logic.
- `docs/nbo-spec.md`'s Routing section was updated in the same change
  (Slice 1 Task 2, commit `fe8d601` and the follow-up fix) to describe
  this `fallback`-retry-with-no-op-short-circuit behavior explicitly,
  rather than the flatly-unreachable literal reading described in
  Context.
- If a future slice needs `beforeFiles` or `afterFiles` to compose
  multiple rewrite rules the way `fallback` now does, that is a new,
  separate decision — this ADR deliberately scopes the retry to
  `fallback` only and does not pre-approve extending it.
