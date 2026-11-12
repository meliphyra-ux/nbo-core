// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! The public edge's whole configuration, replaced atomically. Strict
//! parsing: unknown fields are refused, and every error names the first
//! bad field with the same text as `packages/edge/src/route-table.ts`.

use std::collections::HashSet;
use std::net::IpAddr;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::registry::{
    Backend, InsightsSettings, RelayVia, TargetConfig, is_url_with_scheme, normalize_host,
};
use crate::text::quote;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RouteTable {
    /// Keyed by normalised host, in document order.
    pub targets: IndexMap<String, TargetConfig>,
    /// ACME HTTP-01 answers by token.
    pub challenges: IndexMap<String, String>,
    /// The addresses Cloudflare connects from (IPv4 and IPv6 CIDRs).
    pub cloudflare_ranges: Option<Vec<String>>,
}

/// An `insights` object that is not valid settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidInsights;

/// Parses an `insights` object; `None` (absent) passes through as
/// `Ok(None)`.
pub fn parse_insights_settings(
    raw: Option<&Value>,
) -> Result<Option<InsightsSettings>, InvalidInsights> {
    let Some(raw) = raw else { return Ok(None) };
    let obj = raw.as_object().ok_or(InvalidInsights)?;
    if !has_only_keys(obj, &["enabled", "inject", "sampleRate"]) {
        return Err(InvalidInsights);
    }
    let enabled = obj
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or(InvalidInsights)?;
    let inject = obj
        .get("inject")
        .and_then(Value::as_bool)
        .ok_or(InvalidInsights)?;
    let rate = obj
        .get("sampleRate")
        .and_then(Value::as_f64)
        .ok_or(InvalidInsights)?;
    let sample_rate = [100u8, 50, 25, 10]
        .into_iter()
        .find(|r| f64::from(*r) == rate)
        .ok_or(InvalidInsights)?;
    Ok(Some(InsightsSettings {
        enabled,
        inject,
        sample_rate,
    }))
}

/// Whether every key of `obj` is in `allowed`.
pub fn has_only_keys(obj: &Map<String, Value>, allowed: &[&str]) -> bool {
    obj.keys().all(|k| allowed.contains(&k.as_str()))
}

/// A JSON number that JavaScript's `Number.isInteger` accepts, as `i64`.
/// Integral values beyond the `i64` range are refused (JavaScript would
/// take them; no real weight is that large).
fn as_integer(v: &Value) -> Option<i64> {
    if let Some(i) = v.as_i64() {
        return Some(i);
    }
    let f = v.as_f64()?;
    // -2^63 is exact as f64; 2^63 is the first value past i64::MAX.
    if f.fract() == 0.0 && (-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0).contains(&f)
    {
        Some(f as i64)
    } else {
        None
    }
}

const BACKEND_KEYS: &[&str] = &["id", "url", "weight", "insecureSkipVerify"];
const BACKEND_KEYS_WITH_VIA: &[&str] = &["id", "url", "weight", "insecureSkipVerify", "via"];

fn parse_via(raw: &Value) -> Option<RelayVia> {
    let obj = raw.as_object()?;
    if !has_only_keys(obj, &["url", "caPem", "token"]) {
        return None;
    }
    let url = obj.get("url")?.as_str()?;
    let ca_pem = obj.get("caPem")?.as_str()?;
    let token = obj.get("token")?.as_str()?;
    if ca_pem.is_empty() || token.is_empty() || !is_url_with_scheme(url, &["https"]) {
        return None;
    }
    Some(RelayVia {
        url: url.to_string(),
        ca_pem: ca_pem.to_string(),
        token: token.to_string(),
    })
}

