// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Telling a page load from everything else. Port of
//! `packages/edge/src/navigation.ts`.

use http::HeaderMap;

use crate::text::{header_joined, is_js_space, js_trim};

/// Whether the request is the browser loading a page (not a script's
/// `fetch()`, an image or another asset): `Sec-Fetch-Dest` says
/// `document`, or, from a browser that sends no `Sec-Fetch-Dest`, `Accept`
/// asks for `text/html`. The edge sets its visitor cookie and inserts the
/// Speed Insights tag only on these.
pub fn is_document_navigation(headers: &HeaderMap) -> bool {
    if let Some(dest) = header_joined(headers, "sec-fetch-dest", ", ") {
        return js_trim(&dest).to_lowercase() == "document";
    }
    accepts_html(&header_joined(headers, "accept", ", ").unwrap_or_default())
}

/// `/(^|,)\s*text\/html\s*(;|,|$)/i`: some list item of `accept` is
/// `text/html`, optionally with parameters.
fn accepts_html(accept: &str) -> bool {
    std::iter::once(accept)
        .chain(accept.match_indices(',').map(|(i, _)| &accept[i + 1..]))
        .any(|item| {
            let item = item.trim_start_matches(is_js_space);
            let Some(head) = item.get(..9) else {
                return false;
            };
            if !head.eq_ignore_ascii_case("text/html") {
                return false;
            }
            let rest = item[9..].trim_start_matches(is_js_space);
            rest.is_empty() || rest.starts_with(';') || rest.starts_with(',')
        })
}

/// The scheme the visitor used to reach the edge: the edge's own (`own_https`),
/// or what a TLS terminator in front of it says in `X-Forwarded-Proto` or
/// `Forwarded` (the first hop of each). Returns `"https"` or `"http"`.
pub fn visitor_scheme(own_https: bool, headers: &HeaderMap) -> &'static str {
    if own_https {
        return "https";
    }
    let xfp = header_joined(headers, "x-forwarded-proto", ", ").unwrap_or_default();
    let first = xfp.split(',').next().unwrap_or("");
    if js_trim(first).to_lowercase() == "https" {
        return "https";
    }
    let forwarded = header_joined(headers, "forwarded", ", ").unwrap_or_default();
    let first = forwarded.split(',').next().unwrap_or("");
    for pair in first.split(';') {
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        if js_trim(name).to_lowercase() != "proto" {
            continue;
        }
        let value = js_trim(value);
        let value = value.strip_prefix('"').unwrap_or(value);
        let value = value.strip_suffix('"').unwrap_or(value);
        if value.to_lowercase() == "https" {
            return "https";
        }
    }
    "http"
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn sec_fetch_dest_decides_when_present() {
        assert!(is_document_navigation(&headers(&[(
            "sec-fetch-dest",
            " Document "
        )])));
        assert!(!is_document_navigation(&headers(&[
            ("sec-fetch-dest", "empty"),
            ("accept", "text/html")
        ])));
        assert!(!is_document_navigation(&headers(&[
            ("sec-fetch-dest", ""),
            ("accept", "text/html")
        ])));
    }

    #[test]
    fn accept_text_html_without_sec_fetch_dest() {
        let yes = [
            "text/html",
            "TEXT/HTML",
            "text/html,application/xhtml+xml",
            "application/xhtml+xml, text/html ;q=0.9",
            "image/png,text/html",
            "a/b,\ttext/html\t,c/d",
        ];
        for a in yes {
            assert!(is_document_navigation(&headers(&[("accept", a)])), "{a}");
        }
        let no = [
            "",
            "*/*",
            "text/htmlx",
            "xtext/html",
            "application/json",
            "text/html-x",
        ];
        for a in no {
            assert!(!is_document_navigation(&headers(&[("accept", a)])), "{a}");
        }
        assert!(!is_document_navigation(&HeaderMap::new()));
        // several Accept headers read as one list
        assert!(is_document_navigation(&headers(&[
            ("accept", "image/png"),
            ("accept", "text/html")
        ])));
    }

    #[test]
    fn visitor_scheme_reads_own_scheme_then_forwarding_headers() {
        assert_eq!(visitor_scheme(true, &HeaderMap::new()), "https");
        assert_eq!(visitor_scheme(false, &HeaderMap::new()), "http");
        assert_eq!(
            visitor_scheme(false, &headers(&[("x-forwarded-proto", " HTTPS , http")])),
            "https"
        );
        assert_eq!(
            visitor_scheme(false, &headers(&[("x-forwarded-proto", "http, https")])),
            "http"
        );
        assert_eq!(
            visitor_scheme(
                false,
                &headers(&[("forwarded", "for=1.2.3.4; Proto=\"https\"")])
            ),
            "https"
        );
        assert_eq!(
            visitor_scheme(false, &headers(&[("forwarded", "proto=http, proto=https")])),
            "http"
        );
        assert_eq!(
            visitor_scheme(false, &headers(&[("forwarded", "proto")])),
            "http"
        );
    }
}
