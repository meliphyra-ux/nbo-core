// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Every app's current traffic split, keyed by the public host visitors
//! send. Port of `packages/edge/src/registry.ts`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use indexmap::IndexMap;

use crate::cloudflare::CloudflareTrust;
use crate::route_table::RouteTable;
use crate::text::quote;

/// The relay a backend is reached through (private clusters): the edge
/// connects to `url`, trusting `ca_pem`, and authenticates with `token`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayVia {
    pub url: String,
    pub ca_pem: String,
    pub token: String,
}

/// One possible destination for a target's traffic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backend {
    /// The stable key for keeping visitors on one cloud (the environment
    /// id). Without it the URL is the key.
    pub id: Option<String>,
    pub url: String,
    pub weight: i64,
    /// Per-backend opt-in for a self-signed certificate, never global.
    pub insecure_skip_verify: bool,
    pub via: Option<RelayVia>,
}

/// Speed Insights for one host. `sample_rate` is 100, 50, 25 or 10.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InsightsSettings {
    pub enabled: bool,
    pub inject: bool,
    pub sample_rate: u8,
}

/// One route-table entry, before its host is normalised.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TargetConfig {
    pub backends: Vec<Backend>,
    pub insights: Option<InsightsSettings>,
    /// The Secret holding the host's certificate; `None` means no TLS.
    pub tls: Option<String>,
    pub redirect_https: Option<bool>,
    /// The host sits behind Cloudflare: `cf-connecting-ip` is believed
    /// when the socket peer is a Cloudflare address.
    pub cloudflare: Option<bool>,
}

/// One app's current traffic split.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub backends: Vec<Backend>,
    pub insights: Option<InsightsSettings>,
    pub tls: Option<String>,
    pub redirect_https: Option<bool>,
    pub cloudflare: Option<bool>,
}

impl Target {
    pub fn new(host: &str, backends: Vec<Backend>) -> Target {
        Target {
            host: host.to_string(),
            backends,
            insights: None,
            tls: None,
            redirect_https: None,
            cloudflare: None,
        }
    }
}

fn no_pickable(host: &str) -> String {
    format!("edge: target {} has no pickable backend", quote(host))
}

/// Picks one backend weighted-randomly. A backend with weight 0 is never
/// picked.
pub fn pick(target: &Target) -> Result<&Backend, String> {
    let total: i128 = target.backends.iter().map(|b| i128::from(b.weight)).sum();
    if total <= 0 {
        return Err(no_pickable(&target.host));
    }
    let mut draw = rand::random_range(0..total);
    for b in &target.backends {
        if draw < i128::from(b.weight) {
            return Ok(b);
        }
        draw -= i128::from(b.weight);
    }
    Err(no_pickable(&target.host))
}

/// The registry key for a host: its URL hostname (port dropped, lower
/// case, IDNA and IP forms normalised as a browser would), without a
/// trailing dot.
pub fn normalize_host(host: &str) -> String {
    // new URL("http://" + host).hostname, falling back to plain lower case
    // when even that doesn't parse.
    let h = match url::Url::parse(&format!("http://{host}")) {
        Ok(u) => u.host_str().unwrap_or("").to_string(),
        Err(_) => host.to_lowercase(),
    };
    match h.strip_suffix('.') {
        Some(stripped) => stripped.to_string(),
        None => h,
    }
}

/// Whether `raw` is a valid http(s) URL with a host, as `new URL` sees it.
pub fn is_http_url(raw: &str) -> bool {
    is_url_with_scheme(raw, &["http", "https"])
}

/// Whether `raw` parses as a URL with one of `schemes` and a non-empty host.
pub fn is_url_with_scheme(raw: &str, schemes: &[&str]) -> bool {
    match url::Url::parse(raw) {
        Ok(u) => schemes.contains(&u.scheme()) && u.host_str().is_some_and(|h| !h.is_empty()),
        Err(_) => false,
    }
}

fn validate(host: &str, backends: &[Backend]) -> Result<(), String> {
    let mut total: i128 = 0;
    for b in backends {
        if b.weight < 0 {
            return Err(format!(
                "edge: backend {} has a negative weight {}",
                quote(&b.url),
                b.weight
            ));
        }
        if !is_http_url(&b.url) {
            return Err(format!(
                "edge: backend {} is not a valid http(s) url",
                quote(&b.url)
            ));
        }
        total += i128::from(b.weight);
    }
    if total <= 0 {
        return Err(format!(
            "edge: target {} has no backend with a positive weight",
            quote(host)
        ));
    }
    Ok(())
}

