// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleFiles, placeFiles } from "../legacy.js";

function file(path: string, content = "x") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// A repository with an app in apps/web and a hoisted node_modules, as a monorepo build leaves it.
function repo() {
  const root = mkdtempSync(join(tmpdir(), "nbo-legacy-"));
  const app = join(root, "apps", "web");
  file(join(app, ".next", "required-server-files.json"), "{}");
  file(join(app, ".next", "routes-manifest.json"));
  file(join(app, ".next", "server", "app", "page.js"));
  file(
    join(app, ".next", "server", "app", "page.js.nft.json"),
    JSON.stringify({ files: ["../../../../../node_modules/react/index.js"] }),
  );
  file(join(app, ".next", "static", "chunks", "main.js"));
  file(join(root, "node_modules", "react", "index.js"));
  return { root, app };
}

describe("bundleFiles", () => {
  it("lists the manifests, .next/server, .next/static and traced files, keyed from the repository root", () => {
    const { root, app } = repo();
    const assets = bundleFiles(app, root, [".next/routes-manifest.json"]);
    expect(Object.keys(assets).sort()).toEqual([
      "apps/web/.next/required-server-files.json",
      "apps/web/.next/routes-manifest.json",
      "apps/web/.next/server/app/page.js",
      "apps/web/.next/static/chunks/main.js",
      "node_modules/react/index.js",
    ]);
    expect(assets["node_modules/react/index.js"]).toBe(join(root, "node_modules", "react", "index.js"));
  });

  it("skips traced files the build does not have", () => {
    const { root, app } = repo();
    expect(Object.keys(bundleFiles(app, root, [".next/missing.json"]))).not.toContain("apps/web/.next/missing.json");
  });

  it("gives each linked package one place, so a pnpm install loads one React", () => {
    // pnpm's layout: real packages in node_modules/.pnpm/<id>/node_modules/<name>, wired by links.
    const root = mkdtempSync(join(tmpdir(), "nbo-pnpm-"));
    const app = join(root, "app");
    const store = (id: string, name: string) => join(root, "node_modules", ".pnpm", id, "node_modules", name);
    const link = (from: string, to: string) => {
      mkdirSync(dirname(from), { recursive: true });
      symlinkSync(to, from, "junction");
      return from;
    };
    file(join(store("react@18", "react"), "index.js"), "18");
    file(join(store("react-dom@18", "react-dom"), "index.js"));
    file(join(store("react@17", "react"), "index.js"), "17");
    file(join(store("lib@1", "lib"), "index.js"));
    file(join(app, "page.js"));
    const traced = [
      link(join(app, "node_modules", "react"), store("react@18", "react")),
      link(join(app, "node_modules", "react-dom"), store("react-dom@18", "react-dom")),
      link(join(app, "node_modules", "lib"), store("lib@1", "lib")),
      link(join(root, "node_modules", ".pnpm", "react-dom@18", "node_modules", "react"), store("react@18", "react")),
      link(join(root, "node_modules", ".pnpm", "lib@1", "node_modules", "react"), store("react@17", "react")),
      join(app, "page.js"),
      join(app, "node_modules", "react", "index.js"),
      join(store("react@18", "react"), "index.js"),
      join(store("react-dom@18", "react-dom"), "index.js"),
      join(store("lib@1", "lib"), "index.js"),
      join(store("react@17", "react"), "index.js"),
    ];

    const assets = placeFiles(traced, app, root);

    expect(Object.keys(assets).sort()).toEqual([
      "app/page.js",
      "node_modules/lib/index.js",
      "node_modules/lib/node_modules/react/index.js",
      "node_modules/react-dom/index.js",
      "node_modules/react/index.js",
    ]);
    expect(readFileSync(assets["node_modules/react/index.js"]!, "utf8")).toBe("18");
    expect(readFileSync(assets["node_modules/lib/node_modules/react/index.js"]!, "utf8")).toBe("17");
  });

  it("refuses a traced file outside the repository", () => {
    const { root, app } = repo();
    const outside = mkdtempSync(join(tmpdir(), "nbo-host-"));
    file(join(outside, "secret.key"));
    expect(() => bundleFiles(app, root, [], [join(outside, "secret.key")])).toThrow(/resolves outside the repository/);
  });
});
