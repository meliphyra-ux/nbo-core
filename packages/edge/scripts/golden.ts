// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// golden.ts writes the golden vectors the Rust edge (packages/edge-rs) is
// tested against: sticky picks, histogram buckets, route normalisation and
// tag insertion, each computed by this package's own TypeScript code.
//
// Run: pnpm --filter @nbo/edge golden (builds first; Node runs this file
// with its built-in type stripping and imports the built dist/).
// The output is deterministic: inputs come from a seeded generator, so a
// rerun only changes the files when the TypeScript behaviour changes.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickSticky } from "../dist/sticky.js";
import { bucketIndex, METRICS } from "../dist/insights/histogram.js";
import { normalizeRoute } from "../dist/insights/route.js";
import { createInsertionStream, insightsTag } from "../dist/insights/inject.js";
import type { Backend } from "../dist/registry.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "edge-rs", "tests", "golden");

// A seeded stream of pseudo-random bytes (sha256 in counter mode).
let counter = 0;
function bytes(n: number): Buffer {
  const out: Buffer[] = [];
  let have = 0;
  while (have < n) {
    const block = createHash("sha256").update(`nbo-edge-golden-${counter++}`).digest();
    out.push(block);
    have += block.length;
  }
  return Buffer.concat(out).subarray(0, n);
}
function int(max: number): number {
  return bytes(4).readUInt32BE(0) % max;
}
function unit(): number {
  return bytes(6).readUIntBE(0, 6) / 2 ** 48;
}
function pickOne<T>(items: readonly T[]): T {
  return items[int(items.length)]!;
}

function write(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), `${JSON.stringify(data, null, 1)}\n`);
  console.log(`golden: wrote ${join(OUT, name)}`);
}

// ---------- sticky: 200 cases

interface StickyCase {
  visitorId: string;
  backends: { id?: string; url: string; weight: number }[];
  // pick is the index of the chosen backend; error is set instead when no
  // backend can be picked.
  pick?: number;
  url?: string;
  error?: string;
}

function sticky(): StickyCase[] {
  const host = "golden.test";
  const fixed: { id?: string; url: string; weight: number }[][] = [
    [
      { id: "env_a", url: "http://10.0.0.1:8080", weight: 1 },
      { id: "env_b", url: "http://10.0.0.2:8080", weight: 99 },
    ],
    [
      { id: "env_a", url: "http://10.0.0.1:8080", weight: 99 },
      { id: "env_b", url: "http://10.0.0.2:8080", weight: 1 },
    ],
    [
      { id: "env_a", url: "http://10.0.0.1:8080", weight: 33 },
      { id: "env_b", url: "http://10.0.0.2:8080", weight: 33 },
      { id: "env_c", url: "http://10.0.0.3:8080", weight: 34 },
    ],
    [
      { url: "https://a.example", weight: 50 },
      { id: "env_b", url: "https://b.example", weight: 50 },
    ],
    [
      { url: "https://a.example", weight: 1 },
      { url: "https://b.example", weight: 0 },
      { url: "https://c.example/base", weight: 3 },
    ],
    [{ id: "only", url: "http://10.0.0.9", weight: 1 }],
  ];
  const weights = [0, 1, 1, 2, 3, 5, 10, 33, 34, 50, 99, 100, 1000];
  const cases: StickyCase[] = [];
  const visitor = () => bytes(16).toString("hex");
  const run = (backends: StickyCase["backends"]) => {
    const visitorId = visitor();
    const full: Backend[] = backends.map((b) => ({ ...b, insecureSkipVerify: false }));
    try {
      const chosen = pickSticky({ host, backends: full }, visitorId);
      cases.push({ visitorId, backends, pick: full.indexOf(chosen), url: chosen.url });
    } catch (err) {
      cases.push({ visitorId, backends, error: err instanceof Error ? err.message : String(err) });
    }
  };
  // Each fixed split with 12 visitors.
  for (const backends of fixed) for (let i = 0; i < 12; i++) run(backends);
  // Two with no pickable backend.
  run([{ id: "z", url: "http://10.0.0.1", weight: 0 }]);
  run([]);
  while (cases.length < 200) {
    const n = 1 + int(4);
    const backends: StickyCase["backends"] = [];
    for (let k = 0; k < n; k++) {
      const weight = int(5) === 0 ? int(1001) : pickOne(weights);
      const url = int(2) === 0 ? `http://10.0.${int(4)}.${k + 1}:8080` : `https://b${k}.example${int(3) === 0 ? "/base" : ""}`;
      const b = int(5) < 3 ? { id: int(2) === 0 ? `env_${k}` : `e${bytes(4).toString("hex")}`, url, weight } : { url, weight };
      backends.push(b);
    }
    if (backends.every((b) => b.weight === 0)) backends[int(n)]!.weight = 1 + int(100);
    run(backends);
  }
  return cases;
}

