// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export { createRouter } from "./router.js";
export type {
  Router,
  CompiledRule,
  Decision,
  DecisionKind,
  HeaderOp,
  MiddlewareOutcome,
  MiddlewareInvoker,
  StaticExists,
} from "./router.js";
export { normalizePath } from "./normalize.js";
export { hasJsOnlyEscape } from "./match.js";
export type { TrailingSlashPolicy } from "./normalize.js";
export type { Match, Condition, Action, Rule, RoutesDoc, PrerenderRoute, ErrorTarget } from "./rule.js";
