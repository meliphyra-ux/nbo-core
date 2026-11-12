// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Inserting the Speed Insights tag into HTML pages, streamed. Port of
//! `packages/edge/src/insights/inject.ts`.
//!
//! Unlike the TypeScript edge, the Rust edge passes compressed answers
//! through (the spec's intended difference 1). A page that gets the tag is
//! the one exception: its gzip, deflate or brotli bytes are decoded here,
//! the tag inserted, and the page sent uncompressed, as the TypeScript
//! edge sends every page. Nothing else is ever decoded.

use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll, ready};

use async_compression::tokio::bufread::{BrotliDecoder, DeflateDecoder, GzipDecoder, ZlibDecoder};
use bytes::{Bytes, BytesMut};
use http::HeaderMap;
use http_body_util::BodyExt;
use hyper::body::{Body, Frame, SizeHint};
use tokio::io::{AsyncBufRead, AsyncRead, BufReader, ReadBuf};
use tokio_util::io::StreamReader;

use super::script::SCRIPT_PATH;
use crate::proxy::{BoxError, EdgeBody};
use crate::text::{header_joined, is_js_space, js_trim};

fn escape_attr(v: &str) -> String {
    v.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The tag for one page: the script, with the environment that served the
/// page, its deployment id and the host's sample rate.
pub fn insights_tag(environment_id: &str, content_id: &str, sample_rate: u8) -> String {
    format!(
        "<script defer src=\"{SCRIPT_PATH}\" data-e=\"{}\" data-d=\"{}\" data-s=\"{sample_rate}\"></script>",
        escape_attr(environment_id),
        escape_attr(content_id)
    )
}

// ---------- which pages

/// The `charset` parameter of a content type, as
/// `/;\s*charset\s*=\s*"?([^";\s]*)"?/i` finds it.
fn charset_param(content_type: &str) -> Option<&str> {
    for (i, _) in content_type.match_indices(';') {
        let rest = content_type[i + 1..].trim_start_matches(is_js_space);
        match rest.get(..7) {
            Some(name) if name.eq_ignore_ascii_case("charset") => {}
            _ => continue,
        }
        let rest = rest[7..].trim_start_matches(is_js_space);
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start_matches(is_js_space);
        let rest = rest.strip_prefix('"').unwrap_or(rest);
        let end = rest
            .find(|c: char| c == '"' || c == ';' || is_js_space(c))
            .unwrap_or(rest.len());
        return Some(&rest[..end]);
    }
    None
}

fn one_or_two_digits(s: &str) -> bool {
    (1..=2).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_digit())
}

/// `^(utf-?8|us-ascii|ascii|iso[-_]?8859[-_]\d{1,2}|latin-?1|windows-125\d|cp125\d)$`:
/// charsets in which the ASCII tag and `</head>` are the same bytes as in
/// ASCII.
fn ascii_compatible_name(name: &str) -> bool {
    if matches!(
        name,
        "utf8" | "utf-8" | "us-ascii" | "ascii" | "latin1" | "latin-1"
    ) {
        return true;
    }
    let digit = |s: &str| s.len() == 1 && s.as_bytes()[0].is_ascii_digit();
    if let Some(d) = name
        .strip_prefix("windows-125")
        .or(name.strip_prefix("cp125"))
    {
        return digit(d);
    }
    if let Some(rest) = name.strip_prefix("iso") {
        let rest = rest.strip_prefix(['-', '_']).unwrap_or(rest);
        if let Some(rest) = rest.strip_prefix("8859")
            && let Some(n) = rest.strip_prefix(['-', '_'])
        {
            return one_or_two_digits(n);
        }
    }
    false
}

// No charset named is taken as allowed (HTML defaults to an
// ASCII-compatible one); UTF-16/32, Shift_JIS and unknown ones are not.
fn ascii_compatible(content_type: &str) -> bool {
    charset_param(content_type).is_none_or(|c| ascii_compatible_name(&c.to_lowercase()))
}

