// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { RE2 } from "re2";
import { normalizePath, type TrailingSlashPolicy } from "./normalize.js";
import type { Action, Rule, RoutesDoc, ErrorTarget, PrerenderRoute } from "./rule.js";
import { compileMatch, substitute, hasJsOnlyEscape, type CompiledMatch } from "./match.js";

const maxRewrites = 8;

export type DecisionKind =
  "notFound" | "serve" | "redirect" | "respond" | "loopDetected" | "function" | "middlewareHandled" | "prerender";

export interface HeaderOp {
  set?: Record<string, string>;
  append?: Record<string, string>;
  delete?: string[];
}

export interface Decision {
  kind: DecisionKind;
  staticPath?: string;
  redirectLocation?: string;
  redirectStatus?: number;
  respondStatus?: number;
  respondFile?: string;
  headerOps?: HeaderOp[];
  functionName?: string;
  // functionPath is the path the request should be treated as being
  // for by the time it reaches functionName — ordinarily just the
  // original request path, but a rewrite (from middleware, or a plain
  // beforeFiles/afterFiles rewrite.path rule) can change the path
  // *before* a later phase's rule dispatches it to a function, and
  // the function's own routing has no other way to learn that.
  functionPath?: string;
  middlewareStatus?: number;
  middlewareHeaders?: Record<string, string[]>;
  middlewareBody?: Buffer;
  prerenderRoute?: PrerenderRoute;
  // prerenderPath is the path prerenderRoute matched, the prerender
  // counterpart of functionPath: after a rewrite it isn't the path the
  // visitor asked for, and the seed, the cache key and the function all
  // belong to this one.
  prerenderPath?: string;
}

export type StaticExists = (path: string) => boolean;

// MiddlewareOutcome is what a host's middleware invocation reports
// back to the router, translated from the function's own response per
// the Middleware wire protocol (docs/nbo-spec.md's Middleware section).
export interface MiddlewareOutcome {
  continue: boolean;
  rewritePath?: string;
  mergeHeaders?: HeaderOp[];
  response?: Decision;
}

// Returns either synchronously or as a Promise: internal/serve's own
// real invoker (packages/serve's middleware.ts) needs real async I/O
// — cloning/reading the request's body, calling an async function
// handler, racing a timeout — none of which Go's own goroutine-
// blocking equivalent required a synchronous-looking function
// signature to express. A plain synchronous stub (as every one of
// this package's own tests already uses) still satisfies this type
// unchanged; route() below awaits whatever comes back either way.
export type MiddlewareInvoker = (
  functionName: string,
  path: string,
  method: string,
) => MiddlewareOutcome | Promise<MiddlewareOutcome>;

export interface CompiledRule {
  id: string;
  compiled: CompiledMatch;
  action: Action;
  continue: boolean;
}

interface CompiledPrerender {
  route: PrerenderRoute;
  compiled: InstanceType<typeof RE2>;
}

// Router is built incrementally across this plan's own tasks: this
// task populates everything except `route`, which Task 6 adds via a
// second `interface Router` declaration in the same file — TypeScript
// merges declarations of the same interface name, so this task's own
// object literal only has to satisfy the shape as it stands here.
export interface Router {
  beforeFiles: CompiledRule[];
  afterFiles: CompiledRule[];
  fallback: CompiledRule[];
  onMatch: CompiledRule[];
  errorDoc: Record<string, ErrorTarget>;
  trailingSlash: TrailingSlashPolicy;
  prerenders: CompiledPrerender[];
}

// Task 6's own addition to the Router interface, merged with the
// declaration above (same interface name, same module) — see that
// declaration's own comment for why this is split across tasks.
export interface Router {
  route(
    reqPath: string,
    reqMethod: string,
    staticExists: StaticExists,
    invokeMiddleware: MiddlewareInvoker,
  ): Promise<Decision>;
}

