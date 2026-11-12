// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Cluster mode's configuration source: polls the Kubernetes API for the
//! route table (the ConfigMap `nbo-edge-routes`) and the certificate
//! Secrets (labelled `nbo.dev/edge-cert=true`) and applies them. Port of
//! `packages/edge/src/kube-source.ts`. Two plain HTTPS GETs, no client
//! library: the service-account token is re-read for every request, the
//! API's CA is read once at startup.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http::header::{ACCEPT, AUTHORIZATION};
use http::{HeaderValue, Request, StatusCode, Uri};
use http_body_util::{BodyExt, Empty, Limited};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioTimer};
use rustls::{ClientConfig, RootCertStore};
use rustls_pki_types::CertificateDer;
use rustls_pki_types::pem::PemObject;
use serde_json::Value;

use crate::certs::CertStore;
use crate::registry::Registry;
use crate::route_table::{RouteTable, parse_route_table};

pub const ROUTES_CONFIGMAP: &str = "nbo-edge-routes";
pub const ROUTES_KEY: &str = "routes.json";
pub const DEFAULT_POLL: Duration = Duration::from_secs(5);

/// What a ConfigMap read did to the registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoutesUpdate {
    /// 404: the ConfigMap is gone, so every target, challenge and
    /// Cloudflare range is cleared.
    Cleared,
    /// A valid table replaced the old one.
    Applied,
    /// The table didn't parse or validate; the last good one keeps
    /// serving. The text says why.
    Rejected(String),
}

/// Applies one ConfigMap answer. `Err` is a failed read (a status other
/// than 200 or 404, or a body that isn't JSON): nothing changes.
pub fn apply_routes(
    registry: &Registry,
    status: StatusCode,
    body: &[u8],
) -> Result<RoutesUpdate, String> {
    if status == StatusCode::NOT_FOUND {
        registry
            .replace_table(&RouteTable::default())
            .map_err(|e| format!("configmap: {e}"))?;
        return Ok(RoutesUpdate::Cleared);
    }
    if !status.is_success() {
        return Err(format!("configmap: HTTP {}", status.as_u16()));
    }
    let body: Value =
        serde_json::from_slice(body).map_err(|e| format!("configmap: bad JSON: {e}"))?;
    // `body.data?.["routes.json"] ?? ""`, as the Node edge reads it.
    let routes = match body.get("data").and_then(|d| d.get(ROUTES_KEY)) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    let applied = parse_route_table(&routes).and_then(|table| registry.replace_table(&table));
    Ok(match applied {
        Ok(()) => RoutesUpdate::Applied,
        Err(e) => RoutesUpdate::Rejected(e),
    })
}

/// Applies one Secret list answer: loads every Secret with a name,
/// `tls.crt` and `tls.key`, and drops the names in `known` that are no
/// longer listed. `Err` is a failed read: nothing changes.
pub fn apply_secrets(
    certs: &CertStore,
    known: &mut HashSet<String>,
    status: StatusCode,
    body: &[u8],
) -> Result<(), String> {
    if !status.is_success() {
        return Err(format!("secrets: HTTP {}", status.as_u16()));
    }
    let list: Value =
        serde_json::from_slice(body).map_err(|e| format!("secrets: bad JSON: {e}"))?;
    let items = match list.get("items") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(items)) => items.as_slice(),
        Some(_) => return Err("secrets: items is not a list".to_string()),
    };
    let mut seen = HashSet::new();
    for item in items {
        let name = text(item.get("metadata").and_then(|m| m.get("name")));
        let data = item.get("data");
        let crt = text(data.and_then(|d| d.get("tls.crt")));
        let key = text(data.and_then(|d| d.get("tls.key")));
        let (Some(name), Some(crt), Some(key)) = (name, crt, key) else {
            continue;
        };
        seen.insert(name.to_string());
        let crt = String::from_utf8_lossy(&base64_lenient(crt)).into_owned();
        let key = String::from_utf8_lossy(&base64_lenient(key)).into_owned();
        // A bad pair is logged by the store and skipped.
        let _ = certs.set(name, &crt, &key);
    }
    for name in known.iter() {
        if !seen.contains(name) {
            certs.remove(name);
        }
    }
    *known = seen;
    Ok(())
}