/// What `shouldInsert` asks of the answer's headers, apart from its
/// encoding: `text/html` in an ASCII-compatible charset, and no
/// `cache-control: no-transform`. (The request must also be a `GET`
/// document navigation answered 200; the proxy checks those.)
pub fn page_takes_tag(headers: &HeaderMap) -> bool {
    let content_type = header_joined(headers, "content-type", ", ").unwrap_or_default();
    let media = js_trim(content_type.split(';').next().unwrap_or("")).to_lowercase();
    if media != "text/html" || !ascii_compatible(&content_type) {
        return false;
    }
    let cache_control = header_joined(headers, "cache-control", ", ").unwrap_or_default();
    !cache_control
        .split(',')
        .any(|d| js_trim(d).eq_ignore_ascii_case("no-transform"))
}

/// One content coding the edge can undo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coding {
    /// `gzip` or `x-gzip`, every member read (as gunzip does).
    Gzip,
    /// `deflate`: zlib, or raw deflate when the first byte says so (as
    /// Node's fetch reads it).
    Deflate,
    /// `br`.
    Br,
}

/// How a page's bytes are encoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageEncoding {
    /// No `content-encoding`, or `identity`.
    Plain,
    /// Codings the edge can undo, in the header's order (applied first to
    /// last, so undone last to first).
    Decode(Vec<Coding>),
    /// Anything else, `zstd` included: the page passes through as it is,
    /// without the tag.
    Opaque,
}

/// Reads `content-encoding` as the TypeScript edge's fetch does: every
/// listed coding must be known, or nothing is decoded. `zstd`, which
/// Node's fetch also decodes, has no decoder here (it would need a C
/// library), so a zstd page passes through without the tag.
pub fn page_encoding(headers: &HeaderMap) -> PageEncoding {
    let joined = header_joined(headers, "content-encoding", ", ").unwrap_or_default();
    let whole = js_trim(&joined).to_lowercase();
    if whole.is_empty() || whole == "identity" {
        return PageEncoding::Plain;
    }
    let mut codings = Vec::new();
    for coding in joined.split(',') {
        codings.push(match js_trim(coding).to_lowercase().as_str() {
            "gzip" | "x-gzip" => Coding::Gzip,
            "deflate" => Coding::Deflate,
            "br" => Coding::Br,
            _ => return PageEncoding::Opaque,
        });
    }
    PageEncoding::Decode(codings)
}

// ---------- the insertion

const HEAD: &[u8] = b"</head>";
const BODY: &[u8] = b"</body>";
// Below this size a chunk is simply joined with the carry; above it, the
// page bytes are never copied.
const SMALL: usize = 64;

fn starts_with_ci(hay: &[u8], at: usize, needle: &[u8], len: usize) -> bool {
    (0..len).all(|j| hay[at + j].to_ascii_lowercase() == needle[j])
}

fn index_of_ci(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len())
        .find(|&i| hay[i] == b'<' && starts_with_ci(hay, i, needle, needle.len()))
}

// The offset of the first </head> or </body>.
fn first_tag(buf: &[u8]) -> Option<usize> {
    match (index_of_ci(buf, HEAD), index_of_ci(buf, BODY)) {
        (Some(h), Some(b)) => Some(h.min(b)),
        (h, b) => h.or(b),
    }
}

// The length of the longest tail of buf that is a proper prefix of
// </head> or </body>: the only bytes worth holding back.
fn partial_suffix(buf: &[u8]) -> usize {
    for k in (1..=(HEAD.len() - 1).min(buf.len())).rev() {
        let at = buf.len() - k;
        if starts_with_ci(buf, at, HEAD, k) || starts_with_ci(buf, at, BODY, k) {
            return k;
        }
    }
    0
}

fn concat(a: &Bytes, b: &[u8]) -> Bytes {
    if a.is_empty() {
        return Bytes::copy_from_slice(b);
    }
    let mut out = BytesMut::with_capacity(a.len() + b.len());
    out.extend_from_slice(a);
    out.extend_from_slice(b);
    out.freeze()
}

fn emit(out: &mut VecDeque<Bytes>, b: Bytes) {
    if !b.is_empty() {
        out.push_back(b);
    }
}

/// Inserts a tag before the first `</head>` (any case); when a `</body>`
/// comes first, before that; with neither, the page passes through
/// unchanged. It works on bytes, so any ASCII-compatible charset is safe.
/// Between chunks it holds back only a tail that could start one of the
/// two tags (at most 6 bytes), and passes everything else on as slices of
/// the incoming chunks.
pub struct Inserter {
    tag: Bytes,
    carry: Bytes,
    done: bool,
}

