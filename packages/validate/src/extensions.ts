// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

const PHASES = ["beforeFiles", "afterFiles", "fallback", "onMatch"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// extendable lists the objects in one metadata file that may carry
// x- extension keys, with a path naming each: the manifest root, the
// function.json root, every route rule, every prerender config and
// every static-index entry. The schemas accept any well-formed x- key
// there; this is the half that makes an undeclared one (a typo) fail.
function extendable(rel: string, doc: unknown): { path: string; obj: Record<string, unknown> }[] {
  if (!isObject(doc)) return [];
  if (rel === "manifest.json" || /^functions\/[^/]+\/function\.json$/.test(rel)) {
    return [{ path: "(root)", obj: doc }];
  }
  const out: { path: string; obj: Record<string, unknown> }[] = [];
  if (rel === "routes.json") {
    for (const phase of PHASES) {
      const rules = doc[phase];
      if (!Array.isArray(rules)) continue;
      rules.forEach((rule, i) => {
        if (isObject(rule)) out.push({ path: `${phase}[${i}]`, obj: rule });
      });
    }
  } else if (rel === "prerender.json") {
    const configs = doc.prerenders;
    if (Array.isArray(configs)) {
      configs.forEach((config, i) => {
        if (isObject(config)) out.push({ path: `prerenders[${i}]`, obj: config });
      });
    }
  } else if (rel === "static.index.json") {
    if (isObject(doc.files)) {
      for (const [key, entry] of Object.entries(doc.files)) {
        if (isObject(entry)) out.push({ path: `files[${JSON.stringify(key)}]`, obj: entry });
      }
    }
  }
  return out;
}

// checkExtensionKeys refuses every x- key on an extendable object whose
// name isn't an id in the manifest's requires.extensions.
export function checkExtensionKeys(docs: { rel: string; doc: unknown }[], declared: Set<string>): Error[] {
  const errs: Error[] = [];
  for (const { rel, doc } of docs) {
    for (const { path, obj } of extendable(rel, doc)) {
      for (const key of Object.keys(obj)) {
        if (key.startsWith("x-") && !declared.has(key)) {
          errs.push(new Error(`${rel}: ${path}: extension key "${key}" is not declared in requires.extensions`));
        }
      }
    }
  }
  return errs;
}

// declaredExtensions returns the ids in manifest.requires.extensions.
export function declaredExtensions(manifestDoc: unknown): Set<string> {
  const out = new Set<string>();
  const requires = isObject(manifestDoc) && isObject(manifestDoc.requires) ? manifestDoc.requires : undefined;
  if (requires && Array.isArray(requires.extensions)) {
    for (const ext of requires.extensions) {
      if (isObject(ext) && typeof ext.id === "string") out.add(ext.id);
    }
  }
  return out;
}
