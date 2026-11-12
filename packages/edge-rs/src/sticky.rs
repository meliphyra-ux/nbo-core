// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Keeping a visitor on one cloud. Port of `packages/edge/src/sticky.ts`.
//!
//! Each visitor carries a random id in a cookie. The backend that serves
//! them is chosen by weighted rendezvous hashing: every backend scores the
//! visitor id (a hash of id and the backend's stable key, scaled by its
//! weight) and the best score wins. The same visitor gets the same backend
//! while the split holds, on every edge replica; a weight change moves a
//! visitor only to a backend whose share grew. The hash and score match
//! the TypeScript edge bit for bit, so upgrading the edge moves nobody.

use http::header::COOKIE;
use http::{HeaderMap, HeaderValue};
use sha2::{Digest, Sha256};

use crate::jsmath;
use crate::registry::{Backend, Target};
use crate::text::{header_joined, js_trim, latin1_bytes, quote};

pub const VISITOR_COOKIE: &str = "nbo_v";

/// A week: long enough that a returning visitor keeps their cloud.
pub const VISITOR_COOKIE_MAX_AGE_SEC: u64 = 7 * 24 * 60 * 60;

/// A new visitor id: 16 random bytes as 32 lowercase hex characters.
pub fn new_visitor_id() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_visitor_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

// The Cookie header as one string. HTTP/2 may send several Cookie fields;
// they join with "; " (RFC 9113 section 8.2.3).
fn cookie_header(headers: &HeaderMap) -> Option<String> {
    header_joined(headers, COOKIE.as_str(), "; ")
}

/// The first valid visitor id (exactly 32 lowercase hex characters) in the
/// Cookie header, or `None`. A malformed one does not hide a valid one
/// later in the header.
pub fn read_visitor_id(headers: &HeaderMap) -> Option<String> {
    let raw = cookie_header(headers)?;
    for part in raw.split(';') {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        if js_trim(name) != VISITOR_COOKIE {
            continue;
        }
        let value = js_trim(value);
        if is_visitor_id(value) {
            return Some(value.to_string());
        }
    }
    None
}

/// The `Set-Cookie` value for a visitor id.
pub fn visitor_cookie(id: &str, secure: bool) -> String {
    format!(
        "{VISITOR_COOKIE}={id}; Path=/; Max-Age={VISITOR_COOKIE_MAX_AGE_SEC}; HttpOnly; SameSite=Lax{}",
        if secure { "; Secure" } else { "" }
    )
}

/// Removes the edge's own cookie from the Cookie header, so the app never
/// sees it. A header left empty is dropped.
pub fn strip_visitor_cookie(headers: &mut HeaderMap) {
    let Some(raw) = cookie_header(headers) else {
        return;
    };
    let kept: Vec<&str> = raw
        .split(';')
        .map(js_trim)
        .filter(|p| {
            let name = p.split_once('=').map_or(*p, |(name, _)| name);
            !p.is_empty() && js_trim(name) != VISITOR_COOKIE
        })
        .collect();
    headers.remove(COOKIE);
    if !kept.is_empty() {
        // Every byte came from a header value, so it is valid in one again.
        if let Ok(value) = HeaderValue::from_bytes(&latin1_bytes(&kept.join("; "))) {
            headers.insert(COOKIE, value);
        }
    }
}

/// Maps (visitor id, backend key) to a number strictly between 0 and 1,
/// uniformly: sha256(id \0 key), its first 52 bits (20 of the first
/// big-endian word, all of the second), plus a half, over 2^52.
pub fn unit_hash(visitor_id: &str, key: &str) -> f64 {
    let mut hasher = Sha256::new();
    hasher.update(visitor_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(key.as_bytes());
    let digest = hasher.finalize();
    let hi = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) & 0xfffff;
    let lo = u32::from_be_bytes([digest[4], digest[5], digest[6], digest[7]]);
    let n = (u64::from(hi) << 32) | u64::from(lo);
    // n < 2^52, so n and n + 0.5 are exact as f64, as in JavaScript.
    (n as f64 + 0.5) / 4_503_599_627_370_496.0
}

