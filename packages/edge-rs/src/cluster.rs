// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Cluster mode (`NBO_EDGE_SOURCE=kubernetes`): the public edge inside a
//! cluster. Three listeners: HTTP (ACME answers, the 308 to HTTPS, the
//! data plane), HTTPS (the certificate picked by SNI from the target's
//! Secret, HTTP/2 or HTTP/1.1 by ALPN, ACME answers, the data plane) and
//! the drain-only admin API. The route table and certificates come from
//! the Kubernetes API (`kube_source.rs`). Port of
//! `packages/edge/src/cluster-listeners.ts` and `main.ts`'s
//! `startClusterEdge`.

use std::io;
use std::sync::Arc;

use http::header::{CONTENT_TYPE, HOST, LOCATION};
use http::{HeaderValue, Request, Response, StatusCode};
use rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;

use crate::admin::{self, AdminOptions};
use crate::certs::{CertStore, SniResolver};
use crate::config::{self, Env};
use crate::insights::aggregator::Aggregator;
use crate::kube_source::{KubeConfig, KubeSource};
use crate::proxy::{self, Clients, EdgeBody, ProxyOptions, Scheme, empty, full, request_url, text};
use crate::registry::{Registry, Snapshot, normalize_host};
use crate::server::{self, VisitorBody, alpn, bind_any};
use crate::text::latin1;

pub const ACME_PREFIX: &str = "/.well-known/acme-challenge/";

/// The answer to an ACME http-01 request, for any host, when `req` is
/// one: the pending token's key authorization, or 404.
pub fn acme_answer<B>(req: &Request<B>, snapshot: &Snapshot) -> Option<Response<EdgeBody>> {
    let url = request_url(req.uri())?;
    let token = url.path().strip_prefix(ACME_PREFIX)?;
    Some(match snapshot.challenges.get(token) {
        Some(answer) => {
            let mut res = Response::new(full(answer.clone()));
            res.headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
            res
        }
        None => text(StatusCode::NOT_FOUND, "not found"),
    })
}

/// The 308 to HTTPS, for a target with `tls`, `redirectHttps` and a loaded
/// certificate only: a missing Secret must never send visitors into a
/// failing handshake.
pub fn https_redirect<B>(
    req: &Request<B>,
    snapshot: &Snapshot,
    certs: &CertStore,
) -> Option<Response<EdgeBody>> {
    let host_header = req.headers().get(HOST).map(|v| latin1(v.as_bytes()));
    let host = normalize_host(host_header.as_deref().unwrap_or(""));
    let target = snapshot.target(&host)?;
    if target.tls.is_none() || target.redirect_https != Some(true) {
        return None;
    }
    certs.for_host(&host, snapshot)?;
    let url = request_url(req.uri())?;
    let query = url.query().filter(|q| !q.is_empty());
    let location = match query {
        Some(q) => format!("https://{host}{}?{q}", url.path()),
        None => format!("https://{host}{}", url.path()),
    };
    let location = HeaderValue::from_str(&location).ok()?;
    let mut res = empty(StatusCode::PERMANENT_REDIRECT);
    res.headers_mut().insert(LOCATION, location);
    Some(res)
}

struct ClusterState {
    registry: Arc<Registry>,
    certs: Arc<CertStore>,
    http: ProxyOptions,
    https: ProxyOptions,
    admin: AdminOptions,
}

async fn on_http(req: Request<VisitorBody>, state: Arc<ClusterState>) -> Response<EdgeBody> {
    let snapshot = state.registry.snapshot();
    if let Some(res) = acme_answer(&req, &snapshot) {
        return res;
    }
    if let Some(res) = https_redirect(&req, &snapshot, &state.certs) {
        return res;
    }
    drop(snapshot);
    proxy::handle(req, &state.registry, &state.http).await
}

async fn on_https(req: Request<VisitorBody>, state: Arc<ClusterState>) -> Response<EdgeBody> {
    if let Some(res) = acme_answer(&req, &state.registry.snapshot()) {
        return res;
    }
    proxy::handle(req, &state.registry, &state.https).await
}

/// The HTTPS listener's TLS settings: the certificate by SNI, and ALPN
/// `h2` (unless HTTP/2 is off) and `http/1.1`.
pub fn tls_config(
    registry: Arc<Registry>,
    certs: Arc<CertStore>,
    http2: bool,
) -> Result<ServerConfig, String> {
    let mut config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("edge: tls: {e}"))?
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(SniResolver { registry, certs }));
    config.alpn_protocols = alpn(http2);
    Ok(config)
}

