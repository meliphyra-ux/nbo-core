// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FUNCTION_NAME } from "./functions.js";

// knownSecretPrefixes are widely-recognized secret shapes — a hard
// match on any of these is always an error, regardless of entropy.
// Fixed, hardcoded patterns scanning build output (never user input),
// so plain RegExp is fine here — unlike routes.ts's RE2 compile check,
// nothing here needs RE2's own guarantees.
const knownSecretPrefixes = [
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/, // PEM private key header
  /ghp_[0-9A-Za-z]{36}/, // GitHub personal access token
  /github_pat_[0-9A-Za-z_]{22,}/, // GitHub fine-grained PAT
];

// entropyMinLength is the shortest a "word" needs to be before the
// entropy heuristic even considers it — short strings (ids, flags)
// can look statistically "random" without being secrets at all, and
// every known-prefix case above is already longer than this anyway.
const entropyMinLength = 20;

// entropyThreshold was picked empirically against this project's own
// real fixture output (see secrets.go's own comment) — high enough
// that a sha256 digest (64 lowercase hex characters, ~4 bits/char of
// real entropy) and a build id ("b_" + 10 hex characters) both stay
// under it, low enough that a real high-entropy secret (base64/mixed-
// case random, ~5.5-6 bits/char) clears it.
const entropyThreshold = 4.5;

// wordSplitter breaks raw file text into candidate "words" for the
// entropy check — JSON's own structural punctuation marks the real
// boundaries between one string value and the next. Deliberately does
// NOT split on whitespace: a real secret shape can contain internal
// spaces (a PEM header, "-----BEGIN RSA PRIVATE KEY-----") and
// splitting on them would break a multi-word pattern into fragments
// that never match as a whole.
const wordSplitter = /[",:[\]{}]+/;

function shannonEntropy(s: string): number {
  if (s === "") return 0;
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const n = s.length;
  for (const c of counts.values()) {
    const p = c / n;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// looksLikePath reports whether s is shaped like a file path or URL
// rather than a raw secret token — a secret is one unbroken blob
// (base64/hex), never containing "/". The known-prefix checks still
// catch a literal credential even inside path-like text; this only
// narrows the noisy entropy heuristic.
function looksLikePath(s: string): boolean {
  return s.includes("/");
}

export function looksHighEntropy(s: string): boolean {
  return s.length >= entropyMinLength && !looksLikePath(s) && shannonEntropy(s) >= entropyThreshold;
}

// scanWords checks every candidate word in raw against the known-
// prefix list and the entropy heuristic, returning one error per match
// naming label (the file being scanned) and the matched text.
function scanWords(label: string, raw: string): Error[] {
  const errs: Error[] = [];
  for (const word of raw.split(wordSplitter)) {
    if (word === "") continue;
    for (const re of knownSecretPrefixes) {
      const m = word.match(re);
      if (m) {
        errs.push(new Error(`${label}: looks like a secret (matches a known key prefix): "${m[0]}"`));
      }
    }
    if (looksHighEntropy(word)) {
      errs.push(new Error(`${label}: looks like a secret (high entropy, ${word.length} characters): "${word}"`));
    }
  }
  return errs;
}

function scanFileForSecrets(path: string): Error[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return scanWords(path, raw);
}

// scanForSecrets covers .nbo/'s own JSON config files and each
// function's own function.json — not every file in every function's
// traced bundle (tens of thousands of files deep for a real app;
// byte-scanning all of them on every validate call would be a real,
// user-visible slowdown, and the files most plausibly carrying an
// accidentally-hardcoded secret are the ones a writer-API caller's own
// code produced, not third-party node_modules source).
export function scanForSecrets(dir: string): Error[] {
  let errs: Error[] = [];
  for (const name of ["manifest.json", "routes.json", "static.index.json", "prerender.json"]) {
    errs = errs.concat(scanFileForSecrets(join(dir, name)));
  }

  let manifest: { functions?: unknown } | null;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    return errs;
  }
  const functionNames = Array.isArray(manifest?.functions) ? manifest.functions : [];
  for (const name of functionNames) {
    // An invalid name is reported by validateFunction and never joined
    // into a path, so nothing outside .nbo/ is read.
    if (typeof name !== "string" || !FUNCTION_NAME.test(name)) continue;
    errs = errs.concat(scanFileForSecrets(join(dir, "functions", name, "function.json")));
  }
  return errs;
}
