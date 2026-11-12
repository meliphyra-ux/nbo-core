// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathWith, runBash, withFakeTools } from "./helpers.mjs";

// rehearse-kubernetes.sh with every outside tool faked: docker answers the
// script's existence checks with "nothing there", `docker run` of the job
// copies the generated job script aside, and powershell.exe stands in for
// the Windows keep-awake helper.
// A job line with every character the stamp echo has to escape.
const TRICKY = 'grep -q "all $HOME `pwd`" a\\b || true';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "nbo-rehearse-"));
  const tmp = join(dir, "tmp").split("\\").join("/");
  const capture = join(dir, "job-script.sh").split("\\").join("/");
  const awake = join(dir, "awake.txt").split("\\").join("/");
  const jobFile = join(dir, "lines.txt");
  writeFileSync(jobFile, `echo one\nbash scripts/ci/dind-forward.sh\necho two\n${TRICKY}\n`);
  const t = withFakeTools(["docker", "git", "powershell.exe"], {
    docker: [
      'case "$1" in',
      '  inspect) echo fakeid ;;',
      '  run) for a in "$@"; do [ "$a" = "tar" ] && { cat >/dev/null; exit 0; }; done',
      `       cp "${tmp}/nbo-ci-rehearse-job.sh" "${capture}"; exit 0 ;;`,
      "esac",
      "exit 0",
    ].join("\n"),
    git: 'case "$1" in -C) shift 2 ;; esac; case "$1" in rev-parse) echo 0123abc ;; archive) printf x ;; esac; exit 0',
    // The helper records its arguments and whether the lock file exists while it runs.
    "powershell.exe": [
      'lock=""; prev=""; for a in "$@"; do [ "$prev" = "-LockFile" ] && lock="$a"; prev="$a"; done',
      `[ -n "$lock" ] && [ -e "$lock" ] && echo "lock present" >> "${awake}"`,
      "exit 0",
    ].join("\n"),
  });
  return {
    t,
    tmp,
    capture,
    awake,
    jobFile,
    done: () => {
      t.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("keeps the machine awake for the run through scripts/ci/keep-awake.ps1, and releases it afterwards", () => {
  const s = setup();
  try {
    const r = runBash("scripts/ci/rehearse-kubernetes.sh", [], {
      PATH: pathWith(s.t.binDir),
      NBO_REHEARSE_JOB_FILE: s.jobFile,
      NBO_REHEARSE_TMP: s.tmp,
    });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const ps = s.t.readLog().filter((a) => a.some((x) => x.endsWith("keep-awake.ps1")));
    assert.equal(ps.length, 1, `one keep-awake helper, calls: ${JSON.stringify(s.t.readLog())}`);
    const args = ps[0];
    const lock = args[args.indexOf("-LockFile") + 1];
    assert.ok(lock, "a -LockFile argument");
    assert.ok(readFileSync(s.awake, "utf8").includes("lock present"), "the lock file exists while the helper starts");
    assert.equal(existsSync(lock), false, "the lock file is removed when the run ends");
  } finally {
    s.done();
  }
});

test("NBO_REHEARSE_KEEP_AWAKE=0 starts no keep-awake helper", () => {
  const s = setup();
  try {
    const r = runBash("scripts/ci/rehearse-kubernetes.sh", [], {
      PATH: pathWith(s.t.binDir),
      NBO_REHEARSE_JOB_FILE: s.jobFile,
      NBO_REHEARSE_TMP: s.tmp,
      NBO_REHEARSE_KEEP_AWAKE: "0",
    });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(s.t.readLog().filter((a) => a.some((x) => x.endsWith("keep-awake.ps1"))).length, 0);
  } finally {
    s.done();
  }
});

test("the job script prints a timestamp before every job line", () => {
  const s = setup();
  try {
    const r = runBash("scripts/ci/rehearse-kubernetes.sh", [], {
      PATH: pathWith(s.t.binDir),
      NBO_REHEARSE_JOB_FILE: s.jobFile,
      NBO_REHEARSE_TMP: s.tmp,
      NBO_REHEARSE_KEEP_AWAKE: "0",
    });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const script = readFileSync(s.capture, "utf8");
    const lines = script.split("\n");
    for (const job of ["echo one", "bash scripts/ci/dind-forward.sh", "echo two"]) {
      const i = lines.indexOf(job);
      assert.ok(i > 0, `job line ${job} is in the script`);
      assert.match(lines[i - 1], /^echo "\[rehearse \$\(date \+%T\)\] /, `a timestamp line before ${job}`);
    }
    // Running the stamp line prints the time and the line.
    const stamp = lines[lines.indexOf("echo two") - 1];
    const out = runBash("-c", [stamp]);
    assert.match(out.stdout, /^\[rehearse \d\d:\d\d:\d\d\] echo two$/m);
    const tricky = runBash("-c", [lines[lines.indexOf(TRICKY) - 1]]);
    assert.equal(tricky.stdout.replace(/^\[rehearse \d\d:\d\d:\d\d\] /, ""), TRICKY + "\n");
  } finally {
    s.done();
  }
});