// A non-empty string, else nothing (`!value` in the Node edge).
fn text(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s.as_str()),
        _ => None,
    }
}

/// Base64 read as Node's `Buffer.from(s, "base64")` reads it: both
/// alphabets, stopping at `=`, skipping anything else.
pub fn base64_lenient(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in s.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

// ---------- the poller

/// Where and how the edge reads the cluster API.
#[derive(Debug, Clone)]
pub struct KubeConfig {
    /// `https://kubernetes.default.svc`, or `NBO_EDGE_KUBE_API` in tests.
    pub api_base: String,
    /// Read again for every request: Kubernetes rotates projected tokens.
    pub token_file: String,
    /// The API server's CA, PEM.
    pub ca_pem: String,
    pub namespace: String,
    pub interval: Duration,
}

/// How long one GET may take, headers and body, so a hung API server
/// never stops the polling.
const REQUEST_LIMIT: Duration = Duration::from_secs(30);
/// The largest answer read (a Secret list with many certificates).
const MAX_BODY: usize = 64 << 20;

type KubeClient = Client<HttpsConnector<HttpConnector>, Empty<Bytes>>;

/// Polls the cluster API into `registry` and `certs`.
pub struct KubeSource {
    config: KubeConfig,
    client: KubeClient,
    registry: Arc<Registry>,
    certs: Arc<CertStore>,
    known: HashSet<String>,
}

impl KubeSource {
    /// A source trusting only `config.ca_pem` for the API server. A CA
    /// file with no certificate in it gives a source whose every poll
    /// fails (and is logged), as the Node edge's does.
    pub fn new(
        config: KubeConfig,
        registry: Arc<Registry>,
        certs: Arc<CertStore>,
    ) -> Result<KubeSource, String> {
        let mut roots = RootCertStore::empty();
        for cert in CertificateDer::pem_slice_iter(config.ca_pem.as_bytes()).flatten() {
            let _ = roots.add(cert);
        }
        let tls =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .map_err(|e| format!("edge: tls: {e}"))?
                .with_root_certificates(roots)
                .with_no_client_auth();
        let mut http = HttpConnector::new();
        http.enforce_http(false);
        let connector = HttpsConnectorBuilder::new()
            .with_tls_config(tls)
            .https_or_http()
            .enable_http1()
            .wrap_connector(http);
        let client = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_timer(TokioTimer::new())
            .build(connector);
        Ok(KubeSource {
            config,
            client,
            registry,
            certs,
            known: HashSet::new(),
        })
    }

    async fn get(&self, path: &str) -> Result<(StatusCode, Bytes), String> {
        let token = std::fs::read_to_string(&self.config.token_file)
            .map_err(|e| format!("token {}: {e}", self.config.token_file))?;
        let uri: Uri = format!("{}{path}", self.config.api_base)
            .parse()
            .map_err(|e| format!("bad API URL: {e}"))?;
        let bearer = HeaderValue::from_str(&format!("Bearer {}", token.trim()))
            .map_err(|_| "the service-account token is not a valid header value".to_string())?;
        let mut req = Request::new(Empty::<Bytes>::new());
        *req.uri_mut() = uri;
        req.headers_mut().insert(AUTHORIZATION, bearer);
        req.headers_mut()
            .insert(ACCEPT, HeaderValue::from_static("application/json"));
        let fetch = async {
            let res = self
                .client
                .request(req)
                .await
                .map_err(|e| crate::proxy::describe(&e))?;
            let status = res.status();
            let body = Limited::new(res.into_body(), MAX_BODY)
                .collect()
                .await
                .map_err(|e| format!("reading the answer: {e}"))?
                .to_bytes();
            Ok((status, body))
        };
        tokio::time::timeout(REQUEST_LIMIT, fetch)
            .await
            .map_err(|_| format!("no answer within {} s", REQUEST_LIMIT.as_secs()))?
    }

    async fn poll_routes(&self) -> Result<(), String> {
        let path = format!(
            "/api/v1/namespaces/{}/configmaps/{ROUTES_CONFIGMAP}",
            self.config.namespace
        );
        let (status, body) = self.get(&path).await?;
        if let RoutesUpdate::Rejected(why) = apply_routes(&self.registry, status, &body)? {
            eprintln!("edge: route table rejected, keeping the last good one: {why}");
        }
        Ok(())
    }

    async fn poll_certs(&mut self) -> Result<(), String> {
        let path = format!(
            "/api/v1/namespaces/{}/secrets?labelSelector=nbo.dev%2Fedge-cert%3Dtrue",
            self.config.namespace
        );
        let (status, body) = self.get(&path).await?;
        apply_secrets(&self.certs, &mut self.known, status, &body)
    }

    /// One round: the route table, then the certificates. A failed step is
    /// logged and the other still runs.
    pub async fn poll_once(&mut self) {
        if let Err(e) = self.poll_routes().await {
            eprintln!("edge: kubernetes poll failed: {e}");
        }
        if let Err(e) = self.poll_certs().await {
            eprintln!("edge: kubernetes poll failed: {e}");
        }
    }

    /// Polls forever, `interval` after each round ends.
    pub async fn run(mut self) {
        loop {
            tokio::time::sleep(self.config.interval).await;
            self.poll_once().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::certs::tests::pair;

    fn configmap(routes: &str) -> Vec<u8> {
        serde_json::json!({
            "metadata": { "name": ROUTES_CONFIGMAP },
            "data": { ROUTES_KEY: routes }
        })
        .to_string()
        .into_bytes()
    }

    const GOOD: &str = r#"{"version":1,"targets":{
        "a.test":{"backends":[{"url":"http://127.0.0.1:1","weight":1}],"cloudflare":true}
    },"challenges":{"tok1":"tok1.keyauth"},"cloudflareRanges":["10.0.0.0/8"]}"#;

    fn assert_good(registry: &Registry) {
        let snap = registry.snapshot();
        assert!(snap.target("a.test").is_some());
        assert_eq!(
            snap.challenges.get("tok1").map(String::as_str),
            Some("tok1.keyauth")
        );
        assert!(snap.cloudflare.has("10.1.2.3"));
    }

    #[test]
    fn a_bad_configmap_keeps_the_last_good_table() {
        let registry = Registry::new();
        assert_eq!(
            apply_routes(&registry, StatusCode::OK, &configmap(GOOD)),
            Ok(RoutesUpdate::Applied)
        );
        assert_good(&registry);

        for bad in [
            "{not json",
            r#"{"version":2,"targets":{},"challenges":{}}"#,
            r#"{"version":1,"targets":{"a.test":{"backends":[{"url":"http://x","weight":0}]}},"challenges":{}}"#,
            r#"{"version":1,"targets":{},"challenges":{"bad token!":"x"}}"#,
            r#"{"version":1,"targets":{},"challenges":{},"cloudflareRanges":["10.0.0.0/33"]}"#,
        ] {
            let got = apply_routes(&registry, StatusCode::OK, &configmap(bad));
            assert!(
                matches!(got, Ok(RoutesUpdate::Rejected(_))),
                "{bad}: {got:?}"
            );
            assert_good(&registry);
        }
        // No routes.json at all is an empty text: rejected too.
        let got = apply_routes(&registry, StatusCode::OK, br#"{"data":{}}"#);
        assert!(matches!(got, Ok(RoutesUpdate::Rejected(_))), "{got:?}");
        assert_good(&registry);

        // Failed reads change nothing either.
        assert_eq!(
            apply_routes(&registry, StatusCode::FORBIDDEN, b"{}"),
            Err("configmap: HTTP 403".to_string())
        );
        assert!(apply_routes(&registry, StatusCode::OK, b"<html>").is_err());
        assert_good(&registry);
    }

    #[test]
    fn a_missing_configmap_clears_everything() {
        let registry = Registry::new();
        apply_routes(&registry, StatusCode::OK, &configmap(GOOD)).unwrap();
        assert_eq!(
            apply_routes(&registry, StatusCode::NOT_FOUND, b"{}"),
            Ok(RoutesUpdate::Cleared)
        );
        let snap = registry.snapshot();
        assert!(snap.target("a.test").is_none());
        assert!(snap.challenges.is_empty());
        assert!(!snap.cloudflare.has("10.1.2.3"));
    }

    fn secret_list(items: &[(&str, &str, &str)]) -> Vec<u8> {
        use std::fmt::Write;
        let b64 = |s: &str| {
            // Standard base64, enough for the test.
            const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut out = String::new();
            for chunk in s.as_bytes().chunks(3) {
                let n = chunk
                    .iter()
                    .enumerate()
                    .fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
                for i in 0..4 {
                    if i <= chunk.len() {
                        out.write_char(A[(n >> (18 - 6 * i) & 63) as usize] as char)
                            .unwrap();
                    } else {
                        out.push('=');
                    }
                }
            }
            out
        };
        let items: Vec<_> = items
            .iter()
            .map(|(name, crt, key)| {
                serde_json::json!({
                    "metadata": { "name": name },
                    "data": { "tls.crt": b64(crt), "tls.key": b64(key) }
                })
            })
            .collect();
        serde_json::json!({ "items": items })
            .to_string()
            .into_bytes()
    }

    #[test]
    fn secrets_load_skip_bad_pairs_and_drop_vanished_names() {
        let certs = CertStore::new();
        let mut known = HashSet::new();
        let (a_cert, a_key) = pair("a.test");
        let (b_cert, b_key) = pair("b.test");
        apply_secrets(
            &certs,
            &mut known,
            StatusCode::OK,
            &secret_list(&[
                ("a-tls", &a_cert, &a_key),
                ("b-tls", &b_cert, &b_key),
                ("broken-tls", "not a cert", "not a key"),
            ]),
        )
        .unwrap();
        assert!(certs.get("a-tls").is_some());
        assert!(certs.get("b-tls").is_some());
        assert!(certs.get("broken-tls").is_none());

        // A failed read keeps everything.
        assert_eq!(
            apply_secrets(&certs, &mut known, StatusCode::UNAUTHORIZED, b"{}"),
            Err("secrets: HTTP 401".to_string())
        );
        assert!(certs.get("b-tls").is_some());

        // b-tls is gone from the list: dropped, a-tls kept.
        apply_secrets(
            &certs,
            &mut known,
            StatusCode::OK,
            &secret_list(&[("a-tls", &a_cert, &a_key)]),
        )
        .unwrap();
        assert!(certs.get("a-tls").is_some());
        assert!(certs.get("b-tls").is_none());

        // Items without a name or data are ignored.
        apply_secrets(
            &certs,
            &mut known,
            StatusCode::OK,
            br#"{"items":[{"metadata":{}},{"metadata":{"name":"x"}},{}]}"#,
        )
        .unwrap();
        assert!(certs.get("a-tls").is_none());
    }

    #[test]
    fn base64_reads_like_node() {
        assert_eq!(base64_lenient("aGVsbG8="), b"hello");
        assert_eq!(base64_lenient("aGVs\nbG8"), b"hello");
        assert_eq!(base64_lenient("-_8="), [0xfb, 0xff]);
        assert_eq!(base64_lenient("+/8="), [0xfb, 0xff]);
        assert_eq!(base64_lenient("aGk=trailing"), b"hi");
        assert_eq!(base64_lenient(""), b"");
    }
}
