// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { RE2 } from "re2";
import type { Match, Condition } from "./rule.js";

export type { Match, Condition };

type RE2Instance = InstanceType<typeof RE2>;

// hasJsOnlyEscape detects \C, \c<letter>, \u<hex> and \u{hex} escapes
// that re2 (the npm package) accepts — it translates JS-style regex
// syntax before compiling — but Go's own regexp.Compile rejects
// outright, confirmed directly via `go run`. Parity-aware: only an
// ODD number of immediately-preceding backslashes makes the escape
// "real" (the last backslash is unescaped and active); an even
// count means every backslash is itself escaped by its own pair, so
// what follows is an ordinary literal character, not a special
// escape — e.g. "\\C" (two real backslash characters then C) is
// valid, unambiguous RE2 syntax Go accepts, not the \C escape.
// @nbo/validate's own equivalent guard (checkRoutePatterns, added in
// that sub-project's own final review) has exactly this bug — it
// matches on backslash presence without checking parity, so it
// wrongly rejects "\\C" too. Not shared with that package's own copy
// in this fix (see this plan's own final-review ledger entry) — each
// is its own small, now-correct implementation.
const jsOnlyEscape = /(\\+)(C|c[A-Za-z]|u[0-9A-Fa-f]{4}|u\{[0-9A-Fa-f]+\})/g;

export function hasJsOnlyEscape(pattern: string): boolean {
  for (const m of pattern.matchAll(jsOnlyEscape)) {
    if (m[1]!.length % 2 === 1) return true;
  }
  return false;
}

export interface CompiledMatch {
  test(path: string, method: string): { ok: boolean; groups: Record<string, string> };
}

export function compileMatch(m: Match): CompiledMatch {
  if ((m.has && m.has.length > 0) || (m.missing && m.missing.length > 0)) {
    throw new Error("match: has/missing conditions are not supported in this router version (Slice 1 scope cut)");
  }
  if (hasJsOnlyEscape(m.path)) {
    throw new Error(
      `match: path "${m.path}" does not compile as RE2: uses a JS-only escape (\\C, \\c, or \\u) Go's regexp.Compile does not accept`,
    );
  }
  let path: RE2Instance;
  try {
    path = new RE2(m.path);
  } catch (err) {
    throw new Error(`match: path "${m.path}" does not compile as RE2: ${(err as Error).message}`, { cause: err });
  }
  let pathNot: RE2Instance | undefined;
  if (m.pathNot) {
    if (hasJsOnlyEscape(m.pathNot)) {
      throw new Error(
        `match: pathNot "${m.pathNot}" does not compile as RE2: uses a JS-only escape (\\C, \\c, or \\u) Go's regexp.Compile does not accept`,
      );
    }
    try {
      pathNot = new RE2(m.pathNot);
    } catch (err) {
      throw new Error(`match: pathNot "${m.pathNot}" does not compile as RE2: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
  const methods = m.methods && m.methods.length > 0 ? new Set(m.methods.map((meth) => meth.toUpperCase())) : undefined;

  return {
    test(testPath: string, method: string) {
      if (methods && !methods.has(method.toUpperCase())) {
        return { ok: false, groups: {} };
      }
      if (pathNot && pathNot.test(testPath)) {
        return { ok: false, groups: {} };
      }
      const m2 = path.exec(testPath);
      if (!m2) {
        return { ok: false, groups: {} };
      }
      // Object.create(null): a plain {} has Object.prototype's own
      // members (constructor, toString, …) as *inherited*
      // properties, so `"constructor" in groups` is true even when
      // no such group was ever assigned, and bracket-assigning the
      // key "__proto__" onto a plain object tries to set the
      // prototype rather than create an own property — silently
      // dropping a group literally named __proto__. A null-prototype
      // object has neither problem.
      const groups: Record<string, string> = Object.create(null);
      // Numbered groups first (skip index 0, the whole match) —
      // mirrors Go's own loop over sub/SubexpNames, split into two
      // simpler passes here since re2's own match result already
      // separates numbered (array) from named (.groups) access.
      for (let i = 1; i < m2.length; i++) {
        groups[String(i)] = m2[i] ?? "";
      }
      if (m2.groups) {
        for (const [name, val] of Object.entries(m2.groups)) {
          groups[name] = val ?? "";
        }
      }
      return { ok: true, groups };
    },
  };
}

const substituteToken = /\$([A-Za-z_][A-Za-z0-9_]*|\d+)/g;

export function substitute(template: string, groups: Record<string, string>): string {
  return template.replace(substituteToken, (tok, key: string) => {
    // Object.hasOwn, not `in`: defensive even if a future caller
    // passes a plain {} rather than compileMatch's own null-prototype
    // groups object — `in` resolving an *inherited* Object.prototype
    // member (constructor, toString, …) as if it were a real group
    // is exactly the bug the groups-side fix above closes at the
    // source; this closes it at every call site too.
    return Object.hasOwn(groups, key) ? groups[key]! : tok;
  });
}
