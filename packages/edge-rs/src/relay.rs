// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Relay mode (`NBO_EDGE_MODE=relay`): the edge inside a private cluster.
//! The public edge reaches it over TLS (its CA pinned there) with a token
//! and the Service to forward to; the relay checks both and forwards.
//! Port of `packages/edge/src/relay.ts` and `relay-server.ts`.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http::header::CONTENT_LENGTH;
use http::{Method, Request, Response, StatusCode, Uri};
use http_body_util::BodyExt;
use hyper::body::Body;
use rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;
use url::Url;

use crate::admin::token_matches;
use crate::certs::pem_pair;
use crate::config::{self, Env};
use crate::proxy::{
    BoxError, Clients, EdgeBody, RELAY_TOKEN_HEADER, RELAY_UPSTREAM_HEADER, empty_body,
    forward_headers, request_url, response_headers, text,
};
use crate::server::{bind_any, serve_tls};
use crate::text::header_joined;

/// The relay's wait for its upstream's headers when no
/// `NBO_EDGE_HEADER_TIMEOUT_MS` is set: undici's default, which the Node
/// relay's `fetch` used.
pub const RELAY_HEADER_TIMEOUT: Duration = Duration::from_secs(300);

pub struct RelayOptions {
    pub token: String,
    pub clients: Clients,
    /// Tests only: the address to connect to once `x-nbo-upstream` has
    /// passed the pattern.
    pub upstream_override: Option<String>,
}

// [a-z0-9-]{min,max}
fn label(s: &str, max: usize, hyphen: bool) -> bool {
    (1..=max).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || (hyphen && b == b'-'))
}

/// Only in-cluster Services of project namespaces on port 8080 are
/// reachable through a relay:
/// `^[a-z0-9-]{1,63}\.nbo-p-[a-z0-9]{1,16}\.svc\.cluster\.local:8080$`.
pub fn upstream_allowed(upstream: &str) -> bool {
    let Some(rest) = upstream.strip_suffix(".svc.cluster.local:8080") else {
        return false;
    };
    let Some((service, namespace)) = rest.split_once('.') else {
        return false;
    };
    let Some(project) = namespace.strip_prefix("nbo-p-") else {
        return false;
    };
    label(service, 63, true) && label(project, 16, false)
}

/// The path and query of a request target. An absolute-form target
/// (`GET http://evil.example/ HTTP/1.1`) is never followed: only its path
/// and query are used, and the upstream comes solely from
/// `x-nbo-upstream`.
pub fn path_only(uri: &Uri) -> String {
    // An absolute-form target's path_and_query is its path and query
    // alone; anything not starting with a slash (`*`) is the root.
    match uri.path_and_query().map(|pq| pq.as_str()) {
        Some(pq) if pq.starts_with('/') => pq.to_string(),
        _ => "/".to_string(),
    }
}

/// Handles one relayed request: 403 for a missing or wrong token, 400 for
/// an upstream outside the pattern, else the upstream's answer (502
/// starting `relay: ` when it can't be reached).
pub async fn handle<B>(req: Request<B>, opts: &RelayOptions) -> Response<EdgeBody>
where
    B: Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    let given = header_joined(req.headers(), RELAY_TOKEN_HEADER, ", ");
    if !token_matches(given.as_deref(), &opts.token) {
        return text(StatusCode::FORBIDDEN, "relay: forbidden");
    }
    let upstream = header_joined(req.headers(), RELAY_UPSTREAM_HEADER, ", ").unwrap_or_default();
    if !upstream_allowed(&upstream) {
        return text(StatusCode::BAD_REQUEST, "relay: bad upstream");
    }
    let path: Uri = path_only(req.uri())
        .parse()
        .unwrap_or_else(|_| Uri::from_static("/"));
    let Some(incoming) = request_url(&path) else {
        return text(StatusCode::BAD_REQUEST, "relay: bad request target");
    };
    let addr = opts.upstream_override.as_deref().unwrap_or(&upstream);
    let query = incoming
        .query()
        .filter(|q| !q.is_empty())
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = match Url::parse(&format!("http://{addr}{}{query}", incoming.path())) {
        Ok(u) => u,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("relay: {e}")),
    };

    let (parts, body) = req.into_parts();
    let mut headers = forward_headers(&parts.headers);
    headers.remove(RELAY_TOKEN_HEADER);
    headers.remove(RELAY_UPSTREAM_HEADER);
    let has_body = parts.method != Method::GET && parts.method != Method::HEAD;
    let body = if has_body {
        body.map_err(Into::into).boxed_unsync()
    } else {
        headers.remove(CONTENT_LENGTH);
        empty_body()
    };
    // x-forwarded-* pass through as received: the public edge set them.
    let response = match opts
        .clients
        .send_plain(parts.method, &url, headers, body)
        .await
    {
        Ok(r) => r,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("relay: {e}")),
    };
    let (parts, body) = response.into_parts();
    let mut res = Response::new(body.map_err(|e| -> BoxError { Box::new(e) }).boxed_unsync());
    *res.status_mut() = parts.status;
    *res.headers_mut() = response_headers(&parts.headers);
    res
}