impl Inserter {
    pub fn new(tag: &str) -> Inserter {
        Inserter {
            tag: Bytes::copy_from_slice(tag.as_bytes()),
            carry: Bytes::new(),
            done: false,
        }
    }

    fn scan(&mut self, buf: Bytes, out: &mut VecDeque<Bytes>) {
        if let Some(at) = first_tag(&buf) {
            self.done = true;
            emit(out, buf.slice(..at));
            emit(out, self.tag.clone());
            emit(out, buf.slice(at..));
            return;
        }
        let keep = partial_suffix(&buf);
        emit(out, buf.slice(..buf.len() - keep));
        self.carry = buf.slice(buf.len() - keep..);
    }

    /// Takes the next chunk of the page; what may go on is added to `out`.
    pub fn push(&mut self, chunk: Bytes, out: &mut VecDeque<Bytes>) {
        if self.done {
            emit(out, chunk);
            return;
        }
        if self.carry.is_empty() || chunk.len() <= SMALL {
            let buf = concat(&std::mem::take(&mut self.carry), &chunk);
            self.scan(buf, out);
            return;
        }
        // A large chunk after a held-back tail: look for a tag that starts
        // in the tail using only the tail and the chunk's first bytes.
        let joint = concat(&self.carry, &chunk[..chunk.len().min(HEAD.len() - 1)]);
        let held = std::mem::take(&mut self.carry);
        match first_tag(&joint) {
            Some(at) if at < held.len() => {
                self.done = true;
                emit(out, held.slice(..at));
                emit(out, self.tag.clone());
                emit(out, held.slice(at..));
                emit(out, chunk);
            }
            _ => {
                emit(out, held);
                self.scan(chunk, out);
            }
        }
    }

    /// The page ended: whatever was held back goes on.
    pub fn finish(&mut self, out: &mut VecDeque<Bytes>) {
        emit(out, std::mem::take(&mut self.carry));
    }
}

/// A page body with the tag inserted as it streams.
struct InsertBody {
    inner: EdgeBody,
    inserter: Inserter,
    queue: VecDeque<Bytes>,
    trailers: Option<Frame<Bytes>>,
    ended: bool,
}

impl Body for InsertBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = &mut *self;
        loop {
            if let Some(b) = this.queue.pop_front() {
                return Poll::Ready(Some(Ok(Frame::data(b))));
            }
            if let Some(t) = this.trailers.take() {
                return Poll::Ready(Some(Ok(t)));
            }
            if this.ended {
                return Poll::Ready(None);
            }
            match ready!(Pin::new(&mut this.inner).poll_frame(cx)) {
                Some(Ok(frame)) => match frame.into_data() {
                    Ok(data) => this.inserter.push(data, &mut this.queue),
                    Err(trailers) => {
                        this.inserter.finish(&mut this.queue);
                        this.trailers = Some(trailers);
                    }
                },
                Some(Err(e)) => return Poll::Ready(Some(Err(e))),
                None => {
                    this.inserter.finish(&mut this.queue);
                    this.ended = true;
                }
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.ended && self.queue.is_empty() && self.trailers.is_none()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

/// `body` with `tag` inserted before its first `</head>` (or `</body>`).
pub fn inserted_body(body: EdgeBody, tag: &str) -> EdgeBody {
    InsertBody {
        inner: body,
        inserter: Inserter::new(tag),
        queue: VecDeque::new(),
        trailers: None,
        ended: false,
    }
    .boxed_unsync()
}

// ---------- decoding

/// A body's data as a stream of byte chunks (trailers dropped).
struct DataStream(EdgeBody);

impl futures_core::Stream for DataStream {
    type Item = io::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            return match ready!(Pin::new(&mut self.0).poll_frame(cx)) {
                None => Poll::Ready(None),
                Some(Err(e)) => Poll::Ready(Some(Err(io::Error::other(e)))),
                Some(Ok(frame)) => match frame.into_data() {
                    Ok(data) if !data.is_empty() => Poll::Ready(Some(Ok(data))),
                    _ => continue,
                },
            };
        }
    }
}

type Reader = Pin<Box<dyn AsyncBufRead + Send>>;

