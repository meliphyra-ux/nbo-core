// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Taking one beacon (`POST /_nbo/insights/v1/vitals`). Port of
//! `packages/edge/src/insights/beacon.ts`.
//!
//! Well-formed beacons get 204 even when they are not counted (bot,
//! unknown environment, over a limit), so a client learns nothing from the
//! answer; a malformed one gets 400; a host with Speed Insights off gets
//! 404. Nothing about the visitor is kept: the cookie is only read to find
//! the environment of a page that did not say (manual tag).

use bytes::Bytes;
use http::header::{ALLOW, CONTENT_LENGTH, USER_AGENT};
use http::{HeaderValue, Method, Request, Response, StatusCode};
use http_body_util::BodyExt;
use hyper::body::Body;
use serde_json::Value;

use super::aggregator::{Aggregator, Device, Sample};
use super::histogram::Metric;
use super::route::{MAX_ROUTE_LENGTH, normalize_route};
use crate::proxy::{BoxError, EdgeBody, empty, text};
use crate::registry::Target;
use crate::sticky::{pick_sticky, read_visitor_id};
use crate::text::{header_joined, js_trim, latin1};

pub const MAX_BEACON_BYTES: usize = 2048;
const MAX_TIMING_MS: f64 = 120_000.0;
const MAX_CLS: f64 = 10.0;

/// `/bot|crawl|spider|slurp|headless|lighthouse|pagespeed|gtmetrix|phantomjs|^$/i`:
/// crawlers, headless browsers and lab tools (Lighthouse and PageSpeed runs
/// are lab data, not real visitors). An empty user-agent is a bot too:
/// browsers always send one.
pub fn is_bot(user_agent: &str) -> bool {
    const WORDS: [&str; 9] = [
        "bot",
        "crawl",
        "spider",
        "slurp",
        "headless",
        "lighthouse",
        "pagespeed",
        "gtmetrix",
        "phantomjs",
    ];
    // Case-insensitive as a non-unicode JavaScript regex is: ASCII letters
    // only (no non-ASCII character folds to an ASCII one).
    let lower = user_agent.to_ascii_lowercase();
    user_agent.is_empty() || WORDS.iter().any(|w| lower.contains(w))
}

/// `^[A-Za-z0-9:._-]{0,128}$`, for environment and content ids.
fn is_id(s: &str) -> bool {
    s.len() <= 128
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b":._-".contains(&c))
}

