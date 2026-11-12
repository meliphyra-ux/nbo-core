// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! The admin API. Dev mode: `PUT/GET/DELETE /targets/{host}` and
//! `GET /insights/drain`, bound to loopback by default. Cluster mode: only
//! `GET /insights/drain?token=<t>`. Port of `packages/edge/src/admin.ts`.

use std::collections::HashSet;
use std::sync::Arc;

use bytes::Bytes;
use http::{Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Limited};
use hyper::body::Body;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::insights::aggregator::Aggregator;
use crate::proxy::{BoxError, EdgeBody, empty, json as json_response, request_url, text};
use crate::registry::{Backend, InsightsSettings, Registry, Target};
use crate::route_table::{has_only_keys, parse_backend, parse_insights_settings};

/// A PUT body larger than this is refused; a route for one host is a few
/// hundred bytes.
const MAX_BODY_BYTES: usize = 1 << 20;

#[derive(Debug, Clone, Default)]
pub struct AdminOptions {
    /// Set in cluster mode: a drain-only API, where only
    /// `GET /insights/drain?token=<t>` answers and everything else is 404.
    pub drain_token: Option<String>,
    /// The aggregator `GET /insights/drain` empties; without one the drain
    /// is always empty.
    pub insights: Option<Arc<Aggregator>>,
}