// ---------- histogram: 500 values per metric

function histogram(): { metric: string; value: number; index: number }[] {
  const out: { metric: string; value: number; index: number }[] = [];
  for (const metric of METRICS) {
    const scale = metric === "CLS" ? 1000 : 1;
    const values: number[] = [0, -0, -1, -0.001, -120000, 1e-12, 5e-324, 0.5, 0.999999, 1, 1.0000001, 1.05, 1.025, 2, 10, 100, 1000, 120000, 1e9];
    if (metric === "CLS") values.push(0.0001, 0.001, 0.00105, 0.01, 0.05, 0.1, 0.1000001, 0.25, 1, 9.999, 10);
    // Bucket edges: 1.05^k exactly as JS computes it, and its neighbours.
    for (let k = 0; k <= 130; k++) {
      const edge = 1.05 ** k / scale;
      values.push(edge, edge * (1 - 1e-12), edge * (1 + 1e-12));
    }
    while (values.length < 500) {
      const r = unit();
      values.push(metric === "CLS" ? Number((r * 2).toFixed(4)) : int(3) === 0 ? r * 120000 : Math.round(r * 120000));
    }
    for (const value of values.slice(0, 500)) out.push({ metric, value, index: bucketIndex(metric, value) });
  }
  return out;
}

// ---------- routes: 100 paths

function routes(): { path: string; route: string | null }[] {
  const paths = [
    "/",
    "",
    "users",
    "//evil.example/x",
    "/users/123",
    "/users/123/posts/456",
    "/a?b=1",
    "/a#hash",
    "/a?b=1#h",
    "?only",
    "#only",
    "/a//b",
    "/a/",
    "/0",
    "/007",
    "/v1",
    "/12abc",
    "/u/550e8400-e29b-41d4-a716-446655440000",
    "/u/550E8400-E29B-41D4-A716-446655440000",
    "/u/550e8400-e29b-41d4-a716-44665544000",
    "/u/550e8400e29b41d4a716446655440000",
    "/h/0123456789abcdef",
    "/h/0123456789abcde",
    "/h/0123456789ABCDEF0123",
    "/h/0123456789abcdeg",
    "/t/abcdefghijklmnopqrs1",
    "/t/abcdefghijklmnopqr1",
    "/t/abcdefghijklmnopqrst",
    "/t/how-to-deploy-on-kubernetes",
    "/t/how-to-deploy-on-kubernetes-2",
    "/t/aaaaaaaaaaaaaaaaaaaaaaaaa9",
    "/t/a_b.c~d%2Be=f-g+h1234567",
    "/t/a_b.c~d%2Be=f-g+h!1234567",
    "/t/9aaaaaaaaaaaaaaaaaaa",
    "/t/aaaaaaaaaaaaaaaaaaa9",
    "/t/AAAAAAAAAAAAAAAAAAAA0",
    "/t/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123",
    "/me@example.com",
    "/u/me@example.com/settings",
    "/@",
    "/a@",
    "/%40",
    "/café",
    "/١٢٣",
    "/١٢٣٤٥٦٧٨٩٠١٢٣٤٥٦٧٨٩٠a",
    "/１２３",
    "/éééééééééééééééééééé1",
    "/a b/123",
    "/a\nb",
    "/aaaaaaaaaaaaaaaaaaaa\n1",
    "/products/shoes/42?color=red",
    "/blog/2024/10/my-post",
    "/blog/2024/10/my-post-2024-10-30-final-v2",
    "/_next/static/chunks/main-0123456789abcdef.js",
    "/api/v1/items/18446744073709551616",
    "/a/b/c/d/e/f/g/h",
    "/x?y=/1#/2",
    "/.",
    "/..",
    "/-",
    "/" + "a".repeat(250),
    "/" + "1".repeat(250),
    "/deadbeefdeadbeef",
    "/DeadBeefDeadBeef",
    "/deadbeefdeadbee",
    "/ABCDEF0123456789",
  ];
  const segments = [
    "users",
    "123",
    "abc",
    "550e8400-e29b-41d4-a716-446655440000",
    "0123456789abcdef0",
    "tokenaaaaaaaaaaaaaa12",
    "slug-with-words-only-ok",
    "x@y",
    "",
    "%20",
    "v2",
    "été",
  ];
  while (paths.length < 100) {
    const n = 1 + int(4);
    let p = "";
    for (let i = 0; i < n; i++) p += `/${pickOne(segments)}`;
    if (int(4) === 0) p += "?q=" + pickOne(segments);
    if (int(6) === 0) p += "#" + pickOne(segments);
    paths.push(p);
  }
  return paths.slice(0, 100).map((path) => ({ path, route: normalizeRoute(path) ?? null }));
}

