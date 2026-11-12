// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Reducing a URL to a route: path only (no query, no hash), with segments
//! that look like ids or personal data collapsed to `[id]`. Port of
//! `packages/edge/src/insights/route.ts`. Rust's `regex` has no lookahead
//! and its `\d` is Unicode, so the patterns are written as code; every
//! digit and letter class here is ASCII only, as in JavaScript.

pub const MAX_ROUTE_LENGTH: usize = 200;

/// The id patterns as the TypeScript edge's `ID_PATTERNS` writes them
/// (JavaScript source and flags). The browser loader is built from these
/// (`script.rs`); `is_id_segment` below is the same rules as code.
pub const ID_PATTERN_SOURCES: [(&str, &str); 5] = [
    (r"^\d+$", ""),
    (
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        "i",
    ),
    (r"^[0-9a-f]{16,}$", "i"),
    (r"^(?=.*\d)[A-Za-z0-9_.~%+=-]{20,}$", ""),
    ("@", ""),
];

/// Whether a path segment looks like an id or personal data: all ASCII
/// digits; a UUID; 16+ hex characters; a 20+ character token of
/// `[A-Za-z0-9_.~%+=-]` with at least one digit; or anything with an `@`.
pub fn is_id_segment(segment: &str) -> bool {
    is_digits(segment)
        || is_uuid(segment)
        || is_long_hex(segment)
        || is_token(segment)
        || segment.contains('@')
}

// ^\d+$
fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit())
}

// ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ (case-insensitive)
fn is_uuid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|c| c.is_ascii_hexdigit()))
}

// ^[0-9a-f]{16,}$ (case-insensitive)
fn is_long_hex(s: &str) -> bool {
    s.len() >= 16 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

// ^(?=.*\d)[A-Za-z0-9_.~%+=-]{20,}$: a token has a digit; a long readable
// slug ("how-to-deploy-on-kubernetes") does not and is kept.
fn is_token(s: &str) -> bool {
    s.len() >= 20
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.~%+=-".contains(&c))
        && s.bytes().any(|c| c.is_ascii_digit())
}

/// The route for a path, or `None` when the input is not a path.
pub fn normalize_route(path: &str) -> Option<String> {
    let p = match path.find(['?', '#']) {
        Some(cut) => &path[..cut],
        None => path,
    };
    if !p.starts_with('/') || p.starts_with("//") {
        return None;
    }
    let segments: Vec<&str> = p
        .split('/')
        .map(|s| {
            if !s.is_empty() && is_id_segment(s) {
                "[id]"
            } else {
                s
            }
        })
        .collect();
    Some(segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn golden_vectors_match_the_typescript_edge() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/golden/routes.json"
        ));
        let cases: Vec<Value> = serde_json::from_str(raw).unwrap();
        assert_eq!(cases.len(), 100);
        for c in &cases {
            let path = c["path"].as_str().unwrap();
            let want = c["route"].as_str();
            assert_eq!(normalize_route(path).as_deref(), want, "{path:?}");
        }
    }

    #[test]
    fn keeps_plain_paths() {
        assert_eq!(normalize_route("/").as_deref(), Some("/"));
        assert_eq!(
            normalize_route("/blog/hello-world").as_deref(),
            Some("/blog/hello-world")
        );
        assert_eq!(normalize_route("/docs/").as_deref(), Some("/docs/"));
    }

    #[test]
    fn drops_the_query_and_hash() {
        assert_eq!(
            normalize_route("/search?q=secret#top").as_deref(),
            Some("/search")
        );
    }

    #[test]
    fn collapses_digits_uuids_long_hex_and_tokens() {
        assert_eq!(
            normalize_route("/users/12345/posts/7").as_deref(),
            Some("/users/[id]/posts/[id]")
        );
        assert_eq!(
            normalize_route("/o/3f2504e0-4f89-11d3-9a0c-0305e82c3301").as_deref(),
            Some("/o/[id]")
        );
        assert_eq!(
            normalize_route("/c/deadbeefcafebabe1234").as_deref(),
            Some("/c/[id]")
        );
        assert_eq!(
            normalize_route("/reset/aZ9_kQ2xLm8PpR4tYv0Wn").as_deref(),
            Some("/reset/[id]")
        );
    }

    #[test]
    fn collapses_email_like_segments() {
        assert_eq!(
            normalize_route("/u/jane@example.com").as_deref(),
            Some("/u/[id]")
        );
    }

    #[test]
    fn keeps_long_readable_slugs_without_digits() {
        assert_eq!(
            normalize_route("/blog/how-to-deploy-on-kubernetes").as_deref(),
            Some("/blog/how-to-deploy-on-kubernetes")
        );
    }

    #[test]
    fn none_for_something_that_is_not_a_path() {
        assert_eq!(normalize_route(""), None);
        assert_eq!(normalize_route("https://evil/x"), None);
        assert_eq!(normalize_route("//evil/x"), None);
    }

    #[test]
    fn digit_classes_are_ascii_only() {
        assert!(!is_id_segment("\u{661}\u{662}\u{663}"));
        assert!(!is_id_segment("\u{ff11}\u{ff12}"));
        assert!(is_id_segment("0"));
        assert!(!is_id_segment(""));
    }
}