/// Chooses the visitor's backend: the lowest `-ln(u) / weight` wins.
/// Weight 0 never wins. The key is the backend's id, or its URL.
pub fn pick_sticky<'a>(target: &'a Target, visitor_id: &str) -> Result<&'a Backend, String> {
    let mut best: Option<&Backend> = None;
    let mut best_score = f64::INFINITY;
    for b in &target.backends {
        if b.weight <= 0 {
            continue;
        }
        let key = b.id.as_deref().unwrap_or(&b.url);
        let score = -jsmath::log(unit_hash(visitor_id, key)) / b.weight as f64;
        if score < best_score {
            best_score = score;
            best = Some(b);
        }
    }
    best.ok_or_else(|| {
        format!(
            "edge: target {} has no pickable backend",
            quote(&target.host)
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::HashMap;

    fn target(backends: &[(&str, i64)]) -> Target {
        Target::new(
            "app.example",
            backends
                .iter()
                .map(|(id, weight)| Backend {
                    id: Some(id.to_string()),
                    url: format!("http://{id}.internal"),
                    weight: *weight,
                    insecure_skip_verify: false,
                    via: None,
                })
                .collect(),
        )
    }

    fn ids(n: usize) -> Vec<String> {
        (0..n).map(|_| new_visitor_id()).collect()
    }

    fn picked(t: &Target, v: &str) -> String {
        pick_sticky(t, v).unwrap().id.clone().unwrap()
    }

    #[test]
    fn golden_vectors_match_the_typescript_edge() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/golden/sticky.json"
        ));
        let cases: Vec<Value> = serde_json::from_str(raw).unwrap();
        assert_eq!(cases.len(), 200);
        let mut errors = 0;
        for c in &cases {
            let backends = c["backends"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| Backend {
                    id: b.get("id").and_then(Value::as_str).map(str::to_string),
                    url: b["url"].as_str().unwrap().to_string(),
                    weight: b["weight"].as_i64().unwrap(),
                    insecure_skip_verify: false,
                    via: None,
                })
                .collect();
            let t = Target::new("golden.test", backends);
            let visitor = c["visitorId"].as_str().unwrap();
            match (pick_sticky(&t, visitor), c.get("error")) {
                (Err(e), Some(want)) => {
                    assert_eq!(e, want.as_str().unwrap());
                    errors += 1;
                }
                (Ok(b), None) => {
                    let index = t.backends.iter().position(|x| std::ptr::eq(x, b)).unwrap();
                    assert_eq!(index as u64, c["pick"].as_u64().unwrap(), "{c}");
                    assert_eq!(b.url, c["url"].as_str().unwrap(), "{c}");
                }
                (got, _) => panic!("case {c}: got {got:?}"),
            }
        }
        assert_eq!(errors, 2);
    }

    #[test]
    fn unit_hash_is_strictly_between_0_and_1() {
        for v in ids(1000) {
            let u = unit_hash(&v, "k");
            assert!(u > 0.0 && u < 1.0);
        }
    }

    #[test]
    fn is_deterministic_for_the_same_split() {
        let t = target(&[("k8s", 70), ("cloudrun", 30)]);
        for v in ids(200) {
            let first = picked(&t, &v);
            for _ in 0..5 {
                assert_eq!(picked(&t, &v), first);
            }
        }
    }

    #[test]
    fn honours_the_weights_across_many_visitors() {
        let t = target(&[("k8s", 70), ("cloudrun", 30)]);
        let mut counts: HashMap<String, usize> = HashMap::new();
        for v in ids(20_000) {
            *counts.entry(picked(&t, &v)).or_default() += 1;
        }
        let share = counts["k8s"] as f64 / 20_000.0;
        assert!(share > 0.67 && share < 0.73, "{share}");
    }

    #[test]
    fn never_picks_a_backend_with_weight_0() {
        let t = target(&[("k8s", 100), ("cloudrun", 0)]);
        for v in ids(2_000) {
            assert_eq!(picked(&t, &v), "k8s");
        }
    }

    #[test]
    fn a_70_30_to_50_50_change_moves_only_toward_the_gainer() {
        let before = target(&[("k8s", 70), ("cloudrun", 30)]);
        let after = target(&[("k8s", 50), ("cloudrun", 50)]);
        let mut moved = 0;
        for v in ids(20_000) {
            let (a, b) = (picked(&before, &v), picked(&after, &v));
            if a != b {
                moved += 1;
                assert_eq!((a.as_str(), b.as_str()), ("k8s", "cloudrun"));
            }
        }
        let share = moved as f64 / 20_000.0;
        assert!(share > 0.17 && share < 0.23, "{share}");
    }

    #[test]
    fn a_proportional_transfer_moves_visitors_only_to_the_target() {
        let steps = [
            target(&[("a", 60), ("b", 40), ("c", 0)]),
            target(&[("a", 57), ("b", 38), ("c", 5)]),
            target(&[("a", 54), ("b", 36), ("c", 10)]),
            target(&[("a", 30), ("b", 20), ("c", 50)]),
            target(&[("a", 0), ("b", 0), ("c", 100)]),
        ];
        for v in ids(5_000) {
            let mut prev = picked(&steps[0], &v);
            for step in &steps[1..] {
                let next = picked(step, &v);
                if next != prev {
                    assert_eq!(next, "c");
                }
                prev = next;
            }
        }
    }

    #[test]
    fn does_not_depend_on_backend_order() {
        let a = target(&[("k8s", 70), ("cloudrun", 30)]);
        let b = target(&[("cloudrun", 30), ("k8s", 70)]);
        for v in ids(500) {
            assert_eq!(picked(&a, &v), picked(&b, &v));
        }
    }

    #[test]
    fn errors_when_nothing_is_pickable() {
        let t = target(&[("z", 0)]);
        assert_eq!(
            pick_sticky(&t, &new_visitor_id()).unwrap_err(),
            "edge: target \"app.example\" has no pickable backend"
        );
    }

    // cookie

    fn cookie_headers(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(COOKIE, HeaderValue::from_str(value).unwrap());
        h
    }

    #[test]
    fn new_visitor_id_is_32_lowercase_hex_and_random() {
        let a = new_visitor_id();
        assert_eq!(a.len(), 32);
        assert!(
            a.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        );
        assert_ne!(new_visitor_id(), a);
    }

    #[test]
    fn read_visitor_id_finds_a_valid_id_and_rejects_malformed_ones() {
        let id = new_visitor_id();
        assert_eq!(
            read_visitor_id(&cookie_headers(&format!("theme=dark; nbo_v={id}; x=1"))),
            Some(id.clone())
        );
        assert_eq!(read_visitor_id(&cookie_headers("nbo_v=not-hex")), None);
        assert_eq!(
            read_visitor_id(&cookie_headers(&format!("nbo_v={id}extra"))),
            None
        );
        assert_eq!(
            read_visitor_id(&cookie_headers(&format!("nbo_v={}", id.to_uppercase()))),
            None
        );
        assert_eq!(read_visitor_id(&HeaderMap::new()), None);
        assert_eq!(
            read_visitor_id(&cookie_headers(&format!("nbo_v=bad; nbo_v={id}"))),
            Some(id.clone())
        );
        // HTTP/2 may split cookies over several headers.
        let mut split = cookie_headers("theme=dark");
        split.append(
            COOKIE,
            HeaderValue::from_str(&format!("nbo_v={id}")).unwrap(),
        );
        assert_eq!(read_visitor_id(&split), Some(id));
    }

    #[test]
    fn visitor_cookie_attributes() {
        let id = new_visitor_id();
        assert_eq!(
            visitor_cookie(&id, false),
            format!("nbo_v={id}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax")
        );
        assert_eq!(
            visitor_cookie(&id, true),
            format!("nbo_v={id}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure")
        );
    }

    #[test]
    fn strip_visitor_cookie_removes_only_the_edge_cookie() {
        let id = new_visitor_id();
        let mut h = cookie_headers(&format!("theme=dark; nbo_v={id}; x=1"));
        strip_visitor_cookie(&mut h);
        assert_eq!(h.get(COOKIE).unwrap(), "theme=dark; x=1");
        let mut only = cookie_headers(&format!("nbo_v={id}"));
        strip_visitor_cookie(&mut only);
        assert!(!only.contains_key(COOKIE));
        let mut none = HeaderMap::new();
        strip_visitor_cookie(&mut none);
        assert!(none.is_empty());
        let mut flag = cookie_headers(" a ;; nbo_v ;b=1");
        strip_visitor_cookie(&mut flag);
        assert_eq!(flag.get(COOKIE).unwrap(), "a; b=1");
    }
}