/// The one backend validator, shared by the admin API (no `via`) and the
/// route table (`via` allowed). `None` when invalid. A backend's `id` is
/// added to `seen_ids`, which must not already hold it.
pub fn parse_backend(
    raw: &Value,
    allow_via: bool,
    seen_ids: &mut HashSet<String>,
) -> Option<Backend> {
    let obj = raw.as_object()?;
    if !has_only_keys(
        obj,
        if allow_via {
            BACKEND_KEYS_WITH_VIA
        } else {
            BACKEND_KEYS
        },
    ) {
        return None;
    }
    let url = obj.get("url")?.as_str()?;
    let weight = as_integer(obj.get("weight")?)?;
    // A real JSON boolean only: the string "false" must not turn into true.
    let insecure_skip_verify = match obj.get("insecureSkipVerify") {
        None => false,
        Some(v) => v.as_bool()?,
    };
    // id: the stable key for sticky visitors, non-empty and unique within the target.
    let id = match obj.get("id") {
        None => None,
        Some(v) => {
            let id = v.as_str()?;
            if id.is_empty() || seen_ids.contains(id) {
                return None;
            }
            Some(id.to_string())
        }
    };
    let via = match obj.get("via") {
        None => None,
        Some(v) => Some(parse_via(v)?),
    };
    if let Some(id) = &id {
        seen_ids.insert(id.clone());
    }
    Some(Backend {
        id,
        url: url.to_string(),
        weight,
        insecure_skip_verify,
        via,
    })
}

const TABLE_KEYS: &[&str] = &["version", "targets", "challenges", "cloudflareRanges"];
const TARGET_KEYS: &[&str] = &["backends", "insights", "tls", "redirectHttps", "cloudflare"];

/// `^[A-Za-z0-9_-]{1,128}$`
fn is_challenge_token(token: &str) -> bool {
    (1..=128).contains(&token.len())
        && token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// Parses and validates a route table document.
pub fn parse_route_table(json: &str) -> Result<RouteTable, String> {
    let doc: Value =
        serde_json::from_str(json).map_err(|e| format!("route table: invalid JSON: {e}"))?;
    let doc = doc.as_object().ok_or("route table: must be an object")?;
    for k in doc.keys() {
        if !TABLE_KEYS.contains(&k.as_str()) {
            return Err(format!("route table: unknown field {}", quote(k)));
        }
    }
    if doc.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Err("route table: version must be 1".to_string());
    }
    let raw_targets = doc
        .get("targets")
        .and_then(Value::as_object)
        .ok_or("route table: targets must be an object")?;
    let mut targets = IndexMap::with_capacity(raw_targets.len());
    for (raw_host, raw_target) in raw_targets {
        let at = format!("targets[{}]", quote(raw_host));
        let host = normalize_host(raw_host);
        if host.is_empty() {
            return Err(format!("route table: {at} has an empty host"));
        }
        if targets.contains_key(&host) {
            return Err(format!(
                "route table: {at} duplicates host {}",
                quote(&host)
            ));
        }
        let raw_target = raw_target
            .as_object()
            .ok_or_else(|| format!("route table: {at} must be an object"))?;
        for k in raw_target.keys() {
            if !TARGET_KEYS.contains(&k.as_str()) {
                return Err(format!("route table: {at} has unknown field {}", quote(k)));
            }
        }
        let raw_backends = raw_target
            .get("backends")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("route table: {at}.backends must be an array"))?;
        let mut seen_ids = HashSet::new();
        let mut backends = Vec::with_capacity(raw_backends.len());
        for (i, raw_backend) in raw_backends.iter().enumerate() {
            let b = parse_backend(raw_backend, true, &mut seen_ids)
                .ok_or_else(|| format!("route table: {at}.backends[{i}] is invalid"))?;
            backends.push(b);
        }
        let insights = parse_insights_settings(raw_target.get("insights"))
            .map_err(|_| format!("route table: {at}.insights is invalid"))?;
        let tls = match raw_target.get("tls") {
            None => None,
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            Some(_) => return Err(format!("route table: {at}.tls must be a non-empty string")),
        };
        let flag = |name: &str| match raw_target.get(name) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(format!("route table: {at}.{name} must be a boolean")),
        };
        let redirect_https = flag("redirectHttps")?;
        let cloudflare = flag("cloudflare")?;
        targets.insert(
            host,
            TargetConfig {
                backends,
                insights,
                tls,
                redirect_https,
                cloudflare,
            },
        );
    }
    let mut challenges = IndexMap::new();
    if let Some(raw) = doc.get("challenges") {
        let raw = raw
            .as_object()
            .ok_or("route table: challenges must be an object")?;
        for (token, value) in raw {
            if !is_challenge_token(token) {
                return Err(format!(
                    "route table: challenges token {} is invalid",
                    quote(token)
                ));
            }
            let value = value.as_str().ok_or_else(|| {
                format!("route table: challenges[{}] must be a string", quote(token))
            })?;
            challenges.insert(token.clone(), value.to_string());
        }
    }
    let cloudflare_ranges = match doc.get("cloudflareRanges") {
        None => None,
        Some(raw) => {
            let raw = raw
                .as_array()
                .ok_or("route table: cloudflareRanges must be an array")?;
            let mut ranges = Vec::with_capacity(raw.len());
            for (i, c) in raw.iter().enumerate() {
                match c.as_str() {
                    Some(s) if is_cidr(s) => ranges.push(s.to_string()),
                    _ => return Err(format!("route table: cloudflareRanges[{i}] is not a CIDR")),
                }
            }
            Some(ranges)
        }
    };
    Ok(RouteTable {
        targets,
        challenges,
        cloudflare_ranges,
    })
}