// ---------- inject: 30 cases

async function insert(tag: string, chunks: string[]): Promise<string> {
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(Buffer.from(c, "utf8")));
      controller.close();
    },
  });
  const out: Buffer[] = [];
  const reader = input.pipeThrough(createInsertionStream(tag)).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(Buffer.from(value));
  }
  return Buffer.concat(out).toString("utf8");
}

async function inject(): Promise<{ name: string; tag: string; chunks: string[]; output: string }[]> {
  const tagA = insightsTag({ environmentId: "env_a", contentId: "c1", sampleRate: 100 });
  const tagB = insightsTag({ environmentId: 'e"<&>', contentId: "", sampleRate: 10 });
  const big = "x".repeat(100);
  const cases: { name: string; tag: string; chunks: string[] }[] = [];
  const page = "<html><head><title>t</title></head><body>b</body></html>";
  const at = page.indexOf("</head>");
  // </head> split at every position.
  for (let k = 0; k <= 7; k++) cases.push({ name: `</head> split after ${k} bytes`, tag: tagA, chunks: [page.slice(0, at + k), page.slice(at + k)] });
  cases.push(
    { name: "one chunk", tag: tagA, chunks: [page] },
    { name: "upper case", tag: tagA, chunks: ["<HTML><HEAD></HEAD><BODY></BODY>"] },
    { name: "mixed case split", tag: tagA, chunks: ["<head></He", "Ad>"] },
    { name: "no head: before </body>", tag: tagA, chunks: ["<p>hi</p></bo", "dy></html>"] },
    { name: "</body> before </head>", tag: tagA, chunks: ["<body></body><head></head>"] },
    { name: "neither", tag: tagA, chunks: ["<p>plain</p>", "<p>more</p>"] },
    { name: "partial tag left at the end", tag: tagA, chunks: ["<p>x</p></he"] },
    { name: "near misses", tag: tagA, chunks: ["</headx></ head></hea d></bod></body"] },
    { name: "only the first tag", tag: tagA, chunks: ["<head></head><head></head></body>"] },
    { name: "tag at the very start", tag: tagA, chunks: ["</head>rest"] },
    { name: "empty chunks around", tag: tagA, chunks: ["", "<head>", "", "</head>", ""] },
    { name: "no chunks", tag: tagA, chunks: [] },
    { name: "large chunk after held tail, tag in the joint", tag: tagA, chunks: [`${big}</h`, `ead>${big}`] },
    { name: "large chunk after held tail, tag later in the chunk", tag: tagA, chunks: [`${big}</h`, `xx${big}</head>${big}`] },
    { name: "small chunks then large", tag: tagA, chunks: ["<", "/", "h", `ead>${big}`] },
    { name: "held tail is not a tag", tag: tagA, chunks: ["<p></b", `r>${big}</body>`] },
    { name: "chunks after insertion pass through", tag: tagA, chunks: ["<head></head>", "</head>", big] },
    { name: "UTF-8 content", tag: tagA, chunks: ["<head><title>café 日本</title></he", "ad><body>ü</body>"] },
    { name: "escaped attributes", tag: tagB, chunks: ["<head></head>"] },
    { name: "every byte its own chunk", tag: tagB, chunks: [..."<html><head></HEAD></html>"] },
    { name: "carry of </body prefix then </head>", tag: tagA, chunks: ["a</b", "</head>"] },
    { name: "large chunk, tag straddles the joint at its first byte", tag: tagA, chunks: [`${big}<`, `/body>${big}`] },
  );
  const out = [];
  for (const c of cases.slice(0, 30)) out.push({ ...c, output: await insert(c.tag, c.chunks) });
  return out;
}

write("sticky.json", sticky());
write("histogram.json", histogram());
write("routes.json", routes());
write("inject.json", await inject());