/// Compares sha256 digests in constant time, so the comparison takes the
/// same time wherever the given token differs.
pub fn token_matches(given: Option<&str>, expected: &str) -> bool {
    let Some(given) = given else { return false };
    let a = Sha256::digest(given.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

fn insights_json(s: &InsightsSettings) -> Value {
    json!({ "enabled": s.enabled, "inject": s.inject, "sampleRate": s.sample_rate })
}

fn backend_json(b: &Backend) -> Value {
    let mut o = Map::new();
    if let Some(id) = &b.id {
        o.insert("id".into(), json!(id));
    }
    o.insert("url".into(), json!(b.url));
    o.insert("weight".into(), json!(b.weight));
    o.insert("insecureSkipVerify".into(), json!(b.insecure_skip_verify));
    if let Some(via) = &b.via {
        o.insert(
            "via".into(),
            json!({ "url": via.url, "caPem": via.ca_pem, "token": via.token }),
        );
    }
    Value::Object(o)
}

/// A target as the TypeScript edge's `Response.json(target)` writes it:
/// optional fields only when set.
pub fn target_json(t: &Target) -> Value {
    let mut o = Map::new();
    o.insert("host".into(), json!(t.host));
    o.insert(
        "backends".into(),
        Value::Array(t.backends.iter().map(backend_json).collect()),
    );
    if let Some(s) = &t.insights {
        o.insert("insights".into(), insights_json(s));
    }
    if let Some(tls) = &t.tls {
        o.insert("tls".into(), json!(tls));
    }
    if let Some(r) = t.redirect_https {
        o.insert("redirectHttps".into(), json!(r));
    }
    if let Some(c) = t.cloudflare {
        o.insert("cloudflare".into(), json!(c));
    }
    Value::Object(o)
}

fn query_param(url: &url::Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// The drain's answer: every histogram held, which are then forgotten.
fn drain(opts: &AdminOptions) -> Value {
    match &opts.insights {
        Some(aggregator) => aggregator.drain(),
        None => json!({ "batches": [] }),
    }
}

/// Handles one admin request.
pub async fn handle<B>(
    req: Request<B>,
    registry: &Registry,
    opts: &AdminOptions,
) -> Response<EdgeBody>
where
    B: Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    let Some(url) = request_url(req.uri()) else {
        return text(StatusCode::NOT_FOUND, "not found");
    };
    let path = url.path();
    if opts.drain_token.is_some() && path != "/insights/drain" {
        return text(StatusCode::NOT_FOUND, "not found");
    }
    if path == "/insights/drain" {
        if req.method() != Method::GET {
            return text(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
        }
        if let Some(expected) = &opts.drain_token
            && !token_matches(query_param(&url, "token").as_deref(), expected)
        {
            return text(StatusCode::FORBIDDEN, "forbidden");
        }
        return json_response(StatusCode::OK, &drain(opts));
    }
    let Some(host) = path.strip_prefix("/targets/").filter(|h| !h.is_empty()) else {
        return text(StatusCode::NOT_FOUND, "not found");
    };
    let host = host.to_string();

    match *req.method() {
        Method::PUT => put(req, registry, &host).await,
        Method::GET => match registry.get(&host) {
            Some(t) => json_response(StatusCode::OK, &target_json(&t)),
            None => text(
                StatusCode::NOT_FOUND,
                format!("edge: no target registered for host {host}"),
            ),
        },
        Method::DELETE => {
            registry.remove(&host);
            empty(StatusCode::NO_CONTENT)
        }
        _ => text(StatusCode::METHOD_NOT_ALLOWED, "method not allowed"),
    }
}

async fn put<B>(req: Request<B>, registry: &Registry, host: &str) -> Response<EdgeBody>
where
    B: Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    let bad = |detail: String| text(StatusCode::BAD_REQUEST, detail);
    let bytes = match Limited::new(req.into_body(), MAX_BODY_BYTES)
        .collect()
        .await
    {
        Ok(c) => c.to_bytes(),
        Err(e) => return bad(format!("edge: invalid request body: {e}")),
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => return bad(format!("edge: invalid request body: {e}")),
    };
    let Some(obj) = body.as_object() else {
        return bad("edge: invalid request body".into());
    };
    let Some(raw_backends) = obj.get("backends").and_then(Value::as_array) else {
        return bad("edge: invalid request body".into());
    };
    if !has_only_keys(obj, &["backends", "insights"]) {
        return bad("edge: invalid request body".into());
    }
    let Ok(insights) = parse_insights_settings(obj.get("insights")) else {
        return bad("edge: invalid insights settings".into());
    };
    let mut backends = Vec::with_capacity(raw_backends.len());
    let mut seen_ids = HashSet::new();
    for raw in raw_backends {
        // `via` is route-table only; the dev admin API refuses it.
        let Some(b) = parse_backend(raw, false, &mut seen_ids) else {
            return bad("edge: invalid request body".into());
        };
        backends.push(b);
    }
    match registry.set(host, backends, insights) {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(e) => bad(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::Full;

    async fn call(
        registry: &Registry,
        opts: &AdminOptions,
        method: &str,
        path: &str,
        body: &str,
    ) -> (u16, String) {
        let req = Request::builder()
            .method(method)
            .uri(path)
            .body(Full::new(Bytes::from(body.to_string())))
            .unwrap();
        let res = handle(req, registry, opts).await;
        let status = res.status().as_u16();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn put_get_delete_round_trip() {
        let r = Registry::new();
        let o = AdminOptions::default();
        let body = r#"{"backends":[{"id":"a","url":"https://a","weight":1}],"insights":{"enabled":true,"inject":false,"sampleRate":10}}"#;
        assert_eq!(
            call(&r, &o, "PUT", "/targets/App.Test", body).await,
            (204, String::new())
        );
        let (status, got) = call(&r, &o, "GET", "/targets/app.test", "").await;
        assert_eq!(status, 200);
        let got: Value = serde_json::from_str(&got).unwrap();
        assert_eq!(
            got,
            json!({
                "host": "app.test",
                "backends": [{ "id": "a", "url": "https://a", "weight": 1, "insecureSkipVerify": false }],
                "insights": { "enabled": true, "inject": false, "sampleRate": 10 }
            })
        );
        assert_eq!(call(&r, &o, "DELETE", "/targets/app.test", "").await.0, 204);
        assert_eq!(
            call(&r, &o, "GET", "/targets/app.test", "").await,
            (
                404,
                "edge: no target registered for host app.test".to_string()
            )
        );
    }

    #[tokio::test]
    async fn refuses_bad_bodies_with_the_typescript_texts() {
        let r = Registry::new();
        let o = AdminOptions::default();
        let put = |b: &'static str| call(&r, &o, "PUT", "/targets/v.test", b);
        assert_eq!(
            put(r#"{"backends":[{"url":"https://a","weight":1}],"x":1}"#)
                .await
                .1,
            "edge: invalid request body"
        );
        assert_eq!(
            put(r#"{"backends":[{"url":"https://a","weight":1}],"insights":{"enabled":true}}"#)
                .await
                .1,
            "edge: invalid insights settings"
        );
        assert_eq!(
            put(r#"{"backends":[{"url":"https://a","weight":-1}]}"#)
                .await
                .1,
            "edge: backend \"https://a\" has a negative weight -1"
        );
        assert!(
            put("{nope")
                .await
                .1
                .starts_with("edge: invalid request body: ")
        );
        assert_eq!(put(r#"{"backends":[{"url":"https://r","weight":1,"via":{"url":"https://r","caPem":"P","token":"t"}}]}"#).await.0, 400);
    }

    #[tokio::test]
    async fn other_methods_and_paths() {
        let r = Registry::new();
        let o = AdminOptions::default();
        assert_eq!(call(&r, &o, "POST", "/targets/x.test", "").await.0, 405);
        assert_eq!(call(&r, &o, "GET", "/targets/", "").await.0, 404);
        assert_eq!(call(&r, &o, "GET", "/", "").await.0, 404);
        assert_eq!(
            call(&r, &o, "GET", "/insights/drain", "").await,
            (200, r#"{"batches":[]}"#.to_string())
        );
        assert_eq!(call(&r, &o, "POST", "/insights/drain", "").await.0, 405);
    }

    #[tokio::test]
    async fn the_drain_empties_the_shared_aggregator() {
        use crate::insights::aggregator::{Device, Sample};
        use crate::insights::histogram::Metric;
        let r = Registry::new();
        let aggregator = Arc::new(Aggregator::default());
        let o = AdminOptions {
            insights: Some(Arc::clone(&aggregator)),
            ..AdminOptions::default()
        };
        aggregator.add(&Sample {
            host: "si.test".into(),
            environment_id: "env_a".into(),
            content_id: String::new(),
            route: "/".into(),
            metric: Metric::Ttfb,
            device: Device::Desktop,
            value: 50.0,
        });
        let (status, body) = call(&r, &o, "GET", "/insights/drain", "").await;
        assert_eq!(status, 200);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["batches"].as_array().unwrap().len(), 1);
        assert_eq!(v["batches"][0]["host"], "si.test");
        assert_eq!(
            call(&r, &o, "GET", "/insights/drain", "").await.1,
            r#"{"batches":[]}"#
        );
    }

    #[tokio::test]
    async fn cluster_mode_answers_only_the_drain_with_its_token() {
        let r = Registry::new();
        let o = AdminOptions {
            drain_token: Some("s3cret".into()),
            ..AdminOptions::default()
        };
        assert_eq!(call(&r, &o, "GET", "/targets/x.test", "").await.0, 404);
        assert_eq!(call(&r, &o, "GET", "/insights/drain", "").await.0, 403);
        assert_eq!(
            call(&r, &o, "GET", "/insights/drain?token=nope", "")
                .await
                .0,
            403
        );
        assert_eq!(
            call(&r, &o, "GET", "/insights/drain?token=s3cret", "")
                .await
                .0,
            200
        );
    }

    #[test]
    fn token_matches_needs_the_exact_token() {
        assert!(token_matches(Some("a"), "a"));
        assert!(!token_matches(Some("a "), "a"));
        assert!(!token_matches(None, "a"));
    }
}