/// `deflate` as Node's fetch reads it: zlib when the first byte's low
/// nibble is 8 (the zlib method), raw deflate otherwise.
enum DeflateAuto {
    Peeking(Option<Reader>),
    Zlib(ZlibDecoder<Reader>),
    Raw(DeflateDecoder<Reader>),
}

impl AsyncRead for DeflateAuto {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            match this {
                DeflateAuto::Peeking(reader) => {
                    let inner = reader.as_mut().expect("present until decided");
                    let first = match ready!(inner.as_mut().poll_fill_buf(cx))? {
                        [] => return Poll::Ready(Ok(())),
                        [b, ..] => *b,
                    };
                    let reader = reader.take().expect("present until decided");
                    *this = if first & 0x0f == 0x08 {
                        DeflateAuto::Zlib(ZlibDecoder::new(reader))
                    } else {
                        DeflateAuto::Raw(DeflateDecoder::new(reader))
                    };
                }
                DeflateAuto::Zlib(d) => return Pin::new(d).poll_read(cx, buf),
                DeflateAuto::Raw(d) => return Pin::new(d).poll_read(cx, buf),
            }
        }
    }
}

/// The most decoded bytes one frame carries.
const FRAME_BYTES: usize = 32 * 1024;

/// Decoded bytes as a body, at most `FRAME_BYTES` per frame, so a page
/// that inflates a lot is still streamed, never held whole.
struct DecodedBody {
    reader: Pin<Box<dyn AsyncRead + Send>>,
    scratch: Box<[u8]>,
    ended: bool,
}

impl Body for DecodedBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = &mut *self;
        if this.ended {
            return Poll::Ready(None);
        }
        let mut buf = ReadBuf::new(&mut this.scratch);
        match ready!(this.reader.as_mut().poll_read(cx, &mut buf)) {
            Ok(()) if buf.filled().is_empty() => {
                this.ended = true;
                Poll::Ready(None)
            }
            Ok(()) => Poll::Ready(Some(Ok(Frame::data(Bytes::copy_from_slice(buf.filled()))))),
            Err(e) => {
                this.ended = true;
                Poll::Ready(Some(Err(format!("decoding the page: {e}").into())))
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.ended
    }
}

fn decoder(reader: Reader, coding: Coding) -> Pin<Box<dyn AsyncRead + Send>> {
    match coding {
        Coding::Gzip => {
            let mut d = GzipDecoder::new(reader);
            d.multiple_members(true);
            Box::pin(d)
        }
        Coding::Deflate => Box::pin(DeflateAuto::Peeking(Some(reader))),
        Coding::Br => Box::pin(BrotliDecoder::new(reader)),
    }
}

