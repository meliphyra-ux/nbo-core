// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export interface Action {
  type: string;
  location?: string;
  status?: number;
  file?: string;
  function?: string;
  path?: string;
  url?: string;
  set?: Record<string, string>;
  append?: Record<string, string>;
  delete?: string[];
}

export interface Condition {
  type: string;
  key: string;
  eq?: string;
  neq?: string;
  inc?: string;
  pre?: string;
  suf?: string;
  re?: string;
}

export interface Match {
  path: string;
  pathNot?: string;
  methods?: string[];
  has?: Condition[];
  missing?: Condition[];
}

export interface Rule {
  id: string;
  match: Match;
  action: Action;
  continue?: boolean;
}

export interface ErrorTarget {
  file?: string;
  function?: string;
}

// PrerenderRoute is the subset of a prerender.json config the router
// needs to recognize a prerender-managed path and hand it off — the
// fresh/stale/expired state machine, onMiss policy, and cache-key
// settings live entirely in internal/serve's own (not yet ported)
// equivalent, which already knows how to call a function; the router
// only matches and names which route won.
export interface PrerenderRoute {
  id: string;
  matchPath: string;
  functionName: string;
}

export interface RoutesDoc {
  version: number;
  beforeFiles?: Rule[];
  afterFiles?: Rule[];
  fallback?: Rule[];
  onMatch?: Rule[];
  error?: Record<string, ErrorTarget>;
  prerenders?: PrerenderRoute[];
}
