// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { RE2 } from "re2";

interface RouteRule {
  id?: string;
  match?: { path?: string; pathNot?: string };
}

const PHASES = ["beforeFiles", "afterFiles", "fallback", "onMatch"] as const;

// jsOnlyEscape matches escape sequences node-re2 accepts (it translates
// JS-style regex syntax before handing the pattern to the real RE2 engine)
// that Go's regexp.Compile, and so other RE2 routers, reject: \C (any single
// byte), \c<letter> (control character), \uXXXX and \u{...} (JS unicode
// escapes; RE2 spells them \x{...}). Same rule as the router's
// hasJsOnlyEscape (packages/router/src/match.ts): only an odd run of
// backslashes makes the escape real, so "\\C" (an escaped backslash, then C)
// is accepted.
const jsOnlyEscape = /(\\+)(C|c[A-Za-z]|u[0-9A-Fa-f]{4}|u\{[0-9A-Fa-f]+\})/g;

function hasJsOnlyEscape(pattern: string): boolean {
  for (const m of pattern.matchAll(jsOnlyEscape)) {
    if (m[1]!.length % 2 === 1) return true;
  }
  return false;
}

// re2Problem returns why pattern doesn't compile as RE2, or undefined.
function re2Problem(pattern: string): string | undefined {
  if (hasJsOnlyEscape(pattern))
    return "uses a JS-only escape (\\C, \\c, \\u or \\u{...}) other RE2 routers do not accept";
  try {
    new RE2(pattern);
  } catch (err) {
    return (err as Error).message;
  }
  return undefined;
}

// checkRoutePatterns compiles every match.path/match.pathNot in every
// phase, and every prerender.json match, as RE2, reporting any pattern that doesn't compile — port of
// validate.go's own inline check (lines 322-349). RE2 rejects
// lookaheads/backreferences the same way Go's own regexp.Compile does,
// which this project's "route patterns are RE2 only" rule depends on.
export function checkRoutePatterns(routesDoc: unknown, prerenderDoc?: unknown): Error[] {
  const errs: Error[] = [];
  const configs = (prerenderDoc as { prerenders?: unknown } | null | undefined)?.prerenders;
  if (Array.isArray(configs)) {
    for (const config of configs as ({ id?: unknown; match?: unknown } | null)[]) {
      if (!config || typeof config.match !== "string") continue;
      const problem = re2Problem(config.match);
      if (problem)
        errs.push(
          new Error(
            `prerender.json: prerender "${String(config.id ?? "")}": match "${config.match}" does not compile as RE2: ${problem}`,
          ),
        );
    }
  }
  const routes = routesDoc as Record<string, RouteRule[] | undefined> | null;
  if (!routes) return errs;

  for (const phase of PHASES) {
    const rules = routes[phase];
    if (!rules) continue;
    for (const rule of rules) {
      if (!rule) continue;
      for (const field of ["path", "pathNot"] as const) {
        const pattern = rule.match?.[field];
        if (typeof pattern !== "string") continue;
        const problem = re2Problem(pattern);
        if (problem)
          errs.push(
            new Error(
              `routes.json: rule "${rule.id ?? ""}": ${field} "${pattern}" does not compile as RE2: ${problem}`,
            ),
          );
      }
    }
  }
  return errs;
}