/// Whether `host` is already its own registry key, so `normalize_host` (a
/// full URL parse) can be skipped: lower-case ASCII letters, digits, `-`
/// and `.`, no port, no empty label (so no trailing dot), no `xn--` label
/// (the URL parser checks punycode), and a last label that doesn't start
/// with a digit (the URL parser reads such a host as an IPv4 address and
/// may rewrite it, as `0x7f.1` becomes `127.0.0.1`).
fn is_normal_host(host: &str) -> bool {
    let bytes = host.as_bytes();
    if bytes.is_empty()
        || !bytes
            .iter()
            .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.')
    {
        return false;
    }
    let mut last = "";
    for label in host.split('.') {
        if label.is_empty() || label.starts_with("xn--") {
            return false;
        }
        last = label;
    }
    !last.as_bytes()[0].is_ascii_digit()
}

/// The registry key for `host`: `normalize_host`, without the URL parse
/// when the host is already normal.
pub fn host_key(host: &str) -> Cow<'_, str> {
    if is_normal_host(host) {
        Cow::Borrowed(host)
    } else {
        Cow::Owned(normalize_host(host))
    }
}

/// Everything the edge routes by, swapped as one value: a request reads
/// one snapshot and never sees half of an update (targets from one route
/// table, challenges or Cloudflare ranges from another).
#[derive(Debug, Default)]
pub struct Snapshot {
    targets: HashMap<String, Arc<Target>>,
    /// ACME HTTP-01 answers by token (cluster mode).
    pub challenges: HashMap<String, String>,
    /// The addresses Cloudflare connects from (cluster mode).
    pub cloudflare: CloudflareTrust,
}

impl Snapshot {
    /// The target for a Host header value, normalised like `normalize_host`.
    pub fn target(&self, host: &str) -> Option<&Arc<Target>> {
        self.targets.get(host_key(host).as_ref())
    }
}

fn build_targets(
    targets: &IndexMap<String, TargetConfig>,
) -> Result<HashMap<String, Arc<Target>>, String> {
    let mut next = HashMap::with_capacity(targets.len());
    for (host, t) in targets {
        validate(host, &t.backends)?;
        let normalized = normalize_host(host);
        if next.contains_key(&normalized) {
            return Err(format!(
                "edge: duplicate host {} in route table",
                quote(&normalized)
            ));
        }
        let target = Target {
            host: normalized.clone(),
            backends: t.backends.clone(),
            insights: t.insights,
            tls: t.tls.clone(),
            redirect_https: t.redirect_https,
            cloudflare: t.cloudflare,
        };
        next.insert(normalized, Arc::new(target));
    }
    Ok(next)
}

/// Holds every app's target. Reads take a cheap snapshot (an `Arc`),
/// writes swap in a new one, so a request never sees half of an update.
#[derive(Debug, Default)]
pub struct Registry {
    snapshot: RwLock<Arc<Snapshot>>,
}

impl Registry {
    pub fn new() -> Registry {
        Registry::default()
    }

    /// The current snapshot. Hold it for a whole request.
    pub fn snapshot(&self) -> Arc<Snapshot> {
        Arc::clone(&self.read())
    }

    /// Replaces `host`'s target after validating its backends.
    pub fn set(
        &self,
        host: &str,
        backends: Vec<Backend>,
        insights: Option<InsightsSettings>,
    ) -> Result<(), String> {
        validate(host, &backends)?;
        let normalized = normalize_host(host);
        let target = Target {
            insights,
            ..Target::new(&normalized, backends)
        };
        self.update(|targets| {
            targets.insert(normalized, Arc::new(target));
        });
        Ok(())
    }

    /// Validates every target like `set`, then swaps all the targets in one
    /// step; a bad table changes nothing. Challenges and Cloudflare ranges
    /// are kept.
    pub fn replace_all(&self, targets: &IndexMap<String, TargetConfig>) -> Result<(), String> {
        let next = build_targets(targets)?;
        let mut guard = self.write();
        *guard = Arc::new(Snapshot {
            targets: next,
            challenges: guard.challenges.clone(),
            cloudflare: guard.cloudflare.clone(),
        });
        Ok(())
    }

