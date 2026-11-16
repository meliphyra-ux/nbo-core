#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich
import { pathToFileURL } from "node:url";
import { runValidate } from "./validate.js";
import { runServe } from "./serve.js";
import { runDeploy } from "./deploy.js";
import { runPlan } from "./plan.js";
import { runConformance } from "./conformance.js";
import { runContentId } from "./content-id.js";
import { runIsrcache } from "@nbo/isrcache";

export interface Handlers {
  validate: (args: string[]) => Promise<number>;
  serve: (args: string[]) => Promise<number>;
  deploy: (args: string[]) => Promise<number>;
  plan: (args: string[]) => Promise<number>;
  conformance: (args: string[]) => Promise<number>;
  contentId: (args: string[]) => Promise<number>;
  isrcache: (args: string[]) => Promise<number>;
}

// dispatch — port of main (cmd/nbo/main.go lines 8-28), the switch
// itself pulled out into its own testable function, injectable with
// stub handlers so a test can route without actually running a deploy.
export async function dispatch(argv: string[], handlers: Handlers): Promise<number> {
  if (argv.length < 1) {
    console.error("usage: nbo <validate|serve|deploy|plan|conformance|content-id|isrcache> ...");
    return 1;
  }
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "validate":
      return handlers.validate(rest);
    case "serve":
      return handlers.serve(rest);
    case "deploy":
      return handlers.deploy(rest);
    case "plan":
      return handlers.plan(rest);
    case "conformance":
      return handlers.conformance(rest);
    case "content-id":
      return handlers.contentId(rest);
    case "isrcache":
      return handlers.isrcache(rest);
    default:
      console.error(`unknown subcommand ${JSON.stringify(subcommand)}`);
      return 1;
  }
}

// startIsrcache runs the ISR cache service; the listening server keeps the
// process alive after this resolves, so the exit code only matters on a
// failed start.
async function startIsrcache(): Promise<number> {
  runIsrcache(process.env);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  dispatch(process.argv.slice(2), {
    validate: runValidate,
    serve: runServe,
    deploy: runDeploy,
    plan: runPlan,
    conformance: runConformance,
    contentId: runContentId,
    isrcache: startIsrcache,
  }).then((code) => {
    process.exitCode = code;
  });
}