// compileRules validates and compiles one phase's own rule list — port
// of router.go's own compileRules (lines 116-148).
function compileRules(rules: Rule[] | undefined): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const r of rules ?? []) {
    switch (r.action.type) {
      case "redirect":
      case "respond":
      case "rewrite":
      case "headers":
        // supported this slice
        break;
      case "middleware":
        if (!r.action.function) {
          throw new Error(`rule "${r.id}": middleware needs function`);
        }
        break;
      default:
        throw new Error(`rule "${r.id}": action type "${r.action.type}" is not supported by this router version`);
    }
    if (r.action.type === "rewrite") {
      if (r.action.function) {
        // supported this slice
      } else if (r.action.path) {
        // supported since Slice 1
      } else if (r.action.url) {
        throw new Error(
          `rule "${r.id}": rewrite to an external url is not supported by this router version (Slice 4 scope cut)`,
        );
      } else {
        throw new Error(`rule "${r.id}": rewrite needs path, function, or url`);
      }
    }
    let compiled: CompiledMatch;
    try {
      compiled = compileMatch(r.match);
    } catch (err) {
      throw new Error(`rule "${r.id}": ${(err as Error).message}`, { cause: err });
    }
    out.push({ id: r.id, compiled, action: r.action, continue: r.continue ?? false });
  }
  return out;
}

// createRouter compiles every phase's rules and every prerender
// pattern up front — port of router.go's own New construction half
// (lines 150-173; the Route method itself is Task 6).
export function createRouter(doc: RoutesDoc, trailingSlash: TrailingSlashPolicy): Router {
  const prerenders: CompiledPrerender[] = [];
  for (const p of doc.prerenders ?? []) {
    if (hasJsOnlyEscape(p.matchPath)) {
      throw new Error(
        `prerender "${p.id}": match "${p.matchPath}" does not compile as RE2: uses a JS-only escape (\\C, \\c, or \\u) Go's regexp.Compile does not accept`,
      );
    }
    let compiled: InstanceType<typeof RE2>;
    try {
      compiled = new RE2(p.matchPath);
    } catch (err) {
      throw new Error(
        `prerender "${p.id}": match "${p.matchPath}" does not compile as RE2: ${(err as Error).message}`,
        { cause: err },
      );
    }
    prerenders.push({ route: p, compiled });
  }

  const rt: Router = {
    beforeFiles: compileRules(doc.beforeFiles),
    afterFiles: compileRules(doc.afterFiles),
    fallback: compileRules(doc.fallback),
    onMatch: compileRules(doc.onMatch),
    errorDoc: doc.error ?? {},
    trailingSlash,
    prerenders,
    async route(
      reqPath: string,
      reqMethod: string,
      staticExists: StaticExists,
      invokeMiddleware: MiddlewareInvoker,
    ): Promise<Decision> {
      return routeRequest(rt, reqPath, reqMethod, staticExists, invokeMiddleware);
    },
  };
  return rt;
}

type PhaseOutcome = "none" | "final" | "rewrite";

interface RunPhaseResult {
  outcome: PhaseOutcome;
  decision: Decision | null;
  target: string;
}

// runPhase scans rules, in order, against one path. It returns on the
// first rule that matches and either ends routing (redirect/respond),
// stacks a header op and ends this phase's scan (headers without
// continue), or fires a rewrite (the caller checks the target against
// the filesystem — runPhase itself never re-enters with the new
// path). Header ops from rules with continue: true are appended as
// the scan goes on, so several can stack before a phase ends.
//
// seenHeaderRule is a dedupe set, shared across every runPhase call
// made during one route() request (including retries of the same
// phase on a rewrite miss — see drivePhase). A rule only ever
// contributes one HeaderOp per request: without this, a headers rule
// with continue: true that matches again on a retried path (fallback
// rewriting to a new path that the same rule also matches) would
// append its op a second time, duplicating any append values.
//
// It is keyed by the CompiledRule object itself (reference identity
// in the Set) — rule ids are author-supplied strings with no
// uniqueness requirement in spec/routes.schema.json (not even non-
// empty), so two unrelated rules in different phases (or an empty id
// on both) can share one. Keying by id would silently drop the
// second rule's header op whenever that happened, with no error.
// Keying by the rule's own object reference is collision-proof
// regardless of what any rule's id contains — port of router.go's own
// *compiledRule-pointer-keyed map (lines 193-264).
async function runPhase(
  rules: CompiledRule[],
  path: string,
  method: string,
  headerOps: HeaderOp[],
  seenHeaderRule: Set<CompiledRule>,
  invokeMiddleware: MiddlewareInvoker,
): Promise<RunPhaseResult> {
  for (const rule of rules) {
    const { ok, groups } = rule.compiled.test(path, method);
    if (!ok) continue;

    switch (rule.action.type) {
      case "redirect":
        return {
          outcome: "final",
          decision: {
            kind: "redirect",
            redirectLocation: substitute(rule.action.location ?? "", groups),
            redirectStatus: rule.action.status,
          },
          target: "",
        };
      case "respond":
        return {
          outcome: "final",
          decision: { kind: "respond", respondStatus: rule.action.status, respondFile: rule.action.file },
          target: "",
        };
      case "headers":
        if (!seenHeaderRule.has(rule)) {
          headerOps.push({ set: rule.action.set, append: rule.action.append, delete: rule.action.delete });
          seenHeaderRule.add(rule);
        }
        if (!rule.continue) {
          return { outcome: "none", decision: null, target: "" };
        }
        break;
      case "rewrite":
        if (rule.action.function) {
          return {
            outcome: "final",
            decision: { kind: "function", functionName: rule.action.function, functionPath: path },
            target: "",
          };
        }
        return { outcome: "rewrite", decision: null, target: substitute(rule.action.path ?? "", groups) };
      case "middleware": {
        const outcome = await invokeMiddleware(rule.action.function ?? "", path, method);
        if (!outcome.continue) {
          // outcome.response already carries every header the
          // middleware set (minus the reserved x-nbo-* names)
          // directly on middlewareHeaders — mergeHeaders is not
          // consulted here, or its contents would be applied twice.
          return { outcome: "final", decision: outcome.response ?? { kind: "notFound" }, target: "" };
        }
        // Continuing (plain next, or a rewrite): nothing downstream
        // carries the middleware's own response headers (e.g. a
        // cookie it set) except the headerOps accumulator, so merge
        // them in unconditionally — an empty mergeHeaders is a
        // correct, harmless no-op.
        headerOps.push(...(outcome.mergeHeaders ?? []));
        if (outcome.rewritePath) {
          return { outcome: "rewrite", decision: null, target: outcome.rewritePath };
        }
        // x-nbo-next: keep scanning this same phase's remaining
        // rules against the unchanged path.
        break;
      }
    }
  }
  return { outcome: "none", decision: null, target: "" };
}