/// A string's length as JavaScript counts it (UTF-16 code units).
fn js_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` in UTF-16 code units. A surrogate pair the cut would
/// split is left out whole (JavaScript would keep its first half).
fn js_slice(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

fn no_content() -> Response<EdgeBody> {
    empty(StatusCode::NO_CONTENT)
}

fn bad(reason: &str) -> Response<EdgeBody> {
    text(
        StatusCode::BAD_REQUEST,
        format!("edge: invalid beacon: {reason}"),
    )
}

enum Read {
    Text(String),
    TooLarge,
    Failed,
}

// The body as text, or TooLarge past `limit` bytes (declared or read).
async fn read_limited<B>(body: B, declared: Option<&HeaderValue>, limit: usize) -> Read
where
    B: Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    let declared = declared
        .and_then(|v| js_trim(&latin1(v.as_bytes())).parse::<f64>().ok())
        .unwrap_or(0.0);
    if declared > limit as f64 {
        return Read::TooLarge;
    }
    let mut body = Box::pin(body);
    let mut bytes = Vec::new();
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else {
            return Read::Failed;
        };
        if let Ok(data) = frame.into_data() {
            bytes.extend_from_slice(&data);
            if bytes.len() > limit {
                return Read::TooLarge;
            }
        }
    }
    // As TextDecoder: a leading BOM is dropped, bad UTF-8 replaced.
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    Read::Text(String::from_utf8_lossy(bytes).into_owned())
}

/// Takes one request to the beacon path of `target`.
pub async fn handle_beacon<B>(
    req: Request<B>,
    target: &Target,
    aggregator: &Aggregator,
) -> Response<EdgeBody>
where
    B: Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    if !target.insights.is_some_and(|s| s.enabled) {
        return text(StatusCode::NOT_FOUND, "not found");
    }
    if req.method() != Method::POST {
        let mut res = text(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
        res.headers_mut()
            .insert(ALLOW, HeaderValue::from_static("POST"));
        return res;
    }

    // The rate cap comes first: a beacon over it is not read or parsed.
    if !aggregator.admit(&target.host) {
        return no_content();
    }
    let (parts, body) = req.into_parts();
    let text_body =
        match read_limited(body, parts.headers.get(CONTENT_LENGTH), MAX_BEACON_BYTES).await {
            Read::Text(t) => t,
            Read::TooLarge => return bad("body over 2 KB"),
            // The visitor went away mid-body: nothing to answer.
            Read::Failed => return no_content(),
        };
    let Ok(body) = serde_json::from_str::<Value>(&text_body) else {
        return bad("not JSON");
    };
    let Value::Object(body) = body else {
        return bad("not an object");
    };

    let Some(metric) = body
        .get("metric")
        .and_then(Value::as_str)
        .and_then(Metric::parse)
    else {
        return bad("unknown metric");
    };
    let value = match body.get("value").and_then(Value::as_f64) {
        Some(v) if v.is_finite() && v >= 0.0 => v,
        _ => return bad("value is not a finite number \u{2265} 0"),
    };
    let max = if metric == Metric::Cls {
        MAX_CLS
    } else {
        MAX_TIMING_MS
    };
    if value > max {
        return bad("value out of range");
    }
    let route = match body.get("route") {
        Some(Value::String(r)) if js_len(r) <= MAX_ROUTE_LENGTH => r,
        _ => return bad("route"),
    };
    let Some(normalized) = normalize_route(route) else {
        return bad("route is not a path");
    };
    let Some(device) = body
        .get("device")
        .and_then(Value::as_str)
        .and_then(Device::parse)
    else {
        return bad("device");
    };
    let environment_id = match body.get("environmentId") {
        None => None,
        Some(Value::String(e)) if is_id(e) => Some(e.as_str()),
        Some(_) => return bad("environmentId"),
    };
    let content_id = match body.get("contentId") {
        None => "",
        Some(Value::String(c)) if is_id(c) => c.as_str(),
        Some(_) => return bad("contentId"),
    };

    let user_agent = header_joined(&parts.headers, USER_AGENT.as_str(), ", ").unwrap_or_default();
    if is_bot(&user_agent) {
        return no_content();
    }

    let environment = match environment_id {
        Some(e) => {
            if !target
                .backends
                .iter()
                .any(|b| b.id.as_deref().unwrap_or("") == e)
            {
                return no_content();
            }
            e.to_string()
        }
        None => {
            // Manual tag: the page did not say which environment served
            // it. The visitor's cookie picks the same backend the proxy
            // picked.
            let Some(visitor_id) = read_visitor_id(&parts.headers) else {
                return no_content();
            };
            match pick_sticky(target, &visitor_id) {
                Ok(b) => b.id.clone().unwrap_or_default(),
                Err(_) => return no_content(),
            }
        }
    };

    aggregator.add(&Sample {
        host: target.host.clone(),
        environment_id: environment,
        content_id: content_id.to_string(),
        route: js_slice(&normalized, MAX_ROUTE_LENGTH).to_string(),
        metric,
        device,
        value,
    });
    no_content()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::insights::aggregator::Limits;
    use crate::registry::{Backend, InsightsSettings};
    use http_body_util::Full;
    use serde_json::json;
    use std::sync::Arc;

    const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

    fn backend(id: &str, url: &str, weight: i64) -> Backend {
        Backend {
            id: Some(id.into()),
            url: url.into(),
            weight,
            insecure_skip_verify: false,
            via: None,
        }
    }

    fn target(enabled: bool) -> Target {
        Target {
            insights: Some(InsightsSettings {
                enabled,
                inject: false,
                sample_rate: 100,
            }),
            ..Target::new(
                "si.test",
                vec![
                    backend("env_a", "http://127.0.0.1:1", 50),
                    backend("env_b", "http://127.0.0.1:2", 50),
                ],
            )
        }
    }

    fn agg() -> Aggregator {
        // A fixed instant, so every test's beacons fall in one minute.
        Aggregator::new(Limits::default(), Arc::new(|| 1_793_700_942_123))
    }

    fn post(body: &str, headers: &[(&str, &str)]) -> Request<Full<Bytes>> {
        let mut b = Request::builder()
            .method("POST")
            .uri("/_nbo/insights/v1/vitals")
            .header("user-agent", UA);
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        b.body(Full::new(Bytes::from(body.to_string()))).unwrap()
    }

    async fn call(a: &Aggregator, req: Request<Full<Bytes>>) -> (u16, String) {
        let res = handle_beacon(req, &target(true), a).await;
        let status = res.status().as_u16();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    fn batches(a: &Aggregator) -> Vec<Value> {
        a.drain()["batches"].as_array().unwrap().clone()
    }

    #[tokio::test]
    async fn counts_a_valid_beacon_with_204() {
        let a = agg();
        let b = json!({ "metric": "LCP", "value": 1234.5, "route": "/users/12345/posts?x=1", "device": "desktop", "environmentId": "env_a", "contentId": "dep-1" });
        assert_eq!(
            call(&a, post(&b.to_string(), &[])).await,
            (204, String::new())
        );
        let got = batches(&a);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["route"], "/users/[id]/posts");
        assert_eq!(got[0]["environmentId"], "env_a");
        assert_eq!(got[0]["contentId"], "dep-1");
        assert_eq!(got[0]["device"], "desktop");
    }

    #[tokio::test]
    async fn not_found_when_off_and_405_with_allow_for_other_methods() {
        let a = agg();
        let res = handle_beacon(post("{}", &[]), &target(false), &a).await;
        assert_eq!(res.status(), 404);
        for m in ["GET", "PUT"] {
            let req = Request::builder()
                .method(m)
                .body(Full::new(Bytes::new()))
                .unwrap();
            let res = handle_beacon(req, &target(true), &a).await;
            assert_eq!(res.status(), 405, "{m}");
            assert_eq!(res.headers()["allow"], "POST");
        }
    }

    #[tokio::test]
    async fn answers_400_with_the_typescript_reasons() {
        let good = json!({ "metric": "INP", "value": 80, "route": "/a", "device": "mobile" });
        let with = |k: &str, v: Value| {
            let mut g = good.clone();
            g[k] = v;
            g.to_string()
        };
        let long_route = format!("/{}", "a".repeat(200));
        let cases: Vec<(String, &str)> = vec![
            ("{nope".into(), "not JSON"),
            ("".into(), "not JSON"),
            (json!([good]).to_string(), "not an object"),
            ("null".into(), "not an object"),
            (with("metric", json!("FID")), "unknown metric"),
            (
                with("value", json!("80")),
                "value is not a finite number \u{2265} 0",
            ),
            (
                with("value", json!(-1)),
                "value is not a finite number \u{2265} 0",
            ),
            (
                json!({ "metric": "LCP", "value": 120_001, "route": "/a", "device": "mobile" })
                    .to_string(),
                "value out of range",
            ),
            (
                json!({ "metric": "CLS", "value": 10.5, "route": "/a", "device": "mobile" })
                    .to_string(),
                "value out of range",
            ),
            (with("route", json!(5)), "route"),
            (with("route", json!(long_route)), "route"),
            (with("route", json!("users/1")), "route is not a path"),
            (
                with("route", json!("//evil.example/x")),
                "route is not a path",
            ),
            (with("device", json!("tablet")), "device"),
            (with("environmentId", json!("env a")), "environmentId"),
            (with("environmentId", Value::Null), "environmentId"),
            (with("contentId", json!("x/y")), "contentId"),
            (with("contentId", json!("a".repeat(129))), "contentId"),
            (with("pad", json!("x".repeat(2100))), "body over 2 KB"),
        ];
        let a = agg();
        for (body, reason) in cases {
            let (status, text) = call(&a, post(&body, &[])).await;
            assert_eq!(status, 400, "{body:.80}");
            assert_eq!(
                text,
                format!("edge: invalid beacon: {reason}"),
                "{body:.80}"
            );
        }
        assert!(batches(&a).is_empty());
    }

    #[tokio::test]
    async fn a_declared_length_over_2_kb_is_refused_unread() {
        let a = agg();
        let (status, text) = call(&a, post("{}", &[("content-length", "4096")])).await;
        assert_eq!(status, 400);
        assert_eq!(text, "edge: invalid beacon: body over 2 KB");
    }

    #[tokio::test]
    async fn a_route_of_200_utf16_units_is_taken_and_one_more_is_not() {
        let a = agg();
        // "\u{e9}" is one UTF-16 unit but two UTF-8 bytes.
        let ok = format!("/{}", "\u{e9}".repeat(199));
        let b = json!({ "metric": "INP", "value": 80, "route": ok, "device": "mobile", "environmentId": "env_a" });
        assert_eq!(call(&a, post(&b.to_string(), &[])).await.0, 204);
        let over = format!("/{}", "\u{e9}".repeat(200));
        let b = json!({ "metric": "INP", "value": 80, "route": over, "device": "mobile", "environmentId": "env_a" });
        assert_eq!(call(&a, post(&b.to_string(), &[])).await.0, 400);
        // A route that grows past 200 when ids become [id] is cut to 200.
        let grows = "/1".repeat(100);
        let b = json!({ "metric": "INP", "value": 80, "route": grows, "device": "mobile", "environmentId": "env_a" });
        assert_eq!(call(&a, post(&b.to_string(), &[])).await.0, 204);
        let got = batches(&a);
        let routes: Vec<&str> = got.iter().map(|b| b["route"].as_str().unwrap()).collect();
        assert!(routes.contains(&ok.as_str()));
        assert!(
            routes
                .iter()
                .any(|r| r.starts_with("/[id]/[id]") && js_len(r) == 200)
        );
    }

    #[tokio::test]
    async fn bots_empty_user_agents_and_unknown_environments_get_204_uncounted() {
        let a = agg();
        let b = json!({ "metric": "FCP", "value": 300, "route": "/", "device": "desktop", "environmentId": "env_a" }).to_string();
        for ua in [
            "Googlebot/2.1",
            "",
            "Mozilla/5.0 HeadlessChrome/130",
            "Chrome-Lighthouse",
        ] {
            let mut req = post(&b, &[]);
            req.headers_mut()
                .insert("user-agent", HeaderValue::from_str(ua).unwrap());
            assert_eq!(call(&a, req).await.0, 204, "{ua}");
        }
        let mut req = post(&b, &[]);
        req.headers_mut().remove("user-agent");
        assert_eq!(call(&a, req).await.0, 204);
        let unknown = json!({ "metric": "FCP", "value": 300, "route": "/", "device": "desktop", "environmentId": "env_zzz" });
        assert_eq!(call(&a, post(&unknown.to_string(), &[])).await.0, 204);
        // A manual tag without a visitor cookie is not counted either.
        let manual = json!({ "metric": "FCP", "value": 300, "route": "/", "device": "desktop" });
        assert_eq!(call(&a, post(&manual.to_string(), &[])).await.0, 204);
        assert!(batches(&a).is_empty());
    }

    #[tokio::test]
    async fn a_manual_tag_beacon_goes_to_the_backend_the_cookie_picks() {
        let a = agg();
        let id = "0123456789abcdef0123456789abcdef";
        let want = pick_sticky(&target(true), id).unwrap().id.clone().unwrap();
        let b = json!({ "metric": "TTFB", "value": 90, "route": "/p", "device": "desktop" });
        let cookie = format!("nbo_v={id}");
        assert_eq!(
            call(&a, post(&b.to_string(), &[("cookie", &cookie)]))
                .await
                .0,
            204
        );
        let got = batches(&a);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["environmentId"], want.as_str());
    }

    #[tokio::test]
    async fn beacons_over_the_rate_cap_get_204_unread_and_uncounted() {
        let a = Aggregator::new(
            Limits {
                max_beacons_per_host_second: 2,
                ..Limits::default()
            },
            Arc::new(|| 1_793_700_942_123),
        );
        let b = json!({ "metric": "FCP", "value": 300, "route": "/", "device": "desktop", "environmentId": "env_a" }).to_string();
        for _ in 0..2 {
            assert_eq!(call(&a, post(&b, &[])).await.0, 204);
        }
        // Over the cap, even a malformed beacon is not read.
        assert_eq!(call(&a, post("{nope", &[])).await.0, 204);
        assert_eq!(a.dropped(), 1);
        assert_eq!(batches(&a)[0]["count"], 2);
    }

    #[test]
    fn bot_pattern() {
        assert!(is_bot(""));
        assert!(is_bot("Mozilla/5.0 (compatible; BINGBOT/2.0)"));
        assert!(is_bot("PageSpeed Insights"));
        assert!(!is_bot(UA));
    }
}
