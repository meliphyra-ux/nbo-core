// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

const PHASES = ["beforeFiles", "afterFiles", "fallback", "onMatch"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// checkReferences checks that every name one file uses exists where it
// points: rewrite and middleware rules in every phase and every
// prerender name a function in manifest.functions; the 404 error page
// and every prerender seed's file are static.index.json keys. Cron
// targets are checked by checkCrons. A file that could not be read is
// left out (its read error is already reported), and so are the checks
// against it.
export function checkReferences(input: { manifest: unknown; routes?: unknown; staticIndex?: unknown; prerender?: unknown }): Error[] {
  const errs: Error[] = [];
  const manifest = isObject(input.manifest) ? input.manifest : undefined;
  const functions = Array.isArray(manifest?.functions) ? new Set(manifest.functions.filter((f): f is string => typeof f === "string")) : undefined;
  const staticFiles = isObject(input.staticIndex) && isObject(input.staticIndex.files) ? input.staticIndex.files : undefined;
  const isStaticKey = (key: string) => staticFiles !== undefined && Object.prototype.hasOwnProperty.call(staticFiles, key);

  const routes = isObject(input.routes) ? input.routes : undefined;
  if (routes) {
    for (const phase of PHASES) {
      const rules = routes[phase];
      if (!Array.isArray(rules)) continue;
      for (const rule of rules) {
        if (!isObject(rule) || !isObject(rule.action)) continue;
        const fn = rule.action.function;
        if (functions && typeof fn === "string" && !functions.has(fn)) {
          errs.push(new Error(`routes.json: rule "${String(rule.id ?? "")}": function "${fn}" is not declared in manifest functions`));
        }
      }
    }
    const error = isObject(routes.error) ? routes.error : undefined;
    const notFound = error && isObject(error["404"]) ? error["404"] : undefined;
    if (staticFiles && notFound && typeof notFound.file === "string" && !isStaticKey(notFound.file)) {
      errs.push(new Error(`routes.json: error "404": file "${notFound.file}" is not a static.index.json key`));
    }
  }

  const prerender = isObject(input.prerender) ? input.prerender : undefined;
  if (prerender && Array.isArray(prerender.prerenders)) {
    for (const config of prerender.prerenders) {
      if (!isObject(config)) continue;
      const id = String(config.id ?? "");
      if (functions && typeof config.function === "string" && !functions.has(config.function)) {
        errs.push(new Error(`prerender.json: prerender "${id}": function "${config.function}" is not declared in manifest functions`));
      }
      if (staticFiles && isObject(config.seeds)) {
        for (const [seedKey, seed] of Object.entries(config.seeds)) {
          if (!isObject(seed) || typeof seed.file !== "string") continue;
          if (!isStaticKey(seed.file)) {
            errs.push(new Error(`prerender.json: prerender "${id}": seed "${seedKey}": file "${seed.file}" is not a static.index.json key`));
          }
        }
      }
    }
  }
  return errs;
}