interface DrivePhaseResult {
  done: boolean;
  decision: Decision | null;
  path: string;
}

// matchPrerender is the prerender decision for path, if one of the
// build's prerender routes matches it.
function matchPrerender(prerenders: CompiledPrerender[], path: string): Decision | undefined {
  for (const p of prerenders) {
    if (p.compiled.test(path)) return { kind: "prerender", prerenderRoute: p.route, prerenderPath: path };
  }
  return undefined;
}

// drivePhase scans rules against path and, on a rewrite, checks the
// rewritten target against the prerender routes and the filesystem
// immediately: a hit ends routing with that route, or with Serve. On a
// miss, the behavior depends on retryOnMiss:
//
//   - false (beforeFiles, afterFiles): advance to the caller's next
//     phase with the rewritten path. These phases are never re-
//     scanned against their own rewrite's target — "earlier phases
//     are never re-run against the rewritten path" carries forward to
//     mean a phase doesn't re-run itself either; the pipeline only
//     moves forward.
//   - true (fallback, the last phase — there is no phase after it to
//     advance to): re-scan these same rules against the rewritten
//     path, so one fallback rule can hand off to another. This stops
//     the moment a rewrite is a no-op — its target equals the path
//     that produced it, which can only reproduce the same state
//     forever if retried — and otherwise relies on the shared rewrite
//     counter to report loopDetected once the cap is exceeded.
//
// rewrites is shared across all three phase calls in route(), so the
// 8-rewrite cap is a total across the whole request, not per-phase —
// port of router.go's own drivePhase (lines 266-314).
export async function drivePhase(
  rules: CompiledRule[],
  path: string,
  method: string,
  headerOps: HeaderOp[],
  seenHeaderRule: Set<CompiledRule>,
  rewrites: { count: number },
  staticExists: StaticExists,
  retryOnMiss: boolean,
  invokeMiddleware: MiddlewareInvoker,
  trailingSlash: TrailingSlashPolicy,
  prerenders: CompiledPrerender[] = [],
): Promise<DrivePhaseResult> {
  for (;;) {
    const { outcome, decision, target } = await runPhase(
      rules,
      path,
      method,
      headerOps,
      seenHeaderRule,
      invokeMiddleware,
    );
    if (outcome === "final") {
      return { done: true, decision, path };
    }
    if (outcome === "rewrite") {
      rewrites.count++;
      if (rewrites.count > maxRewrites) {
        return { done: true, decision: { kind: "loopDetected" }, path };
      }
      const next = normalizePath(target, trailingSlash);
      // Prerender routes go before the filesystem here too: a seed is also
      // a static file, and served as one it skips the cache, and for PPR
      // it is a shell nothing ever finishes.
      const prerender = matchPrerender(prerenders, next);
      if (prerender) {
        return { done: true, decision: prerender, path: next };
      }
      if (staticExists(next)) {
        return { done: true, decision: { kind: "serve", staticPath: next }, path: next };
      }
      if (!retryOnMiss || next === path) {
        return { done: false, decision: null, path: next };
      }
      path = next;
      continue;
    }
    // outcome === "none": no rule in this phase matched at all.
    return { done: false, decision: null, path };
  }
}