    /// Installs a whole route table (targets, challenges and Cloudflare
    /// ranges) in one swap. A table whose targets fail validation changes
    /// nothing, and the error says why.
    pub fn replace_table(&self, table: &RouteTable) -> Result<(), String> {
        let next = Snapshot {
            targets: build_targets(&table.targets)?,
            challenges: table
                .challenges
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            cloudflare: CloudflareTrust::from_cidrs(
                table.cloudflare_ranges.as_deref().unwrap_or_default(),
            ),
        };
        *self.write() = Arc::new(next);
        Ok(())
    }

    pub fn get(&self, host: &str) -> Option<Arc<Target>> {
        self.snapshot().target(host).cloned()
    }

    /// Drops `host`'s target; an unknown host is a no-op.
    pub fn remove(&self, host: &str) {
        let normalized = normalize_host(host);
        self.update(|targets| {
            targets.remove(&normalized);
        });
    }

    // Copy-on-write: writers are rare (the admin API, a route table poll),
    // readers are every request.
    fn update(&self, change: impl FnOnce(&mut HashMap<String, Arc<Target>>)) {
        let mut guard = self.write();
        let mut targets = guard.targets.clone();
        change(&mut targets);
        *guard = Arc::new(Snapshot {
            targets,
            challenges: guard.challenges.clone(),
            cloudflare: guard.cloudflare.clone(),
        });
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Arc<Snapshot>> {
        self.snapshot.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Arc<Snapshot>> {
        self.snapshot.write().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn backend(url: &str, weight: i64) -> Backend {
        Backend {
            id: None,
            url: url.to_string(),
            weight,
            insecure_skip_verify: false,
            via: None,
        }
    }

    // pick

    #[test]
    fn pick_never_picks_a_zero_weight_backend() {
        let t = Target::new(
            "app.test",
            vec![backend("https://zero", 0), backend("https://hundred", 100)],
        );
        for _ in 0..1000 {
            assert_ne!(pick(&t).unwrap().url, "https://zero");
        }
    }

    #[test]
    fn pick_distributes_roughly_by_weight() {
        let t = Target::new(
            "app.test",
            vec![backend("https://a", 90), backend("https://b", 10)],
        );
        let mut counts: HashMap<String, usize> = HashMap::new();
        let n = 10_000;
        for _ in 0..n {
            *counts.entry(pick(&t).unwrap().url.clone()).or_default() += 1;
        }
        let a = counts.get("https://a").copied().unwrap_or(0);
        assert!(a > n * 80 / 100, "{a}");
        assert!(a < n * 98 / 100, "{a}");
    }

    #[test]
    fn pick_errors_when_the_target_has_no_backends() {
        let t = Target::new("app.test", vec![]);
        assert_eq!(
            pick(&t).unwrap_err(),
            "edge: target \"app.test\" has no pickable backend"
        );
    }

    // Registry

    #[test]
    fn set_then_get_round_trips() {
        let r = Registry::new();
        r.set("app.test", vec![backend("https://a", 1)], None)
            .unwrap();
        assert_eq!(r.get("app.test").unwrap().backends.len(), 1);
    }

    #[test]
    fn get_on_an_unknown_host_returns_none() {
        assert!(Registry::new().get("nope.test").is_none());
    }

    #[test]
    fn set_rejects_a_negative_weight() {
        let r = Registry::new();
        assert_eq!(
            r.set("app.test", vec![backend("https://a", -1)], None)
                .unwrap_err(),
            "edge: backend \"https://a\" has a negative weight -1"
        );
    }

    #[test]
    fn set_rejects_an_all_zero_weight_configuration() {
        let r = Registry::new();
        assert_eq!(
            r.set(
                "app.test",
                vec![backend("https://a", 0), backend("https://b", 0)],
                None
            )
            .unwrap_err(),
            "edge: target \"app.test\" has no backend with a positive weight"
        );
    }

    #[test]
    fn get_matches_a_host_with_a_port_and_different_case() {
        let r = Registry::new();
        r.set("App.Test", vec![backend("https://a", 1)], None)
            .unwrap();
        assert!(r.get("app.test:9443").is_some());
        assert_eq!(r.get("app.test").unwrap().host, "app.test");
    }

    #[test]
    fn set_rejects_a_backend_url_with_no_scheme() {
        let r = Registry::new();
        assert_eq!(
            r.set(
                "app.test",
                vec![backend("edge-next-app.127.0.0.1.sslip.io", 1)],
                None
            )
            .unwrap_err(),
            "edge: backend \"edge-next-app.127.0.0.1.sslip.io\" is not a valid http(s) url"
        );
    }

    #[test]
    fn set_rejects_other_schemes_and_hostless_urls() {
        assert!(!is_http_url("ftp://a"));
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(!is_http_url("http://"));
        assert!(is_http_url("HTTP://A.example:8080/base"));
        assert!(is_http_url("http://[::1]:3000"));
    }

    #[test]
    fn set_keeps_insights_and_remove_drops_the_host() {
        let r = Registry::new();
        let insights = InsightsSettings {
            enabled: true,
            inject: false,
            sample_rate: 50,
        };
        r.set("a.test", vec![backend("http://1.1.1.1", 1)], Some(insights))
            .unwrap();
        assert_eq!(r.get("A.TEST.").unwrap().insights, Some(insights));
        r.remove("a.test:80");
        assert!(r.get("a.test").is_none());
        r.remove("unknown.test");
    }

    #[test]
    fn a_snapshot_survives_a_later_write() {
        let r = Registry::new();
        r.set("a.test", vec![backend("http://1.1.1.1", 1)], None)
            .unwrap();
        let before = r.get("a.test").unwrap();
        r.set("a.test", vec![backend("http://2.2.2.2", 1)], None)
            .unwrap();
        assert_eq!(before.backends[0].url, "http://1.1.1.1");
        assert_eq!(r.get("a.test").unwrap().backends[0].url, "http://2.2.2.2");
    }

    // normalize_host

    #[test]
    fn normalize_host_matches_the_url_hostname() {
        assert_eq!(normalize_host("App.Test:9443"), "app.test");
        assert_eq!(normalize_host("shop.acme.com."), "shop.acme.com");
        assert_eq!(normalize_host("[::1]:8080"), "[::1]");
        assert_eq!(normalize_host("0x7f.1"), "127.0.0.1");
        assert_eq!(normalize_host("BÜCHER.example"), "xn--bcher-kva.example");
        assert_eq!(normalize_host(""), "");
        assert_eq!(normalize_host("__proto__"), "__proto__");
    }

    // replace_all

    fn config(url: &str, weight: i64) -> TargetConfig {
        TargetConfig {
            backends: vec![backend(url, weight)],
            ..TargetConfig::default()
        }
    }

    #[test]
    fn replace_all_keeps_the_previous_targets_when_one_is_invalid() {
        let r = Registry::new();
        r.set("old.com", vec![backend("http://1.1.1.1", 1)], None)
            .unwrap();
        let mut table = IndexMap::new();
        table.insert("new.com".to_string(), config("http://2.2.2.2", 1));
        table.insert("bad.com".to_string(), config("http://3.3.3.3", -1));
        assert!(r.replace_all(&table).is_err());
        assert!(r.get("old.com").is_some());
        assert!(r.get("new.com").is_none());
    }

    #[test]
    fn replace_all_rejects_duplicate_normalised_hosts() {
        let r = Registry::new();
        let mut table = IndexMap::new();
        table.insert("A.com".to_string(), config("http://1.1.1.1", 1));
        table.insert("a.com".to_string(), config("http://1.1.1.1", 1));
        assert_eq!(
            r.replace_all(&table).unwrap_err(),
            "edge: duplicate host \"a.com\" in route table"
        );
    }

    #[test]
    fn replace_all_stores_tls_redirect_and_cloudflare() {
        let r = Registry::new();
        r.set("old.com", vec![backend("http://1.1.1.1", 1)], None)
            .unwrap();
        let mut table = IndexMap::new();
        table.insert(
            "Shop.Acme.COM.".to_string(),
            TargetConfig {
                tls: Some("shop-tls".to_string()),
                redirect_https: Some(true),
                cloudflare: Some(false),
                ..config("http://10.0.0.1", 100)
            },
        );
        r.replace_all(&table).unwrap();
        assert!(r.get("old.com").is_none());
        let t = r.get("SHOP.acme.com.").unwrap();
        assert_eq!(t.host, "shop.acme.com");
        assert_eq!(t.tls.as_deref(), Some("shop-tls"));
        assert_eq!(t.redirect_https, Some(true));
        assert_eq!(t.cloudflare, Some(false));
    }

    // host_key: the fast path must agree with normalize_host everywhere.

    #[test]
    fn host_key_equals_normalize_host() {
        let fixed = [
            "app.test",
            "App.Test",
            "app.test:9443",
            "app.test.",
            "a..b",
            ".a",
            "",
            "localhost",
            "127.0.0.1",
            "127.1",
            "0x7f.1",
            "a.0x10",
            "a.1",
            "a.1b",
            "1a.b",
            "xn--bcher-kva.example",
            "xn--nope.test",
            "a.xn--zz",
            "-a-.b-",
            "a_b.test",
            "a b",
            "a%41.test",
            "[::1]",
            "__proto__",
            "\u{fb01}.test",
        ];
        for host in fixed {
            assert_eq!(host_key(host), normalize_host(host), "{host:?}");
        }
        // Random short hosts over an alphabet with every risky character.
        let alphabet: Vec<char> = "abz019-.xX:_%".chars().collect();
        for _ in 0..20_000 {
            let len = rand::random_range(0..12);
            let host: String = (0..len)
                .map(|_| alphabet[rand::random_range(0..alphabet.len())])
                .collect();
            assert_eq!(host_key(&host), normalize_host(&host), "{host:?}");
        }
    }

    #[test]
    fn host_key_skips_the_parse_for_a_normal_host() {
        assert!(matches!(host_key("shop.acme.com"), Cow::Borrowed(_)));
        assert!(matches!(host_key("Shop.acme.com"), Cow::Owned(_)));
    }

    // replace_table: targets, challenges and Cloudflare ranges in one swap

    #[test]
    fn replace_table_swaps_targets_challenges_and_cloudflare_together() {
        let r = Registry::new();
        let mut table = RouteTable::default();
        table
            .targets
            .insert("a.test".to_string(), config("http://1.1.1.1", 1));
        table
            .challenges
            .insert("tok".to_string(), "answer".to_string());
        table.cloudflare_ranges = Some(vec!["104.16.0.0/13".to_string()]);
        r.replace_table(&table).unwrap();
        let before = r.snapshot();
        assert!(before.target("A.test").is_some());
        assert_eq!(
            before.challenges.get("tok").map(String::as_str),
            Some("answer")
        );
        assert!(before.cloudflare.has("104.16.0.1"));

        // A bad table changes none of the three.
        let mut bad = RouteTable::default();
        bad.targets
            .insert("b.test".to_string(), config("http://1.1.1.1", -1));
        assert!(r.replace_table(&bad).is_err());
        let kept = r.snapshot();
        assert!(kept.target("a.test").is_some());
        assert!(kept.challenges.contains_key("tok"));
        assert!(kept.cloudflare.has("104.16.0.1"));

        // An empty table (the ConfigMap is gone) clears all three; the
        // snapshot taken earlier is unchanged.
        r.replace_table(&RouteTable::default()).unwrap();
        let now = r.snapshot();
        assert!(now.target("a.test").is_none());
        assert!(now.challenges.is_empty());
        assert!(!now.cloudflare.has("104.16.0.1"));
        assert!(before.target("a.test").is_some());
    }

    #[test]
    fn set_and_replace_all_keep_challenges_and_cloudflare() {
        let r = Registry::new();
        let mut table = RouteTable::default();
        table
            .challenges
            .insert("tok".to_string(), "answer".to_string());
        table.cloudflare_ranges = Some(vec!["104.16.0.0/13".to_string()]);
        r.replace_table(&table).unwrap();
        r.set("a.test", vec![backend("http://1.1.1.1", 1)], None)
            .unwrap();
        r.replace_all(&IndexMap::new()).unwrap();
        let s = r.snapshot();
        assert!(s.challenges.contains_key("tok"));
        assert!(s.cloudflare.has("104.16.0.1"));
    }
}