/// `body` with `codings` undone (last applied, first undone), streamed.
/// Bad data ends the body with an error, which aborts the answer.
pub fn decoded_body(body: EdgeBody, codings: &[Coding]) -> EdgeBody {
    let source: Reader = Box::pin(StreamReader::new(DataStream(body)));
    let mut undo = codings.iter().rev();
    let reader: Pin<Box<dyn AsyncRead + Send>> = match undo.next() {
        None => Box::pin(source),
        Some(&first) => {
            let mut reader = decoder(source, first);
            for &coding in undo {
                reader = decoder(
                    Box::pin(BufReader::with_capacity(FRAME_BYTES, reader)),
                    coding,
                );
            }
            reader
        }
    };
    DecodedBody {
        reader,
        scratch: vec![0; FRAME_BYTES].into_boxed_slice(),
        ended: false,
    }
    .boxed_unsync()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::full;
    use http::{HeaderName, HeaderValue};
    use http_body_util::{BodyExt, StreamBody};
    use hyper::body::Frame;
    use serde_json::Value;
    use std::io::Write;

    fn run(tag: &str, chunks: &[&[u8]]) -> Vec<u8> {
        let mut ins = Inserter::new(tag);
        let mut out = VecDeque::new();
        for c in chunks {
            ins.push(Bytes::copy_from_slice(c), &mut out);
        }
        ins.finish(&mut out);
        out.into_iter().flat_map(|b| b.to_vec()).collect()
    }

    #[test]
    fn golden_vectors_match_the_typescript_edge() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/golden/inject.json"
        ));
        let cases: Vec<Value> = serde_json::from_str(raw).unwrap();
        assert_eq!(cases.len(), 30);
        for c in &cases {
            let chunks: Vec<&[u8]> = c["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().as_bytes())
                .collect();
            let got = run(c["tag"].as_str().unwrap(), &chunks);
            assert_eq!(
                String::from_utf8(got).unwrap(),
                c["output"].as_str().unwrap(),
                "{}",
                c["name"]
            );
        }
    }

    #[test]
    fn every_split_of_a_page_gives_the_same_output() {
        let page = b"<!doctype html><html><HeAd><title>x</title></hEaD><body>y</body></html>";
        let want = run("<T>", &[page]);
        assert_eq!(
            want,
            b"<!doctype html><html><HeAd><title>x</title><T></hEaD><body>y</body></html>"
        );
        for i in 0..=page.len() {
            for j in i..=page.len() {
                let got = run("<T>", &[&page[..i], &page[i..j], &page[j..]]);
                assert_eq!(got, want, "split at {i}, {j}");
            }
        }
        // A large chunk after a held tail.
        let big = [b"ead>".as_slice(), &[b'z'; 300]].concat();
        let got = run("<T>", &[b"<p></h", &big]);
        assert_eq!(got, [b"<p><T></head>".as_slice(), &[b'z'; 300]].concat());
    }

    #[test]
    fn the_tag_escapes_its_attributes() {
        assert_eq!(
            insights_tag("env_a", "dep\"1<&>", 50),
            "<script defer src=\"/_nbo/insights/v1/script.js\" data-e=\"env_a\" data-d=\"dep&quot;1&lt;&amp;&gt;\" data-s=\"50\"></script>"
        );
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn page_takes_tag_needs_html_in_an_ascii_compatible_charset_without_no_transform() {
        let yes = [
            "text/html",
            "TEXT/HTML ; charset=UTF-8",
            "text/html; charset=\"utf-8\"",
            "text/html; charset=iso-8859-1",
            "text/html; charset=ISO_8859-15",
            "text/html; charset=windows-1252",
            "text/html; charset=latin1",
            "text/html; charset=us-ascii",
            "text/html; foo=bar; charset=cp1251",
        ];
        for ct in yes {
            assert!(page_takes_tag(&headers(&[("content-type", ct)])), "{ct}");
        }
        let no = [
            "",
            "text/plain",
            "application/xhtml+xml",
            "text/html; charset=utf-16",
            "text/html; charset=shift_jis",
            "text/html; charset=",
            "text/html; charset=iso-8859-123",
        ];
        for ct in no {
            assert!(!page_takes_tag(&headers(&[("content-type", ct)])), "{ct}");
        }
        assert!(!page_takes_tag(&headers(&[])));
        for cc in [
            "no-transform",
            "public, No-Transform",
            "no-transform , max-age=1",
        ] {
            assert!(
                !page_takes_tag(&headers(&[
                    ("content-type", "text/html"),
                    ("cache-control", cc)
                ])),
                "{cc}"
            );
        }
        assert!(page_takes_tag(&headers(&[
            ("content-type", "text/html"),
            ("cache-control", "no-transformx, max-age=1")
        ])));
    }

    #[test]
    fn page_encoding_decodes_only_known_codings() {
        let enc = |v: &str| page_encoding(&headers(&[("content-encoding", v)]));
        assert_eq!(page_encoding(&headers(&[])), PageEncoding::Plain);
        assert_eq!(enc(""), PageEncoding::Plain);
        assert_eq!(enc(" Identity "), PageEncoding::Plain);
        assert_eq!(enc("gzip"), PageEncoding::Decode(vec![Coding::Gzip]));
        assert_eq!(enc("X-Gzip"), PageEncoding::Decode(vec![Coding::Gzip]));
        assert_eq!(enc("deflate"), PageEncoding::Decode(vec![Coding::Deflate]));
        assert_eq!(enc("br"), PageEncoding::Decode(vec![Coding::Br]));
        assert_eq!(
            enc("gzip, br"),
            PageEncoding::Decode(vec![Coding::Gzip, Coding::Br])
        );
        // zstd is not decoded here (no zstd decoder in the crate): such a
        // page passes through without the tag.
        assert_eq!(enc("zstd"), PageEncoding::Opaque);
        assert_eq!(enc("gzip, zstd"), PageEncoding::Opaque);
        assert_eq!(enc("compress"), PageEncoding::Opaque);
        assert_eq!(enc("gzip, identity"), PageEncoding::Opaque);
        assert_eq!(enc("gzip,"), PageEncoding::Opaque);
    }

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn raw_deflate(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn brotli(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut w = brotli::CompressorWriter::new(&mut out, 4096, 5, 22);
            w.write_all(data).unwrap();
        }
        out
    }

    // A body that hands over `data` in pieces of `size` bytes.
    fn chunked(data: Vec<u8>, size: usize) -> EdgeBody {
        let frames: Vec<Result<Frame<Bytes>, crate::proxy::BoxError>> = data
            .chunks(size)
            .map(|c| Ok(Frame::data(Bytes::copy_from_slice(c))))
            .collect();
        StreamBody::new(futures_util_iter(frames)).boxed_unsync()
    }

    fn futures_util_iter<T>(items: Vec<T>) -> impl futures_core::Stream<Item = T> {
        struct Iter<T>(std::vec::IntoIter<T>);
        impl<T> futures_core::Stream for Iter<T> {
            type Item = T;
            fn poll_next(
                mut self: std::pin::Pin<&mut Self>,
                _cx: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Option<T>> {
                std::task::Poll::Ready(self.0.next())
            }
        }
        impl<T> Unpin for Iter<T> {}
        Iter(items.into_iter())
    }

    async fn collect(body: EdgeBody) -> Result<Vec<u8>, String> {
        body.collect()
            .await
            .map(|c| c.to_bytes().to_vec())
            .map_err(|e| e.to_string())
    }

    const PAGE: &[u8] = b"<html><head><title>z</title></head><body>compressed</body></html>";

    #[tokio::test]
    async fn decodes_gzip_deflate_br_and_stacked_codings_in_any_chunking() {
        let cases: Vec<(Vec<Coding>, Vec<u8>)> = vec![
            (vec![Coding::Gzip], gzip(PAGE)),
            (vec![Coding::Deflate], zlib(PAGE)),
            (vec![Coding::Deflate], raw_deflate(PAGE)),
            (vec![Coding::Br], brotli(PAGE)),
            // "gzip, br": gzip applied first, then brotli.
            (vec![Coding::Gzip, Coding::Br], brotli(&gzip(PAGE))),
            // Two gzip members, as gunzip reads them.
            (
                vec![Coding::Gzip],
                [gzip(b"<html><head>"), gzip(b"</head></html>")].concat(),
            ),
        ];
        for (i, (codings, data)) in cases.into_iter().enumerate() {
            for size in [1, 7, 4096] {
                let got = collect(decoded_body(chunked(data.clone(), size), &codings))
                    .await
                    .unwrap();
                let want: &[u8] = if i == 5 {
                    b"<html><head></head></html>"
                } else {
                    PAGE
                };
                assert_eq!(got, want, "case {i}, chunks of {size}");
            }
        }
    }

    #[tokio::test]
    async fn a_large_page_decodes_in_bounded_frames() {
        let page: Vec<u8> = (0..2_000_000u32)
            .map(|i| b"abcdefgh"[(i % 8) as usize])
            .collect();
        let mut body = decoded_body(full(gzip(&page)), &[Coding::Gzip]);
        let mut total = 0;
        while let Some(frame) = body.frame().await {
            let data = frame.unwrap().into_data().unwrap();
            assert!(data.len() <= 64 * 1024, "frame of {}", data.len());
            total += data.len();
        }
        assert_eq!(total, page.len());
    }

    #[tokio::test]
    async fn corrupt_data_fails_the_body() {
        assert!(
            collect(decoded_body(full(&b"not gzip at all"[..]), &[Coding::Gzip]))
                .await
                .is_err()
        );
        assert!(
            collect(decoded_body(full(&b"\xff\xff\xff"[..]), &[Coding::Br]))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn inserts_into_a_decoded_page() {
        let body = inserted_body(decoded_body(chunked(brotli(PAGE), 5), &[Coding::Br]), "<T>");
        assert_eq!(
            collect(body).await.unwrap(),
            b"<html><head><title>z</title><T></head><body>compressed</body></html>"
        );
    }
}