/// Whether `v` is `address/prefix` with a prefix that fits the family:
/// `^([^/]+)\/(\d{1,3})$`, then the address family check.
pub fn is_cidr(v: &str) -> bool {
    let Some((addr, prefix)) = v.split_once('/') else {
        return false;
    };
    if addr.is_empty()
        || prefix.is_empty()
        || prefix.len() > 3
        || !prefix.bytes().all(|c| c.is_ascii_digit())
    {
        return false;
    }
    let prefix: u32 = prefix.parse().unwrap_or(u32::MAX);
    match ip_family(addr) {
        4 => prefix <= 32,
        6 => prefix <= 128,
        _ => false,
    }
}

/// The address family of `s` (4 or 6), or 0, as Node's `net.isIP` reports
/// it. IPv6 may carry a zone id (`fe80::1%eth0`).
pub fn ip_family(s: &str) -> u8 {
    match s.parse::<IpAddr>() {
        Ok(IpAddr::V4(_)) => 4,
        Ok(IpAddr::V6(_)) => 6,
        Err(_) => match s.split_once('%') {
            Some((addr, zone))
                if !zone.is_empty()
                    && zone
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.' | b':'))
                    && addr.parse::<std::net::Ipv6Addr>().is_ok() =>
            {
                6
            }
            _ => 0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::Registry;
    use serde_json::json;

    fn via() -> Value {
        json!({ "url": "https://relay.example:8443", "caPem": "PEM", "token": "t" })
    }

    fn valid() -> Value {
        json!({
            "version": 1,
            "targets": {
                "Shop.Acme.COM.": {
                    "backends": [{ "id": "a", "url": "http://10.0.0.1", "weight": 100, "insecureSkipVerify": false, "via": via() }],
                    "insights": { "enabled": true, "inject": true, "sampleRate": 100 },
                    "tls": "shop-tls",
                    "redirectHttps": true
                }
            },
            "challenges": { "tok-1_A": "tok-1_A.keyauth" }
        })
    }

    fn parse(v: &Value) -> Result<RouteTable, String> {
        parse_route_table(&serde_json::to_string(v).unwrap())
    }

    fn with(mut base: Value, key: &str, value: Value) -> Value {
        base.as_object_mut().unwrap().insert(key.to_string(), value);
        base
    }

    #[test]
    fn accepts_a_full_valid_table_and_normalises_hosts() {
        let t = parse(&valid()).unwrap();
        assert_eq!(t.targets.keys().collect::<Vec<_>>(), vec!["shop.acme.com"]);
        let target = &t.targets["shop.acme.com"];
        assert_eq!(
            target.backends[0].via,
            Some(RelayVia {
                url: "https://relay.example:8443".to_string(),
                ca_pem: "PEM".to_string(),
                token: "t".to_string()
            })
        );
        assert_eq!(target.backends[0].id.as_deref(), Some("a"));
        assert_eq!(target.tls.as_deref(), Some("shop-tls"));
        assert_eq!(target.redirect_https, Some(true));
        assert_eq!(
            target.insights,
            Some(InsightsSettings {
                enabled: true,
                inject: true,
                sample_rate: 100
            })
        );
        assert_eq!(t.challenges["tok-1_A"], "tok-1_A.keyauth");
        assert_eq!(t.cloudflare_ranges, None);
    }

    #[test]
    fn rejects_version_2() {
        assert_eq!(
            parse(&with(valid(), "version", json!(2))).unwrap_err(),
            "route table: version must be 1"
        );
    }

    #[test]
    fn rejects_an_unknown_key_in_a_target() {
        let bad = with(
            valid(),
            "targets",
            json!({ "a.com": { "backends": [], "extra": 1 } }),
        );
        assert_eq!(
            parse(&bad).unwrap_err(),
            "route table: targets[\"a.com\"] has unknown field \"extra\""
        );
    }

    #[test]
    fn rejects_a_non_https_via_url() {
        let mut v = via();
        v["url"] = json!("http://r");
        let bad = with(
            valid(),
            "targets",
            json!({ "a.com": { "backends": [{ "url": "http://x", "weight": 1, "via": v }] } }),
        );
        assert_eq!(
            parse(&bad).unwrap_err(),
            "route table: targets[\"a.com\"].backends[0] is invalid"
        );
    }

    #[test]
    fn rejects_a_challenge_token_with_a_slash() {
        let bad = with(valid(), "challenges", json!({ "a/b": "x" }));
        assert_eq!(
            parse(&bad).unwrap_err(),
            "route table: challenges token \"a/b\" is invalid"
        );
    }

    #[test]
    fn replace_all_swaps_the_table_and_get_ignores_case_and_trailing_dot() {
        let r = Registry::new();
        let old = Backend {
            id: None,
            url: "http://1.1.1.1".to_string(),
            weight: 1,
            insecure_skip_verify: false,
            via: None,
        };
        r.set("old.com", vec![old], None).unwrap();
        r.replace_all(&parse(&valid()).unwrap().targets).unwrap();
        assert!(r.get("old.com").is_none());
        r.replace_all(&parse(&valid()).unwrap().targets).unwrap();
        let t = r.get("SHOP.acme.com.").unwrap();
        assert_eq!(t.host, "shop.acme.com");
        assert_eq!(t.tls.as_deref(), Some("shop-tls"));
        assert_eq!(t.redirect_https, Some(true));
    }

    // key hygiene

    #[test]
    fn rejects_hosts_that_normalise_to_the_same_key() {
        let b = json!([{ "url": "http://1.1.1.1", "weight": 1 }]);
        let doc = json!({ "version": 1, "targets": { "A.com": { "backends": b }, "a.com.": { "backends": b } } });
        assert_eq!(
            parse(&doc).unwrap_err(),
            "route table: targets[\"a.com.\"] duplicates host \"a.com\""
        );
    }

    #[test]
    fn keeps_a_proto_host_as_own_data() {
        let t = parse_route_table(r#"{"version":1,"targets":{"__proto__":{"backends":[{"url":"http://1.1.1.1","weight":1}]}}}"#).unwrap();
        assert_eq!(t.targets.keys().collect::<Vec<_>>(), vec!["__proto__"]);
    }

    #[test]
    fn treats_constructor_as_a_plain_challenge_token() {
        let t =
            parse(&json!({ "version": 1, "targets": {}, "challenges": { "constructor": "x" } }))
                .unwrap();
        assert_eq!(
            t.challenges.get("constructor").map(String::as_str),
            Some("x")
        );
        assert!(!t.challenges.contains_key("toString"));
        assert_eq!(t.challenges.keys().collect::<Vec<_>>(), vec!["constructor"]);
    }

    // cloudflare

    fn with_target(extra: Value, top: Value) -> Value {
        let mut target = json!({ "backends": [{ "url": "http://10.0.0.1", "weight": 1 }] });
        for (k, v) in extra.as_object().unwrap() {
            target[k] = v.clone();
        }
        let mut doc = json!({ "version": 1, "targets": { "a.test": target } });
        for (k, v) in top.as_object().unwrap() {
            doc[k] = v.clone();
        }
        doc
    }

    #[test]
    fn accepts_cloudflare_and_cloudflare_ranges() {
        let t = parse(&with_target(
            json!({ "cloudflare": true }),
            json!({ "cloudflareRanges": ["104.16.0.0/13", "2606:4700::/32"] }),
        ))
        .unwrap();
        assert_eq!(t.targets["a.test"].cloudflare, Some(true));
        assert_eq!(
            t.cloudflare_ranges,
            Some(vec![
                "104.16.0.0/13".to_string(),
                "2606:4700::/32".to_string()
            ])
        );
    }

    #[test]
    fn rejects_a_non_boolean_cloudflare() {
        assert_eq!(
            parse(&with_target(json!({ "cloudflare": "yes" }), json!({}))).unwrap_err(),
            "route table: targets[\"a.test\"].cloudflare must be a boolean"
        );
    }

    #[test]
    fn rejects_bad_cloudflare_ranges() {
        assert_eq!(
            parse(&with_target(json!({}), json!({ "cloudflareRanges": "x" }))).unwrap_err(),
            "route table: cloudflareRanges must be an array"
        );
        assert_eq!(
            parse(&with_target(
                json!({}),
                json!({ "cloudflareRanges": ["nope"] })
            ))
            .unwrap_err(),
            "route table: cloudflareRanges[0] is not a CIDR"
        );
        assert_eq!(
            parse(&with_target(
                json!({}),
                json!({ "cloudflareRanges": ["10.0.0.0/99"] })
            ))
            .unwrap_err(),
            "route table: cloudflareRanges[0] is not a CIDR"
        );
    }

    // every other error text in route-table.ts

    #[test]
    fn names_each_bad_field() {
        let cases: Vec<(Value, &str)> = vec![
            (json!([]), "route table: must be an object"),
            (
                json!({ "version": 1, "targets": {}, "x": 1 }),
                "route table: unknown field \"x\"",
            ),
            (
                json!({ "version": 1 }),
                "route table: targets must be an object",
            ),
            (
                json!({ "version": 1, "targets": [] }),
                "route table: targets must be an object",
            ),
            (
                json!({ "version": 1, "targets": { "": {} } }),
                "route table: targets[\"\"] has an empty host",
            ),
            (
                json!({ "version": 1, "targets": { "a.test": 1 } }),
                "route table: targets[\"a.test\"] must be an object",
            ),
            (
                json!({ "version": 1, "targets": { "a.test": {} } }),
                "route table: targets[\"a.test\"].backends must be an array",
            ),
            (
                json!({ "version": 1, "targets": { "a.test": { "backends": [], "insights": { "enabled": true, "inject": true, "sampleRate": 30 } } } }),
                "route table: targets[\"a.test\"].insights is invalid",
            ),
            (
                json!({ "version": 1, "targets": { "a.test": { "backends": [], "tls": "" } } }),
                "route table: targets[\"a.test\"].tls must be a non-empty string",
            ),
            (
                json!({ "version": 1, "targets": { "a.test": { "backends": [], "redirectHttps": 1 } } }),
                "route table: targets[\"a.test\"].redirectHttps must be a boolean",
            ),
            (
                json!({ "version": 1, "targets": {}, "challenges": [] }),
                "route table: challenges must be an object",
            ),
            (
                json!({ "version": 1, "targets": {}, "challenges": { "ok": 1 } }),
                "route table: challenges[\"ok\"] must be a string",
            ),
        ];
        for (doc, want) in cases {
            assert_eq!(parse(&doc).unwrap_err(), want, "{doc}");
        }
        assert!(
            parse_route_table("{")
                .unwrap_err()
                .starts_with("route table: invalid JSON: ")
        );
    }

    #[test]
    fn version_and_weight_accept_integral_floats() {
        let t = parse_route_table(r#"{"version":1.0,"targets":{"a.test":{"backends":[{"url":"http://1.1.1.1","weight":1e2}]}}}"#).unwrap();
        assert_eq!(t.targets["a.test"].backends[0].weight, 100);
    }

    // parse_backend

    #[test]
    fn parse_backend_rules() {
        let mut seen = HashSet::new();
        let ok = parse_backend(
            &json!({ "id": "x", "url": "http://a", "weight": 2, "insecureSkipVerify": true }),
            false,
            &mut seen,
        )
        .unwrap();
        assert_eq!(ok.id.as_deref(), Some("x"));
        assert!(ok.insecure_skip_verify);
        assert!(seen.contains("x"));
        // a repeated id
        assert!(
            parse_backend(
                &json!({ "id": "x", "url": "http://b", "weight": 1 }),
                false,
                &mut seen
            )
            .is_none()
        );
        let mut seen = HashSet::new();
        for bad in [
            json!({ "url": "http://a", "weight": 1.5 }),
            json!({ "url": "http://a", "weight": "1" }),
            json!({ "url": 1, "weight": 1 }),
            json!({ "url": "http://a", "weight": 1, "insecureSkipVerify": "false" }),
            json!({ "url": "http://a", "weight": 1, "id": "" }),
            json!({ "url": "http://a", "weight": 1, "id": 3 }),
            json!({ "url": "http://a", "weight": 1, "extra": 1 }),
            json!({ "url": "http://a", "weight": 1, "via": via() }),
            json!([]),
        ] {
            assert!(parse_backend(&bad, false, &mut seen).is_none(), "{bad}");
        }
        // via only where allowed, and complete
        assert!(
            parse_backend(
                &json!({ "url": "http://a", "weight": 1, "via": via() }),
                true,
                &mut seen
            )
            .is_some()
        );
        let mut empty_token = via();
        empty_token["token"] = json!("");
        assert!(
            parse_backend(
                &json!({ "url": "http://a", "weight": 1, "via": empty_token }),
                true,
                &mut seen
            )
            .is_none()
        );
        // a negative weight parses; the registry refuses it
        assert_eq!(
            parse_backend(
                &json!({ "url": "http://a", "weight": -1 }),
                false,
                &mut seen
            )
            .unwrap()
            .weight,
            -1
        );
    }

    #[test]
    fn parse_insights_settings_rules() {
        assert_eq!(parse_insights_settings(None), Ok(None));
        assert!(
            parse_insights_settings(Some(
                &json!({ "enabled": true, "inject": false, "sampleRate": 10 })
            ))
            .unwrap()
            .is_some()
        );
        assert!(parse_insights_settings(Some(&json!(null))).is_err());
        assert!(
            parse_insights_settings(Some(&json!({ "enabled": true, "inject": false }))).is_err()
        );
        assert!(
            parse_insights_settings(Some(
                &json!({ "enabled": true, "inject": false, "sampleRate": 10, "x": 1 })
            ))
            .is_err()
        );
        assert!(
            parse_insights_settings(Some(
                &json!({ "enabled": "true", "inject": false, "sampleRate": 10 })
            ))
            .is_err()
        );
    }

    #[test]
    fn ip_family_and_cidr() {
        assert_eq!(ip_family("1.2.3.4"), 4);
        assert_eq!(ip_family("01.2.3.4"), 0);
        assert_eq!(ip_family("2606:4700::1"), 6);
        assert_eq!(ip_family("fe80::1%eth0"), 6);
        assert_eq!(ip_family("nope"), 0);
        assert!(is_cidr("10.0.0.0/8"));
        assert!(is_cidr("10.0.0.0/032"));
        assert!(is_cidr("::/128"));
        assert!(!is_cidr("::/129"));
        assert!(!is_cidr("10.0.0.0/33"));
        assert!(!is_cidr("10.0.0.0/"));
        assert!(!is_cidr("10.0.0.0/1234"));
        assert!(!is_cidr("/8"));
    }
}
