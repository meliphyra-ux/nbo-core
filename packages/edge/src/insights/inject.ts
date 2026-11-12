// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { SCRIPT_PATH } from "./script.js";
import { isDocumentNavigation } from "../navigation.js";

// Inserting the Speed Insights tag into HTML pages, streamed.

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function insightsTag(opts: { environmentId: string; contentId: string; sampleRate: number }): string {
  return `<script defer src="${SCRIPT_PATH}" data-e="${escapeAttr(opts.environmentId)}" data-d="${escapeAttr(opts.contentId)}" data-s="${opts.sampleRate}"></script>`;
}

// ASCII_COMPATIBLE: charsets in which the ASCII tag and "</head>" are the
// same bytes as in ASCII. Anything else (UTF-16/32, Shift_JIS, unknown)
// is left alone; no charset named is taken as allowed (HTML defaults to
// an ASCII-compatible one).
const ASCII_COMPATIBLE = /^(utf-?8|us-ascii|ascii|iso[-_]?8859[-_]\d{1,2}|latin-?1|windows-125\d|cp125\d)$/;

function asciiCompatible(contentType: string): boolean {
  const m = /;\s*charset\s*=\s*"?([^";\s]*)"?/i.exec(contentType);
  return !m || ASCII_COMPATIBLE.test(m[1]!.toLowerCase());
}

// shouldInsert: only a GET document navigation (a script's fetch() of
// HTML is left alone) answered 200, text/html in an ASCII-compatible
// charset, with a body, and not when the
// response forbids changes (cache-control: no-transform) or still carries
// a content-encoding the proxy could not undo (proxyRequest strips the
// header after fetch() decompresses gzip/deflate/br, so one left here
// means the bytes are still encoded).
export function shouldInsert(request: Request, response: Response): boolean {
  if (request.method !== "GET" || response.status !== 200 || !response.body) return false;
  if (!isDocumentNavigation(request.headers)) return false;
  const contentType = response.headers.get("content-type") ?? "";
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type !== "text/html") return false;
  if (!asciiCompatible(contentType)) return false;
  if (/(^|,)\s*no-transform\s*(,|$)/i.test(response.headers.get("cache-control") ?? "")) return false;
  const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
  return encoding === "" || encoding === "identity";
}

const HEAD = new TextEncoder().encode("</head>");
const BODY = new TextEncoder().encode("</body>");
// SMALL: below this size a chunk is simply joined with the carry; above
// it, the page bytes are never copied.
const SMALL = 64;

function lower(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
}

function startsWithCI(hay: Uint8Array, at: number, needle: Uint8Array, len: number): boolean {
  for (let j = 0; j < len; j++) {
    if (lower(hay[at + j]!) !== needle[j]) return false;
  }
  return true;
}

function indexOfCI(hay: Uint8Array, needle: Uint8Array): number {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (startsWithCI(hay, i, needle, needle.length)) return i;
  }
  return -1;
}

// firstTag is the offset of the first </head> or </body>, or -1.
function firstTag(buf: Uint8Array): number {
  const h = indexOfCI(buf, HEAD);
  const b = indexOfCI(buf, BODY);
  return h < 0 ? b : b < 0 ? h : Math.min(h, b);
}

// partialSuffix is the length of the longest tail of buf that is a proper
// prefix of </head> or </body> — the only bytes worth holding back.
function partialSuffix(buf: Uint8Array): number {
  for (let k = Math.min(HEAD.length - 1, buf.length); k > 0; k--) {
    const at = buf.length - k;
    if (startsWithCI(buf, at, HEAD, k) || startsWithCI(buf, at, BODY, k)) return k;
  }
  return 0;
}

function concat(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// createInsertionStream inserts tag before the first </head> (any case);
// when a </body> comes first, before that; with neither, the page passes
// through unchanged. It works on bytes, so any ASCII-compatible charset is
// safe. Between chunks it holds back only a tail that could start one of
// the two tags (at most 6 bytes), and passes everything else on as views
// of the incoming chunks, without copying them.
export function createInsertionStream(tag: string): TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>> {
  const tagBytes = new TextEncoder().encode(tag);
  let carry: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let done = false;

  function scan(buf: Uint8Array<ArrayBuffer>, controller: TransformStreamDefaultController<Uint8Array<ArrayBuffer>>): void {
    const at = firstTag(buf);
    if (at >= 0) {
      done = true;
      if (at > 0) controller.enqueue(buf.subarray(0, at));
      controller.enqueue(tagBytes);
      controller.enqueue(buf.subarray(at));
      return;
    }
    const keep = partialSuffix(buf);
    if (buf.length > keep) controller.enqueue(buf.subarray(0, buf.length - keep));
    carry = buf.slice(buf.length - keep);
  }

  return new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      if (done) {
        controller.enqueue(chunk);
        return;
      }
      if (carry.length === 0 || chunk.length <= SMALL) {
        const buf = concat(carry, chunk);
        carry = new Uint8Array(0);
        scan(buf, controller);
        return;
      }
      // A large chunk after a held-back tail: look for a tag that starts in
      // the tail using only the tail and the chunk's first bytes.
      const joint = concat(carry, chunk.slice(0, HEAD.length - 1));
      const at = firstTag(joint);
      const held = carry;
      carry = new Uint8Array(0);
      if (at >= 0 && at < held.length) {
        done = true;
        if (at > 0) controller.enqueue(held.subarray(0, at));
        controller.enqueue(tagBytes);
        controller.enqueue(held.subarray(at));
        controller.enqueue(chunk);
        return;
      }
      controller.enqueue(held);
      scan(chunk, controller);
    },
    flush(controller) {
      if (carry.length > 0) controller.enqueue(carry);
    },
  });
}