/// Runs relay mode: HTTPS with the certificate in `NBO_RELAY_TLS_CERT` and
/// `NBO_RELAY_TLS_KEY`, HTTP/1.1 only.
pub async fn run(env: &Env, token: String) -> Result<(), String> {
    let cert_file = required(env, "NBO_RELAY_TLS_CERT")?;
    let key_file = required(env, "NBO_RELAY_TLS_KEY")?;
    let (chain, key) = pem_pair(
        &config::read_file(&cert_file, "relay certificate")?,
        &config::read_file(&key_file, "relay key")?,
    )
    .map_err(|e| format!("edge: relay TLS: {e}"))?;
    let tls =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("edge: tls: {e}"))?
            .with_no_client_auth()
            .with_single_cert(chain, key)
            .map_err(|e| format!("edge: relay TLS: {e}"))?;
    let opts = Arc::new(RelayOptions {
        token,
        clients: Clients::new(config::header_timeout_or(env, RELAY_HEADER_TIMEOUT))?,
        upstream_override: config::resolve_relay_upstream_override(env)?,
    });
    let port = config::resolve_relay_port(env)?;
    let listener = bind_any(port).map_err(|e: io::Error| format!("edge: listen :{port}: {e}"))?;
    println!(
        "edge: relay listening on :{}",
        listener.local_addr().map(|a| a.port()).unwrap_or(port)
    );
    serve_tls(listener, TlsAcceptor::from(Arc::new(tls)), move |req| {
        let opts = Arc::clone(&opts);
        async move { handle(req, &opts).await }
    })
    .await;
    Err("edge: relay listener stopped".to_string())
}

fn required(env: &Env, name: &str) -> Result<String, String> {
    match env.get(name) {
        Some(v) if !v.trim().is_empty() => Ok(v.to_string()),
        _ => Err(format!("edge: {name} is required")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_pattern() {
        for ok in [
            "web.nbo-p-abc123.svc.cluster.local:8080",
            "a.nbo-p-a.svc.cluster.local:8080",
            "my-app-2.nbo-p-0123456789abcdef.svc.cluster.local:8080",
        ] {
            assert!(upstream_allowed(ok), "{ok}");
        }
        let long_service = format!("{}.nbo-p-a.svc.cluster.local:8080", "a".repeat(64));
        for bad in [
            "",
            "127.0.0.1:8080",
            "evil.example:8080",
            "web.nbo-p-abc123.svc.cluster.local:80",
            "web.nbo-p-abc123.svc.cluster.local",
            "web.kube-system.svc.cluster.local:8080",
            "Web.nbo-p-abc123.svc.cluster.local:8080",
            "web.nbo-p-abc123.svc.cluster.local:8080/x",
            "web.nbo-p-abc-123.svc.cluster.local:8080",
            "web.nbo-p-0123456789abcdefg.svc.cluster.local:8080",
            "a.b.nbo-p-x.svc.cluster.local:8080",
            ".nbo-p-x.svc.cluster.local:8080",
            "web.nbo-p-.svc.cluster.local:8080",
            "web.nbo-p-x.svc.cluster.local:8080\n",
            &long_service,
        ] {
            assert!(!upstream_allowed(bad), "{bad:?}");
        }
    }

    #[test]
    fn path_only_never_keeps_a_host() {
        let p = |s: &str| path_only(&s.parse::<Uri>().unwrap());
        assert_eq!(p("/a/b?x=1"), "/a/b?x=1");
        assert_eq!(p("http://evil.example/secret?q=1"), "/secret?q=1");
        assert_eq!(p("http://evil.example"), "/");
        assert_eq!(p("*"), "/");
    }

    #[test]
    fn token_check_is_exact() {
        assert!(token_matches(Some("relay-token"), "relay-token"));
        for bad in [
            None,
            Some(""),
            Some("relay-tokeN"),
            Some("relay-token "),
            Some("short"),
        ] {
            assert!(!token_matches(bad, "relay-token"), "{bad:?}");
        }
    }
}
