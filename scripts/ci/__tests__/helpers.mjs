// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const BS = String.fromCharCode(92);
const toBashPath = (p) => p.split(BS).join("/");

// Each fake tool appends its argv as one JSON line to logFile, then runs the
// optional canned snippet (bash) for stdout and exit code.
export function withFakeTools(names, scripts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nbo-fake-tools-"));
  const binDir = join(dir, "bin");
  const logFile = join(dir, "calls.log");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(logFile, "");
  for (const name of names) {
    const body = [
      "#!/usr/bin/env bash",
      'json="["; sep=""',
      'for a in "$@"; do',
      `  e=\${a//${BS}${BS}/${BS}${BS}${BS}${BS}}; e=\${e//${BS}"/${BS}${BS}${BS}"}`,
      '  json+="$sep\\"$e\\""; sep=","',
      "done",
      'json+="]"',
      `echo "$json" >> "${toBashPath(logFile)}"`,
      scripts[name] ?? "exit 0",
      "",
    ].join("\n");
    const file = join(binDir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  return {
    binDir,
    logFile,
    readLog() {
      if (!existsSync(logFile)) return [];
      return readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function runBash(script, args = [], env = {}) {
  const r = spawnSync("bash", [script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function pathWith(binDir) {
  return `${binDir}${delimiter}${process.env.PATH}`;
}