// routeRequest is the body behind every Router's own route() method —
// port of router.go's own Route (lines 316-400).
async function routeRequest(
  rt: Router,
  reqPath: string,
  reqMethod: string,
  staticExists: StaticExists,
  invokeMiddleware: MiddlewareInvoker,
): Promise<Decision> {
  // Single normalization point: every match test, every staticExists
  // call, and every rewrite target below operates on this one
  // normalized string (rewrite targets get re-normalized after
  // substitution too, inside drivePhase). Redirect location values
  // are the one exception: they are emitted to the client as-is and
  // never normalized, since nothing looks them up.
  let path = normalizePath(reqPath, rt.trailingSlash);
  const rewrites = { count: 0 };
  const headerOps: HeaderOp[] = [];
  // seenHeaderRule is shared for the whole request (every phase call
  // below, plus the onMatch run in finalize), so a headers rule that
  // matches again — whether on a later phase or a retried path within
  // the same phase — contributes its HeaderOp only once.
  const seenHeaderRule = new Set<CompiledRule>();

  const finalize = async (dec: Decision): Promise<Decision> => {
    dec.headerOps = [...(dec.headerOps ?? []), ...headerOps];
    // This router version deliberately does not run onMatch for a
    // Function decision: a function's own response headers are not
    // yet subject to onMatch header rules.
    if (dec.kind === "serve") {
      await runPhase(rt.onMatch, path, reqMethod, dec.headerOps, seenHeaderRule, invokeMiddleware);
    }
    return dec;
  };

  // beforeFiles: redirects/respond end routing outright; a rewrite's
  // miss advances to the implicit filesystem check below using the
  // rewritten path.
  let driven = await drivePhase(
    rt.beforeFiles,
    path,
    reqMethod,
    headerOps,
    seenHeaderRule,
    rewrites,
    staticExists,
    false,
    invokeMiddleware,
    rt.trailingSlash,
    rt.prerenders,
  );
  path = driven.path;
  if (driven.done) {
    if (driven.decision!.kind === "loopDetected") return driven.decision!;
    return finalize(driven.decision!);
  }

  // Prerender routes are checked before the implicit filesystem phase
  // (docs/nbo-spec.md:251 — "after checking prerender routes first, so
  // seeded ISR pages never bypass their cache"): a seed is an ordinary
  // static.index.json entry, and without this check a request for it
  // would hit the plain static Serve path below and never reach the
  // cache's own fresh/stale/expired state machine.
  const prerender = matchPrerender(rt.prerenders, path);
  if (prerender) return finalize(prerender);

  // The implicit filesystem phase: runs exactly once, right after
  // beforeFiles, whether or not beforeFiles rewrote the path.
  if (staticExists(path)) {
    return finalize({ kind: "serve", staticPath: path });
  }

  // afterFiles: same single-attempt-then-advance rule as beforeFiles.
  driven = await drivePhase(
    rt.afterFiles,
    path,
    reqMethod,
    headerOps,
    seenHeaderRule,
    rewrites,
    staticExists,
    false,
    invokeMiddleware,
    rt.trailingSlash,
    rt.prerenders,
  );
  path = driven.path;
  if (driven.done) {
    if (driven.decision!.kind === "loopDetected") return driven.decision!;
    return finalize(driven.decision!);
  }

  // fallback: the last phase, so a rewrite miss here retries fallback
  // itself (see drivePhase) rather than advancing to a phase that
  // doesn't exist.
  driven = await drivePhase(
    rt.fallback,
    path,
    reqMethod,
    headerOps,
    seenHeaderRule,
    rewrites,
    staticExists,
    true,
    invokeMiddleware,
    rt.trailingSlash,
    rt.prerenders,
  );
  path = driven.path;
  if (driven.done) {
    if (driven.decision!.kind === "loopDetected") return driven.decision!;
    return finalize(driven.decision!);
  }
  return finalize({ kind: "notFound" });
}