/// Runs cluster mode. The first poll of the cluster API finishes (success
/// or not) before any listener opens, so a new pod never answers 404 or
/// fails a handshake for hosts it simply hasn't loaded yet.
pub async fn run(env: &Env, namespace: String, drain_token: String) -> Result<(), String> {
    let config = config::resolve_cluster_config(env)?;
    let ca_pem =
        String::from_utf8_lossy(&config::read_file(&config.ca_file, "kube CA")?).into_owned();
    let registry = Arc::new(Registry::new());
    let certs = Arc::new(CertStore::new());
    let mut source = KubeSource::new(
        KubeConfig {
            api_base: config.api_base.clone(),
            token_file: config.token_file.clone(),
            ca_pem,
            namespace,
            interval: config.interval,
        },
        Arc::clone(&registry),
        Arc::clone(&certs),
    )?;
    source.poll_once().await;
    let poller = tokio::spawn(source.run());

    let clients = Arc::new(Clients::new(config::header_timeout(env))?);
    let insights = Arc::new(Aggregator::default());
    let options = |scheme| ProxyOptions {
        clients: Arc::clone(&clients),
        scheme: Some(scheme),
        insights: Arc::clone(&insights),
    };
    let state = Arc::new(ClusterState {
        registry: Arc::clone(&registry),
        certs: Arc::clone(&certs),
        http: options(Scheme::Http),
        https: options(Scheme::Https),
        admin: AdminOptions {
            drain_token: Some(drain_token),
            insights: Some(Arc::clone(&insights)),
        },
    });
    let acceptor = TlsAcceptor::from(Arc::new(tls_config(
        Arc::clone(&registry),
        Arc::clone(&certs),
        config::http2_enabled(env),
    )?));

    let bind = |port| bind_any(port).map_err(|e: io::Error| format!("edge: listen :{port}: {e}"));
    let http_listener = bind(config.http_port)?;
    let https_listener = bind(config.https_port)?;
    let admin_listener = bind(config.admin_port)?;
    let port = |l: &tokio::net::TcpListener| l.local_addr().map(|a| a.port()).unwrap_or(0);
    println!(
        "edge: cluster mode listening on :{} (http), :{} (https), :{} (admin)",
        port(&http_listener),
        port(&https_listener),
        port(&admin_listener)
    );

    let s = Arc::clone(&state);
    let http_task = tokio::spawn(server::serve_http1(http_listener, move |req| {
        on_http(req, Arc::clone(&s))
    }));
    let s = Arc::clone(&state);
    let https_task = tokio::spawn(server::serve_tls(https_listener, acceptor, move |req| {
        on_https(req, Arc::clone(&s))
    }));
    let s = state;
    let admin_task = tokio::spawn(server::serve_http1(admin_listener, move |req| {
        let s = Arc::clone(&s);
        async move { admin::handle(req, &s.registry, &s.admin).await }
    }));
    // Everything runs forever; one task ending (a panic) ends the process.
    let ended = tokio::select! {
        r = http_task => ("http listener", r),
        r = https_task => ("https listener", r),
        r = admin_task => ("admin API", r),
        r = poller => ("kubernetes poller", r),
    };
    Err(match ended {
        (name, Err(e)) => format!("edge: {name} failed: {e}"),
        (name, Ok(())) => format!("edge: {name} stopped"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::certs::tests::pair;
    use crate::proxy::empty_body;
    use crate::route_table::parse_route_table;
    use http_body_util::BodyExt;

    fn setup() -> (Registry, CertStore) {
        let registry = Registry::new();
        let table = parse_route_table(
            r#"{"version":1,"targets":{
                "a.test":{"backends":[{"url":"http://127.0.0.1:1","weight":1}],"tls":"a-tls","redirectHttps":true},
                "b.test":{"backends":[{"url":"http://127.0.0.1:1","weight":1}],"tls":"b-tls"},
                "nocert.test":{"backends":[{"url":"http://127.0.0.1:1","weight":1}],"tls":"missing","redirectHttps":true}
            },"challenges":{"tok1":"tok1.keyauth"}}"#,
        )
        .unwrap();
        registry.replace_table(&table).unwrap();
        let certs = CertStore::new();
        let (c, k) = pair("a.test");
        certs.set("a-tls", &c, &k).unwrap();
        let (c, k) = pair("b.test");
        certs.set("b-tls", &c, &k).unwrap();
        (registry, certs)
    }

    fn req(host: &str, target: &str) -> Request<EdgeBody> {
        Request::builder()
            .uri(target)
            .header(HOST, host)
            .body(empty_body())
            .unwrap()
    }

    async fn body(res: Response<EdgeBody>) -> String {
        String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
    }

    #[tokio::test]
    async fn acme_answers_any_host_and_404s_unknown_tokens() {
        let (registry, _) = setup();
        let snap = registry.snapshot();
        let res = acme_answer(
            &req("unregistered.test", "/.well-known/acme-challenge/tok1"),
            &snap,
        )
        .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[CONTENT_TYPE], "text/plain");
        assert_eq!(body(res).await, "tok1.keyauth");
        let res = acme_answer(&req("a.test", "/.well-known/acme-challenge/nope"), &snap).unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert!(acme_answer(&req("a.test", "/other"), &snap).is_none());
    }

    #[test]
    fn redirects_only_with_tls_redirect_and_a_loaded_certificate() {
        let (registry, certs) = setup();
        let snap = registry.snapshot();
        let res = https_redirect(&req("A.Test:80", "/x/y?q=1"), &snap, &certs).unwrap();
        assert_eq!(res.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(res.headers()[LOCATION], "https://a.test/x/y?q=1");
        let res = https_redirect(&req("a.test", "/z?"), &snap, &certs).unwrap();
        assert_eq!(res.headers()[LOCATION], "https://a.test/z");
        assert!(https_redirect(&req("b.test", "/"), &snap, &certs).is_none());
        assert!(https_redirect(&req("nocert.test", "/"), &snap, &certs).is_none());
        assert!(https_redirect(&req("unknown.test", "/"), &snap, &certs).is_none());
    }

    #[test]
    fn alpn_offers_h2_unless_off() {
        let registry = Arc::new(Registry::new());
        let certs = Arc::new(CertStore::new());
        let on = tls_config(Arc::clone(&registry), Arc::clone(&certs), true).unwrap();
        assert_eq!(
            on.alpn_protocols,
            vec![b"h2".to_vec(), b"http/1.1".to_vec()]
        );
        let off = tls_config(registry, certs, false).unwrap();
        assert_eq!(off.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }
}
