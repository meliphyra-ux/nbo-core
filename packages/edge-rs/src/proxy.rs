// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! The data plane: every visitor request is matched to its host's target,
//! a backend is picked for the visitor, and the request is streamed there
//! and the answer streamed back. Port of `packages/edge/src/proxy.ts` and
//! `packages/funcproxy/src/proxy.ts`.
//!
//! Bodies stream both ways and are never buffered. A backend gets
//! `NBO_EDGE_HEADER_TIMEOUT_MS` (30 s) to start answering and no limit on
//! the body after that. Redirects are passed back, never followed. Unlike
//! the Node edge, compressed answers pass through unchanged (the spec's
//! intended difference 1), except a page that gets the Speed Insights tag,
//! which is decoded first (`insights/inject.rs`).

use std::collections::HashMap;
use std::error::Error as StdError;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http::header::{
    CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, HOST, SET_COOKIE,
};
use http::{
    HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode, Uri, Version,
};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full, LengthLimitError, Limited};
use hyper::body::{Body, Frame, SizeHint};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};
use url::Url;

use crate::insights::aggregator::Aggregator;
use crate::insights::beacon::handle_beacon;
use crate::insights::inject::{
    PageEncoding, decoded_body, inserted_body, insights_tag, page_encoding, page_takes_tag,
};
use crate::insights::script::{INSIGHTS_PREFIX, SCRIPT_PATH, VITALS_PATH, script_response};
use crate::navigation::{is_document_navigation, visitor_scheme};
use crate::registry::{Backend, InsightsSettings, Registry, Target};
use crate::sticky::{
    new_visitor_id, pick_sticky, read_visitor_id, strip_visitor_cookie, visitor_cookie,
};
use crate::text::{header_joined, latin1, latin1_bytes};

pub type BoxError = Box<dyn StdError + Send + Sync>;

/// Every body the edge sends: a backend's streamed answer or the edge's own.
pub type EdgeBody = UnsyncBoxBody<Bytes, BoxError>;

/// The header the relay reads its token from. Visitors may never set it.
pub const RELAY_TOKEN_HEADER: &str = "x-nbo-relay-token";
/// The header naming the in-cluster Service the relay forwards to.
pub const RELAY_UPSTREAM_HEADER: &str = "x-nbo-upstream";
/// The Node edge's internal client-address header (`@nbo/nodehost`),
/// dropped in cluster mode like the forwarding headers.
pub const CLIENT_IP_HEADER: &str = "x-nbo-client-ip";

/// The default time a backend gets to start answering.
pub const DEFAULT_HEADER_TIMEOUT: Duration = Duration::from_secs(30);

// RFC 9110 section 7.6.1, and the set Go's httputil.ReverseProxy strips.
// `expect` too: the edge answers 100-continue itself.
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "expect",
];

// Forwarding headers a visitor may not set in cluster mode: the edge
// replaces them from the socket.
const CLUSTER_DROPPED: [&str; 7] = [
    "x-forwarded-proto",
    "x-forwarded-for",
    "x-real-ip",
    "forwarded",
    "cf-connecting-ip",
    "true-client-ip",
    CLIENT_IP_HEADER,
];

/// The listener's own scheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Http,
    Https,
}

impl Scheme {
    pub fn as_str(self) -> &'static str {
        match self {
            Scheme::Http => "http",
            Scheme::Https => "https",
        }
    }
}

/// The visitor's socket address, put in the request's extensions by the
/// listener.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientAddr(pub SocketAddr);

/// How the data plane behaves on one listener.
pub struct ProxyOptions {
    pub clients: Arc<Clients>,
    /// The listener's scheme (cluster mode). When set, the cookie's Secure
    /// flag and `x-forwarded-proto` come from it, `x-forwarded-for` is the
    /// socket's address, and the visitor's own forwarding headers are
    /// dropped. `None` (dev): a TLS terminator in front is believed.
    pub scheme: Option<Scheme>,
    /// Receives Speed Insights beacons; shared with the admin API, which
    /// drains it.
    pub insights: Arc<Aggregator>,
}

// ---------- responses the edge makes itself

/// A body from bytes the edge already has.
pub fn full(bytes: impl Into<Bytes>) -> EdgeBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}

/// An empty body.
pub fn empty_body() -> EdgeBody {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed_unsync()
}

/// A plain-text answer, typed as a Fetch `Response` types a string body.
pub fn text(status: StatusCode, body: impl Into<String>) -> Response<EdgeBody> {
    let mut res = Response::new(full(body.into()));
    *res.status_mut() = status;
    res.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain;charset=UTF-8"),
    );
    res
}

/// A bodiless answer.
pub fn empty(status: StatusCode) -> Response<EdgeBody> {
    let mut res = Response::new(empty_body());
    *res.status_mut() = status;
    res
}

/// A JSON answer, as `Response.json` makes it.
pub fn json(status: StatusCode, value: &serde_json::Value) -> Response<EdgeBody> {
    let mut res = Response::new(full(value.to_string()));
    *res.status_mut() = status;
    res.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

/// An error and its causes, as one line.
pub fn describe(err: &(dyn StdError + 'static)) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let more = cause.to_string();
        if !text.contains(&more) {
            text.push_str(": ");
            text.push_str(&more);
        }
        source = cause.source();
    }
    text
}

// ---------- pure helpers

/// Joins a target's path with the request's without doubling or dropping
/// the slash between them (Go's `singleJoiningSlash`).
pub fn join_path(target_path: &str, request_path: &str) -> String {
    let target_ends = target_path.ends_with('/');
    let request_starts = request_path.starts_with('/');
    match (target_ends, request_starts) {
        (true, true) => format!("{target_path}{}", &request_path[1..]),
        (false, false) => format!("{target_path}/{request_path}"),
        _ => format!("{target_path}{request_path}"),
    }
}

/// The target's query and the request's, both kept.
pub fn merge_query(target_query: &str, request_query: &str) -> String {
    if target_query.is_empty() {
        request_query.to_string()
    } else if request_query.is_empty() {
        target_query.to_string()
    } else {
        format!("{target_query}&{request_query}")
    }
}

// The names a Connection header lists, lower-cased.
fn connection_named(headers: &HeaderMap) -> Vec<String> {
    header_joined(headers, "connection", ",")
        .unwrap_or_default()
        .split(',')
        .map(|n| n.trim().to_ascii_lowercase())
        .filter(|n| !n.is_empty())
        .collect()
}

fn without_hop_by_hop(incoming: &HeaderMap, also: &[&str]) -> HeaderMap {
    let named = connection_named(incoming);
    let mut out = HeaderMap::with_capacity(incoming.len());
    for (name, value) in incoming {
        let n = name.as_str();
        if also.contains(&n) || HOP_BY_HOP.contains(&n) || named.iter().any(|c| c == n) {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    out
}

/// The request headers to forward: without `host`, the hop-by-hop
/// headers and any header the `Connection` header names.
pub fn forward_headers(incoming: &HeaderMap) -> HeaderMap {
    without_hop_by_hop(incoming, &["host"])
}

/// The backend's response headers to send on: without the hop-by-hop
/// headers and any header its `Connection` header names.
pub fn response_headers(incoming: &HeaderMap) -> HeaderMap {
    without_hop_by_hop(incoming, &[])
}

/// The request's own URL, read as the Node edge read it: the
/// request-target after `http://localhost`, so dot segments resolve and
/// odd characters are percent-encoded the way a browser's URL parser does.
pub fn request_url(uri: &Uri) -> Option<Url> {
    let target = uri.path_and_query().map_or("/", |pq| pq.as_str());
    if !target.starts_with('/') {
        return None;
    }
    Url::parse(&format!("http://localhost{target}")).ok()
}

/// Where a request for `incoming` goes on `target`: the paths joined and
/// the queries merged.
pub fn outgoing_url(target: &Url, incoming: &Url) -> Url {
    let mut out = target.clone();
    out.set_path(&join_path(target.path(), incoming.path()));
    let query = merge_query(target.query().unwrap_or(""), incoming.query().unwrap_or(""));
    out.set_query(if query.is_empty() { None } else { Some(&query) });
    out
}

/// `new URL(u).host`: the host, with the port when it is not the scheme's
/// default.
fn url_host(u: &Url) -> String {
    let host = u.host_str().unwrap_or("");
    match u.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

// ---------- backend clients

type HttpClient = Client<HttpsConnector<HttpConnector>, EdgeBody>;

/// The connection pools: one verifying certificates against the public
/// roots, one for backends with `insecureSkipVerify`, and one per relay CA
/// (a relay's certificate is trusted only if that CA signed it).
pub struct Clients {
    strict: HttpClient,
    insecure: HttpClient,
    relays: Mutex<HashMap<String, HttpClient>>,
    header_timeout: Duration,
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn tls_config(
    build: impl FnOnce(rustls::ConfigBuilder<ClientConfig, rustls::WantsVerifier>) -> ClientConfig,
) -> Result<ClientConfig, String> {
    let builder = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("edge: tls: {e}"))?;
    Ok(build(builder))
}

fn http_client(config: ClientConfig) -> HttpClient {
    let mut http = HttpConnector::new();
    http.enforce_http(false);
    http.set_nodelay(true);
    let connector = HttpsConnectorBuilder::new()
        .with_tls_config(config)
        .https_or_http()
        .enable_http1()
        .wrap_connector(http);
    Client::builder(TokioExecutor::new())
        // Node (undici) takes backend answers with up to 2000 header lines.
        .http1_max_headers(2000)
        // Below Node's 5 s server keep-alive, so the edge doesn't reuse a
        // connection the backend is about to close (undici uses 4 s).
        .pool_idle_timeout(Duration::from_secs(4))
        .pool_timer(hyper_util::rt::TokioTimer::new())
        .build(connector)
}

/// Accepts any certificate (a backend's per-backend opt-in), while still
/// checking the handshake's signatures.
#[derive(Debug)]
struct AcceptAnyCertificate(Arc<CryptoProvider>);

impl ServerCertVerifier for AcceptAnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

impl Clients {
    pub fn new(header_timeout: Duration) -> Result<Clients, String> {
        let public_roots = RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let strict = tls_config(|b| b.with_root_certificates(public_roots).with_no_client_auth())?;
        let insecure = tls_config(|b| {
            b.dangerous()
                .with_custom_certificate_verifier(Arc::new(AcceptAnyCertificate(provider())))
                .with_no_client_auth()
        })?;
        Ok(Clients {
            strict: http_client(strict),
            insecure: http_client(insecure),
            relays: Mutex::new(HashMap::new()),
            header_timeout,
        })
    }

    pub fn header_timeout(&self) -> Duration {
        self.header_timeout
    }

    fn relay(&self, ca_pem: &str) -> Result<HttpClient, String> {
        let mut relays = self.relays.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(client) = relays.get(ca_pem) {
            return Ok(client.clone());
        }
        let mut roots = RootCertStore::empty();
        for cert in CertificateDer::pem_slice_iter(ca_pem.as_bytes()) {
            let cert = cert.map_err(|e| format!("relay CA: {e}"))?;
            roots.add(cert).map_err(|e| format!("relay CA: {e}"))?;
        }
        if roots.is_empty() {
            return Err("relay CA: no certificate in caPem".to_string());
        }
        let client = http_client(tls_config(|b| {
            b.with_root_certificates(roots).with_no_client_auth()
        })?);
        relays.insert(ca_pem.to_string(), client.clone());
        Ok(client)
    }

    /// Sends one request on through the public-roots pool and waits for
    /// the answer's headers, with the header timeout: the relay's way to
    /// its in-cluster upstream (plain HTTP).
    pub async fn send_plain(
        &self,
        method: Method,
        url: &Url,
        headers: HeaderMap,
        body: EdgeBody,
    ) -> Result<Response<hyper::body::Incoming>, String> {
        send(self, &self.strict, method, url, headers, body).await
    }

    fn for_backend(&self, backend: &Backend) -> Result<HttpClient, String> {
        if let Some(via) = &backend.via {
            return self.relay(&via.ca_pem);
        }
        Ok(if backend.insecure_skip_verify {
            self.insecure.clone()
        } else {
            self.strict.clone()
        })
    }
}

/// The outgoing request body, reporting each frame it hands to the
/// connection and its end (or drop), so the header timeout can start
/// after the upload, as undici's does (it refreshes its headers timer on
/// every body write and again when the body ends).
struct Reporting<B> {
    inner: B,
    progress: tokio::sync::watch::Sender<()>,
}

impl<B> Body for Reporting<B>
where
    B: Body<Data = Bytes, Error = BoxError> + Unpin,
{
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let polled = Pin::new(&mut self.inner).poll_frame(cx);
        if polled.is_ready() {
            self.progress.send_replace(());
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Sends one request on and waits for the answer's headers. The backend
/// gets the header timeout from the last moment the request body made
/// progress (its last chunk, its end, or the client dropping it), never
/// counting a slow upload against it. Headers go as given, plus `Host`
/// from the URL.
async fn send(
    clients: &Clients,
    client: &HttpClient,
    method: Method,
    url: &Url,
    headers: HeaderMap,
    body: EdgeBody,
) -> Result<Response<hyper::body::Incoming>, String> {
    let uri: Uri = url
        .as_str()
        .parse()
        .map_err(|e| format!("bad backend url: {e}"))?;
    let (progress, mut watch) = tokio::sync::watch::channel(());
    let body = Reporting {
        inner: body,
        progress,
    }
    .boxed_unsync();
    let mut req = Request::new(body);
    *req.method_mut() = method;
    *req.uri_mut() = uri;
    *req.version_mut() = Version::HTTP_11;
    *req.headers_mut() = headers;

    let limit = clients.header_timeout;
    let answer = client.request(req);
    tokio::pin!(answer);
    let deadline = tokio::time::sleep(limit);
    tokio::pin!(deadline);
    let mut uploading = true;
    loop {
        tokio::select! {
            res = &mut answer => return res.map_err(|err| describe(&err)),
            () = &mut deadline => {
                return Err(format!("the backend did not answer within {} ms", limit.as_millis()));
            }
            changed = watch.changed(), if uploading => {
                // Err: the body is gone (sent in full, or dropped).
                uploading = changed.is_ok();
                deadline.as_mut().reset(tokio::time::Instant::now() + limit);
            }
        }
    }
}

// ---------- the handler

/// Replaces header `name` with `value`. Whatever the visitor sent under
/// that name is always removed, even when `value` can't be a header value.
/// `value` is latin1 text (as header bytes are read), so a Host with
/// obs-text bytes goes on byte for byte, as Node's ByteString does.
fn set_header(headers: &mut HeaderMap, name: &'static str, value: &str) {
    let name = HeaderName::from_static(name);
    headers.remove(&name);
    if let Ok(v) = HeaderValue::from_bytes(&latin1_bytes(value)) {
        headers.insert(name, v);
    }
}

/// The Host the visitor asked for: over HTTP/2 the `:authority` pseudo
/// header when present (RFC 9113 section 8.3.1), else the `Host` header;
/// over HTTP/1.1 the `Host` header, else the request target's authority.
pub fn request_host<B>(req: &Request<B>) -> String {
    let authority = || req.uri().authority().map(|a| a.to_string());
    if req.version() == Version::HTTP_2
        && let Some(a) = authority()
    {
        return a;
    }
    match req.headers().get(HOST) {
        Some(v) => latin1(v.as_bytes()),
        None => authority().unwrap_or_default(),
    }
}

/// Speed Insights endpoints, answered by the edge itself before any
/// backend is picked (no visitor cookie is set for them): the script and
/// the beacon; anything else under the prefix is 404. On a host with
/// Speed Insights off these paths go to the app.
async fn insights_endpoint<B>(
    req: Request<B>,
    path: &str,
    target: &Target,
    settings: InsightsSettings,
    aggregator: &Aggregator,
) -> Response<EdgeBody>
where
    B: Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    let method = req.method();
    if path == SCRIPT_PATH && (method == Method::GET || method == Method::HEAD) {
        return script_response(settings.sample_rate, method == Method::HEAD);
    }
    if path == VITALS_PATH {
        return handle_beacon(req, target, aggregator).await;
    }
    text(StatusCode::NOT_FOUND, "not found")
}

/// Inserts the Speed Insights tag into a page that gets it: a `GET`
/// document navigation answered 200 with HTML in an ASCII-compatible
/// charset, without `no-transform`, on a host with inject on. A gzip,
/// deflate or brotli page is decoded first and sent uncompressed; a page
/// in another coding (zstd) passes through untagged. Everything else,
/// assets above all, streams through untouched, compressed or not.
fn with_tag(
    body: EdgeBody,
    status: StatusCode,
    backend_headers: &HeaderMap,
    out_headers: &mut HeaderMap,
    environment_id: &str,
    sample_rate: u8,
) -> EdgeBody {
    if status != StatusCode::OK || !page_takes_tag(backend_headers) {
        return body;
    }
    let body = match page_encoding(backend_headers) {
        PageEncoding::Plain => body,
        PageEncoding::Decode(codings) => {
            out_headers.remove(CONTENT_ENCODING);
            decoded_body(body, &codings)
        }
        PageEncoding::Opaque => return body,
    };
    let content_id =
        header_joined(backend_headers, "x-nbo-deployment-id", ", ").unwrap_or_default();
    let tag = insights_tag(environment_id, &content_id, sample_rate);
    out_headers.remove(CONTENT_LENGTH);
    // The bytes changed, so a strong validator no longer holds; a weak one
    // still does (the insertion is the same for the same page).
    if let Some(etag) = header_joined(out_headers, "etag", ", ")
        && !etag.starts_with("W/")
    {
        set_header(out_headers, "etag", &format!("W/{etag}"));
    }
    inserted_body(body, &tag)
}

/// Handles one data-plane request: 404 for an unknown host, else the
/// visitor's backend answers (502 starting `edge: ` when it can't).
pub async fn handle<B>(
    req: Request<B>,
    registry: &Registry,
    opts: &ProxyOptions,
) -> Response<EdgeBody>
where
    B: Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    let host = request_host(&req);
    let snapshot = registry.snapshot();
    let Some(target) = snapshot.target(&host).cloned() else {
        return text(
            StatusCode::NOT_FOUND,
            format!("edge: no target registered for host {host}"),
        );
    };
    let Some(incoming_url) = request_url(req.uri()) else {
        return text(StatusCode::BAD_REQUEST, "edge: bad request target");
    };

    let insights = target.insights.filter(|s| s.enabled);
    if let Some(settings) = insights
        && incoming_url.path().starts_with(INSIGHTS_PREFIX)
    {
        return insights_endpoint(req, incoming_url.path(), &target, settings, &opts.insights)
            .await;
    }

    // Keep the visitor on one cloud: their cookie id picks the backend (see
    // sticky.rs). A visitor without one gets a new id, served and, on a
    // page navigation, remembered in the same response. Other requests
    // without a cookie (assets, API calls) get no cookie: Set-Cookie on an
    // asset stops CDNs from caching it.
    let known_id = read_visitor_id(req.headers());
    let visitor_id = known_id.clone().unwrap_or_else(new_visitor_id);
    let revalidate = is_revalidate_request(req.method(), incoming_url.path());

    let scheme = match opts.scheme {
        Some(s) => s.as_str(),
        None => visitor_scheme(false, req.headers()),
    };
    let navigation = is_document_navigation(req.headers());
    let client_addr = req
        .extensions()
        .get::<ClientAddr>()
        .map(|c| c.0.ip().to_canonical());

    let (parts, body) = req.into_parts();
    let mut headers = parts.headers;
    let cf_ip = if opts.scheme.is_some() {
        header_joined(&headers, "cf-connecting-ip", ", ")
    } else {
        None
    };
    strip_visitor_cookie(&mut headers);
    headers.remove(RELAY_TOKEN_HEADER);
    headers.remove(RELAY_UPSTREAM_HEADER);
    if opts.scheme.is_some() {
        for h in CLUSTER_DROPPED {
            headers.remove(h);
        }
    }
    let has_body = parts.method != Method::GET && parts.method != Method::HEAD;
    let tag_page = navigation && parts.method == Method::GET;
    let mut headers = forward_headers(&headers);
    if !has_body {
        // The body is not forwarded, so neither is its length.
        headers.remove(CONTENT_LENGTH);
    }

    set_header(&mut headers, "x-forwarded-host", &host);
    set_header(&mut headers, "x-forwarded-proto", scheme);
    if opts.scheme.is_some()
        && let Some(client) = client_addr
    {
        // A Cloudflare-marked target believes cf-connecting-ip from a peer
        // inside Cloudflare's ranges; anyone else is the socket's address.
        let forwarded_for = match cf_ip.as_deref() {
            Some(cf)
                if target.cloudflare == Some(true)
                    && cf.parse::<IpAddr>().is_ok()
                    && snapshot.cloudflare.has_addr(client) =>
            {
                cf.to_string()
            }
            _ => client.to_string(),
        };
        set_header(&mut headers, "x-forwarded-for", &forwarded_for);
    }

    // A revalidation goes to every backend, before any sticky pick: no
    // visitor cookie, no single backend, never cached.
    if revalidate {
        return fan_out_revalidate(
            &opts.clients,
            &host,
            &target.backends,
            &incoming_url,
            headers,
            body,
        )
        .await;
    }
    let backend = match pick_sticky(&target, &visitor_id) {
        Ok(b) => b,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("edge: {e}")),
    };

    let response = match forward(
        &opts.clients,
        backend,
        &incoming_url,
        parts.method,
        headers,
        body,
        has_body,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            // The detail (it can name the backend's URL) goes to the log only.
            eprintln!(
                "edge: backend {} for {host} unreachable: {e}",
                backend.id.as_deref().unwrap_or("(no id)")
            );
            return text(StatusCode::BAD_GATEWAY, "edge: backend unreachable");
        }
    };

    // Lets operators (and tests) see which backend answered: its stable id
    // (the environment id), never its URL. A backend without an id (an older
    // route table) gets no header.
    let (parts, body) = response.into_parts();
    let mut out_headers = response_headers(&parts.headers);
    match &backend.id {
        Some(id) => set_header(&mut out_headers, "x-nbo-edge-backend", id),
        None => {
            out_headers.remove("x-nbo-edge-backend");
        }
    }
    if known_id.is_none()
        && navigation
        && let Ok(v) = HeaderValue::from_str(&visitor_cookie(&visitor_id, scheme == "https"))
    {
        out_headers.append(SET_COOKIE, v);
    }

    let mut body = body.map_err(|e| -> BoxError { Box::new(e) }).boxed_unsync();
    if let Some(settings) = insights.filter(|s| s.inject)
        && tag_page
    {
        body = with_tag(
            body,
            parts.status,
            &parts.headers,
            &mut out_headers,
            backend.id.as_deref().unwrap_or(""),
            settings.sample_rate,
        );
    }
    let mut res = Response::new(body);
    *res.status_mut() = parts.status;
    *res.headers_mut() = out_headers;
    res
}

// Picks the client and URL for the backend (or its relay) and sends.
async fn forward<B>(
    clients: &Clients,
    backend: &Backend,
    incoming_url: &Url,
    method: Method,
    mut headers: HeaderMap,
    body: B,
    has_body: bool,
) -> Result<Response<hyper::body::Incoming>, String>
where
    B: Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    let backend_url = Url::parse(&backend.url).map_err(|e| format!("bad backend url: {e}"))?;
    let mut target = backend_url.clone();
    if let Some(via) = &backend.via {
        set_header(&mut headers, RELAY_TOKEN_HEADER, &via.token);
        set_header(&mut headers, RELAY_UPSTREAM_HEADER, &url_host(&backend_url));
        target = Url::parse(&via.url).map_err(|e| format!("bad relay url: {e}"))?;
    }
    let client = clients.for_backend(backend)?;
    let body = if has_body {
        body.map_err(Into::into).boxed_unsync()
    } else {
        empty_body()
    };
    send(
        clients,
        &client,
        method,
        &outgoing_url(&target, incoming_url),
        headers,
        body,
    )
    .await
}

// ---------- revalidation fan-out

/// The spec's on-demand revalidation endpoint. A `POST` to it goes to
/// every backend of the host (weights ignored, 0% ones too), so one call
/// reaches every cloud's cache; anything else there is proxied as usual.
pub const REVALIDATE_PATH: &str = "/_nbo/revalidate";
/// The largest revalidation body the edge buffers.
pub const FANOUT_MAX_BODY_BYTES: usize = 65_536;
/// Each backend's limit to answer a revalidation, capped by the header
/// timeout (`NBO_EDGE_HEADER_TIMEOUT_MS`, which tests lower).
pub const FANOUT_LIMIT: Duration = Duration::from_secs(10);
/// Names the number of backends a revalidation went to.
pub const FANOUT_HEADER: &str = "x-nbo-edge-fanout";

/// `POST` to exactly `/_nbo/revalidate`.
pub fn is_revalidate_request(method: &Method, path: &str) -> bool {
    method == Method::POST && path == REVALIDATE_PATH
}

// Every fan-out answer names the backend count and is never cached.
fn fanout_headers(mut res: Response<EdgeBody>, count: usize) -> Response<EdgeBody> {
    let headers = res.headers_mut();
    headers.insert(
        HeaderName::from_static(FANOUT_HEADER),
        HeaderValue::from(count),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// The edge's answer once every backend has answered: `204` when all
/// answered 2xx; the shared status when all answered the same non-2xx;
/// else `502` listing each backend's id and status (`0`: unreachable or
/// timed out).
/// A backend without an id (an older route table) is listed with a null id,
/// never by its URL.
pub fn fanout_answer(results: &[(Option<String>, u16)]) -> Response<EdgeBody> {
    let count = results.len();
    let first = results.first().map_or(0, |r| r.1);
    let shared = StatusCode::from_u16(first)
        .ok()
        .filter(|_| first != 0 && results.iter().all(|r| r.1 == first));
    let res = if results.iter().all(|r| (200..=299).contains(&r.1)) {
        empty(StatusCode::NO_CONTENT)
    } else if let Some(status) = shared {
        empty(status)
    } else {
        let backends: Vec<serde_json::Value> = results
            .iter()
            .map(|(id, status)| serde_json::json!({ "id": id, "status": status }))
            .collect();
        json(
            StatusCode::BAD_GATEWAY,
            &serde_json::json!({ "backends": backends }),
        )
    };
    fanout_headers(res, count)
}

fn too_large() -> Response<EdgeBody> {
    text(
        StatusCode::PAYLOAD_TOO_LARGE,
        format!("edge: revalidation body over {FANOUT_MAX_BODY_BYTES} bytes"),
    )
}

/// Buffers the body once (`413` over 64 KiB, before any backend is
/// called) and sends the same method, path, headers and body to every
/// backend in parallel, each the way a visitor's request reaches it (relay,
/// TLS) and bounded by `FANOUT_LIMIT` capped by the header timeout.
pub async fn fan_out_revalidate<B>(
    clients: &Arc<Clients>,
    host: &str,
    backends: &[Backend],
    incoming_url: &Url,
    mut headers: HeaderMap,
    body: B,
) -> Response<EdgeBody>
where
    B: Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    let count = backends.len();
    // The registry refuses a target with no backends; should one ever get
    // through, it is answered as an unknown host, never as a 204 for "all of none".
    if backends.is_empty() {
        let res = text(
            StatusCode::NOT_FOUND,
            format!("edge: no target registered for host {host}"),
        );
        return fanout_headers(res, count);
    }
    let declared =
        header_joined(&headers, "content-length", ", ").and_then(|v| v.trim().parse::<u64>().ok());
    if declared.is_some_and(|n| n > FANOUT_MAX_BODY_BYTES as u64) {
        return fanout_headers(too_large(), count);
    }
    let bytes = match Limited::new(body, FANOUT_MAX_BODY_BYTES).collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(e) if e.downcast_ref::<LengthLimitError>().is_some() => {
            return fanout_headers(too_large(), count);
        }
        Err(_) => {
            let res = text(
                StatusCode::BAD_REQUEST,
                "edge: the request body could not be read",
            );
            return fanout_headers(res, count);
        }
    };
    headers.insert(CONTENT_LENGTH, HeaderValue::from(bytes.len()));

    let limit = FANOUT_LIMIT.min(clients.header_timeout());
    let mut tasks = tokio::task::JoinSet::new();
    for (index, backend) in backends.iter().enumerate() {
        let clients = Arc::clone(clients);
        let backend = backend.clone();
        let url = incoming_url.clone();
        let headers = headers.clone();
        let body = Full::new(bytes.clone());
        tasks.spawn(async move {
            let call = forward(&clients, &backend, &url, Method::POST, headers, body, true);
            let status = match tokio::time::timeout(limit, call).await {
                Ok(Ok(res)) => res.status().as_u16(),
                _ => 0,
            };
            (index, status)
        });
    }
    let mut statuses = vec![0u16; count];
    while let Some(joined) = tasks.join_next().await {
        if let Ok((index, status)) = joined {
            statuses[index] = status;
        }
    }
    let results: Vec<(Option<String>, u16)> = backends
        .iter()
        .zip(statuses)
        .map(|(b, status)| (b.id.clone(), status))
        .collect();
    fanout_answer(&results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_revalidate_request_is_post_to_exactly_the_path() {
        assert!(is_revalidate_request(&Method::POST, "/_nbo/revalidate"));
        assert!(!is_revalidate_request(&Method::GET, "/_nbo/revalidate"));
        assert!(!is_revalidate_request(&Method::PUT, "/_nbo/revalidate"));
        assert!(!is_revalidate_request(&Method::POST, "/_nbo/revalidate/"));
        assert!(!is_revalidate_request(&Method::POST, "/_nbo/revalidatex"));
        assert!(!is_revalidate_request(&Method::POST, "/x/_nbo/revalidate"));
    }

    fn header_of(res: &Response<EdgeBody>, name: &str) -> Option<String> {
        res.headers()
            .get(name)
            .map(|v| v.to_str().unwrap().to_string())
    }

    async fn body_text(res: Response<EdgeBody>) -> String {
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn results(pairs: &[(&str, u16)]) -> Vec<(Option<String>, u16)> {
        pairs
            .iter()
            .map(|(i, s)| ((!i.is_empty()).then(|| i.to_string()), *s))
            .collect()
    }

    #[tokio::test]
    async fn fanout_answer_follows_the_status_rules() {
        let all_ok = fanout_answer(&results(&[("a", 204), ("b", 200)]));
        assert_eq!(all_ok.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            header_of(&all_ok, "x-nbo-edge-fanout").as_deref(),
            Some("2")
        );
        assert_eq!(
            header_of(&all_ok, "cache-control").as_deref(),
            Some("no-store")
        );

        let shared = fanout_answer(&results(&[("a", 401), ("b", 401)]));
        assert_eq!(shared.status(), StatusCode::UNAUTHORIZED);

        // "" stands for a backend without an id: listed as null, never its URL.
        let mixed = fanout_answer(&results(&[("env_a", 204), ("", 401)]));
        assert_eq!(mixed.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(header_of(&mixed, "x-nbo-edge-fanout").as_deref(), Some("2"));
        assert_eq!(
            body_text(mixed).await,
            r#"{"backends":[{"id":"env_a","status":204},{"id":null,"status":401}]}"#
        );

        // Nobody answered: no shared status, the list.
        let down = fanout_answer(&results(&[("a", 0), ("b", 0)]));
        assert_eq!(down.status(), StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn fan_out_answers_413_over_64_kib_without_calling_a_backend() {
        let clients = Arc::new(Clients::new(Duration::from_secs(1)).unwrap());
        // Nothing listens there: a call would give status 0 and a 502.
        let backends = vec![Backend {
            id: Some("env_a".into()),
            url: "http://127.0.0.1:9".into(),
            weight: 1,
            insecure_skip_verify: false,
            via: None,
        }];
        let url = request_url(&"/_nbo/revalidate".parse().unwrap()).unwrap();
        let big = Full::new(Bytes::from(vec![b'x'; FANOUT_MAX_BODY_BYTES + 1]));
        let res =
            fan_out_revalidate(&clients, "fan.test", &backends, &url, HeaderMap::new(), big).await;
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(header_of(&res, "x-nbo-edge-fanout").as_deref(), Some("1"));
    }

    #[tokio::test]
    async fn fan_out_to_no_backends_answers_as_an_unknown_host() {
        let clients = Arc::new(Clients::new(Duration::from_secs(1)).unwrap());
        let url = request_url(&"/_nbo/revalidate".parse().unwrap()).unwrap();
        let res = fan_out_revalidate(
            &clients,
            "empty.test",
            &[],
            &url,
            HeaderMap::new(),
            Full::new(Bytes::from_static(b"{}")),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(header_of(&res, "x-nbo-edge-fanout").as_deref(), Some("0"));
        assert_eq!(
            header_of(&res, "cache-control").as_deref(),
            Some("no-store")
        );
        assert_eq!(
            body_text(res).await,
            "edge: no target registered for host empty.test"
        );
    }

    #[test]
    fn request_host_prefers_authority_over_http2_only() {
        let req = |version, uri: &str, host: Option<&str>| {
            let mut b = Request::builder().version(version).uri(uri);
            if let Some(h) = host {
                b = b.header(HOST, h);
            }
            b.body(()).unwrap()
        };
        assert_eq!(
            request_host(&req(Version::HTTP_2, "https://a.test/x", Some("b.test"))),
            "a.test"
        );
        assert_eq!(
            request_host(&req(Version::HTTP_2, "/x", Some("b.test"))),
            "b.test"
        );
        assert_eq!(
            request_host(&req(Version::HTTP_11, "http://a.test/x", Some("b.test"))),
            "b.test"
        );
        assert_eq!(request_host(&req(Version::HTTP_11, "/x", None)), "");
        assert_eq!(
            request_host(&req(Version::HTTP_11, "http://a.test:81/x", None)),
            "a.test:81"
        );
    }

    #[test]
    fn join_path_adds_or_drops_one_slash() {
        assert_eq!(join_path("/base", "/a/b"), "/base/a/b");
        assert_eq!(join_path("/base/", "/c"), "/base/c");
        assert_eq!(join_path("/base", "c"), "/base/c");
        assert_eq!(join_path("/base/", "c"), "/base/c");
        assert_eq!(join_path("/", "/"), "/");
        assert_eq!(join_path("", "/x"), "/x");
        assert_eq!(join_path("/", "/x?"), "/x?");
    }

    #[test]
    fn merge_query_keeps_both_sides() {
        assert_eq!(merge_query("x=1", "y=2"), "x=1&y=2");
        assert_eq!(merge_query("", "y=2"), "y=2");
        assert_eq!(merge_query("x=1", ""), "x=1");
        assert_eq!(merge_query("", ""), "");
    }

    #[test]
    fn outgoing_url_joins_path_and_query_like_the_node_edge() {
        let target = Url::parse("http://127.0.0.1:3000/base?x=1").unwrap();
        let incoming = request_url(&"/a/b?y=2".parse().unwrap()).unwrap();
        assert_eq!(
            outgoing_url(&target, &incoming).as_str(),
            "http://127.0.0.1:3000/base/a/b?x=1&y=2"
        );
        let target = Url::parse("http://127.0.0.1:3000/base/").unwrap();
        let incoming = request_url(&"/c".parse().unwrap()).unwrap();
        assert_eq!(
            outgoing_url(&target, &incoming).as_str(),
            "http://127.0.0.1:3000/base/c"
        );
        let target = Url::parse("https://a.example").unwrap();
        let incoming = request_url(&"/x/../y?".parse().unwrap()).unwrap();
        assert_eq!(
            outgoing_url(&target, &incoming).as_str(),
            "https://a.example/y"
        );
    }

    #[test]
    fn request_url_reads_the_target_as_a_path_even_when_it_looks_like_a_host() {
        let u = request_url(&"//evil.example/x".parse().unwrap()).unwrap();
        assert_eq!(u.host_str(), Some("localhost"));
        assert_eq!(u.path(), "//evil.example/x");
        assert!(request_url(&"*".parse().unwrap()).is_none());
    }

    #[test]
    fn url_host_keeps_a_non_default_port() {
        assert_eq!(
            url_host(&Url::parse("http://svc.ns.svc.cluster.local:8080/x").unwrap()),
            "svc.ns.svc.cluster.local:8080"
        );
        assert_eq!(
            url_host(&Url::parse("https://a.example:443/").unwrap()),
            "a.example"
        );
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn forward_headers_drops_host_hop_by_hop_and_connection_named() {
        let h = headers(&[
            ("host", "app.test"),
            ("connection", "x-secret, X-Other"),
            ("connection", "close"),
            ("x-secret", "1"),
            ("x-other", "2"),
            ("keep-alive", "timeout=5"),
            ("proxy-connection", "keep-alive"),
            ("te", "trailers"),
            ("trailer", "x-t"),
            ("transfer-encoding", "chunked"),
            ("upgrade", "websocket"),
            ("expect", "100-continue"),
            ("x-kept", "yes"),
            ("accept", "a"),
            ("accept", "b"),
        ]);
        let out = forward_headers(&h);
        for name in [
            "host",
            "connection",
            "x-secret",
            "x-other",
            "keep-alive",
            "proxy-connection",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
            "expect",
        ] {
            assert!(!out.contains_key(name), "{name} kept");
        }
        assert_eq!(out.get("x-kept").unwrap(), "yes");
        let accept: Vec<_> = out.get_all("accept").iter().collect();
        assert_eq!(accept, ["a", "b"]);
    }

    #[test]
    fn response_headers_drops_hop_by_hop_but_keeps_cookies() {
        let h = headers(&[
            ("connection", "keep-alive, x-private"),
            ("keep-alive", "timeout=5"),
            ("transfer-encoding", "chunked"),
            ("x-private", "1"),
            ("set-cookie", "a=1"),
            ("set-cookie", "b=2"),
            ("content-encoding", "gzip"),
        ]);
        let out = response_headers(&h);
        for name in ["connection", "keep-alive", "transfer-encoding", "x-private"] {
            assert!(!out.contains_key(name), "{name} kept");
        }
        assert_eq!(out.get_all("set-cookie").iter().count(), 2);
        assert_eq!(out.get("content-encoding").unwrap(), "gzip");
    }

    #[test]
    fn set_header_replaces_the_visitors_value_even_when_ours_cannot_be_sent() {
        let mut h = headers(&[("x-forwarded-host", "evil.example")]);
        // A latin1 Host (obs-text) goes on byte for byte.
        set_header(&mut h, "x-forwarded-host", "caf\u{e9}.example");
        assert_eq!(
            h.get("x-forwarded-host").unwrap().as_bytes(),
            b"caf\xe9.example"
        );
        // A value that can't be a header value still removes the visitor's.
        let mut h = headers(&[("x-forwarded-host", "evil.example")]);
        set_header(&mut h, "x-forwarded-host", "a\nb");
        assert!(h.get("x-forwarded-host").is_none());
    }

    #[test]
    fn describe_joins_an_error_chain() {
        let inner = std::io::Error::other("connection refused");
        let outer = std::io::Error::other(Wrapped(inner));
        assert_eq!(describe(&outer), "wrapped: connection refused");
    }

    // ---------- Speed Insights through the data plane

    use crate::insights::inject::insights_tag;
    use crate::registry::InsightsSettings;
    use std::io::Write;

    type Page = (Vec<(&'static str, String)>, Vec<u8>);

    // A backend answering every request with the page `page` returns.
    async fn backend(page: Arc<dyn Fn() -> Page + Send + Sync>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let page = Arc::clone(&page);
                tokio::spawn(async move {
                    let svc = hyper::service::service_fn(move |_req| {
                        let (headers, body) = page();
                        async move {
                            let mut res = Response::new(Full::new(Bytes::from(body)));
                            for (k, v) in headers {
                                res.headers_mut()
                                    .append(k, HeaderValue::from_str(&v).unwrap());
                            }
                            Ok::<_, std::convert::Infallible>(res)
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(stream), svc)
                        .await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn brotli(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut w = brotli::CompressorWriter::new(&mut out, 4096, 5, 22);
            w.write_all(data).unwrap();
        }
        out
    }

    struct Edge {
        registry: Registry,
        opts: ProxyOptions,
    }

    async fn edge(page: Page, inject: bool) -> Edge {
        let page = Arc::new(move || page.clone());
        let url = backend(page).await;
        let registry = Registry::new();
        registry
            .set(
                "si.test",
                vec![Backend {
                    id: Some("env_a".into()),
                    url,
                    weight: 1,
                    insecure_skip_verify: false,
                    via: None,
                }],
                Some(InsightsSettings {
                    enabled: true,
                    inject,
                    sample_rate: 50,
                }),
            )
            .unwrap();
        Edge {
            registry,
            opts: ProxyOptions {
                clients: Arc::new(Clients::new(DEFAULT_HEADER_TIMEOUT).unwrap()),
                scheme: None,
                insights: Arc::new(crate::insights::aggregator::Aggregator::default()),
            },
        }
    }

    impl Edge {
        async fn get(
            &self,
            method: &str,
            path: &str,
            headers: &[(&str, &str)],
        ) -> (Response<()>, Vec<u8>) {
            let mut b = Request::builder()
                .method(method)
                .uri(path)
                .header("host", "si.test");
            for (k, v) in headers {
                b = b.header(*k, *v);
            }
            let req = b.body(Full::new(Bytes::new())).unwrap();
            let res = handle(req, &self.registry, &self.opts).await;
            let (parts, body) = res.into_parts();
            let bytes = body.collect().await.unwrap().to_bytes().to_vec();
            (Response::from_parts(parts, ()), bytes)
        }
    }

    const NAV: (&str, &str) = ("sec-fetch-dest", "document");
    const PAGE: &[u8] = b"<html><head><title>z</title></head><body>compressed</body></html>";

    fn html(encoding: &str, body: Vec<u8>) -> Page {
        (
            vec![
                ("content-type", "text/html; charset=utf-8".into()),
                ("content-encoding", encoding.into()),
                ("content-length", body.len().to_string()),
                ("etag", "\"abc\"".into()),
                ("x-nbo-deployment-id", "dep-1".into()),
            ],
            body,
        )
    }

    #[tokio::test]
    async fn review_focus_2_inject_on_a_gzip_or_brotli_page_gets_the_tag_uncompressed() {
        let tagged = format!(
            "<html><head><title>z</title>{}</head><body>compressed</body></html>",
            insights_tag("env_a", "dep-1", 50)
        );
        for (enc, data) in [("gzip", gzip(PAGE)), ("br", brotli(PAGE))] {
            let e = edge(html(enc, data), true).await;
            let (res, body) = e
                .get("GET", "/", &[NAV, ("accept-encoding", "gzip, br")])
                .await;
            assert_eq!(res.status(), 200);
            assert!(res.headers().get("content-encoding").is_none(), "{enc}");
            assert!(res.headers().get("content-length").is_none(), "{enc}");
            assert_eq!(res.headers()["etag"], "W/\"abc\"", "{enc}");
            assert_eq!(String::from_utf8(body).unwrap(), tagged, "{enc}");
        }
    }

    #[tokio::test]
    async fn review_focus_2_inject_off_a_compressed_page_passes_through_byte_identical() {
        for (enc, data) in [("gzip", gzip(PAGE)), ("br", brotli(PAGE))] {
            let e = edge(html(enc, data.clone()), false).await;
            let (res, body) = e.get("GET", "/", &[NAV]).await;
            assert_eq!(res.headers()["content-encoding"], enc);
            assert_eq!(
                res.headers()["content-length"],
                data.len().to_string().as_str()
            );
            assert_eq!(res.headers()["etag"], "\"abc\"");
            assert_eq!(body, data, "{enc}");
        }
    }

    #[tokio::test]
    async fn review_focus_2_a_compressed_asset_or_unknown_coding_passes_through_with_inject_on() {
        let data = gzip(PAGE);
        let mut page = html("gzip", data.clone());
        page.0[0].1 = "text/javascript".into();
        let e = edge(page, true).await;
        let (res, body) = e.get("GET", "/app.js", &[]).await;
        assert_eq!(res.headers()["content-encoding"], "gzip");
        assert_eq!(body, data);
        // A page, but not a navigation (a script's fetch of HTML).
        let e = edge(html("gzip", data.clone()), true).await;
        let (res, body) = e.get("GET", "/", &[("sec-fetch-dest", "empty")]).await;
        assert_eq!(res.headers()["content-encoding"], "gzip");
        assert_eq!(body, data);
        // zstd: no decoder here, so the page passes through untagged.
        let e = edge(html("zstd", b"opaque zstd bytes".to_vec()), true).await;
        let (res, body) = e.get("GET", "/", &[NAV]).await;
        assert_eq!(res.headers()["content-encoding"], "zstd");
        assert_eq!(res.headers()["etag"], "\"abc\"");
        assert_eq!(body, b"opaque zstd bytes");
    }

    #[tokio::test]
    async fn an_uncompressed_page_gets_the_tag_and_a_head_request_does_not() {
        let e = edge(html("identity", PAGE.to_vec()), true).await;
        let (res, body) = e.get("GET", "/", &[NAV]).await;
        assert!(
            String::from_utf8(body)
                .unwrap()
                .contains("data-d=\"dep-1\"")
        );
        assert!(res.headers().get("content-length").is_none());
        assert_eq!(res.headers()["content-encoding"], "identity");
        let (res, _) = e.get("HEAD", "/", &[NAV]).await;
        assert_eq!(res.headers()["etag"], "\"abc\"");
    }

    #[tokio::test]
    async fn names_the_backend_by_its_id_never_its_url() {
        let e = edge(html("identity", PAGE.to_vec()), false).await;
        let (res, _) = e.get("GET", "/", &[]).await;
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["x-nbo-edge-backend"], "env_a");

        // A backend without an id (an older route table) gets no header.
        let target = e.registry.get("si.test").unwrap();
        let mut old = target.backends[0].clone();
        old.id = None;
        e.registry.set("si.test", vec![old], None).unwrap();
        let (res, _) = e.get("GET", "/", &[]).await;
        assert_eq!(res.status(), 200);
        assert!(res.headers().get("x-nbo-edge-backend").is_none());
    }

    #[tokio::test]
    async fn an_unreachable_backend_is_a_502_that_names_nothing_internal() {
        let e = edge(html("identity", PAGE.to_vec()), false).await;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        e.registry
            .set(
                "si.test",
                vec![Backend {
                    id: Some("env_down".into()),
                    url: format!("http://127.0.0.1:{port}"),
                    weight: 1,
                    insecure_skip_verify: false,
                    via: None,
                }],
                None,
            )
            .unwrap();
        let (res, body) = e.get("GET", "/", &[]).await;
        assert_eq!(res.status(), 502);
        assert_eq!(body, b"edge: backend unreachable");
        assert!(res.headers().get("x-nbo-edge-backend").is_none());
    }

    #[tokio::test]
    async fn the_edge_answers_the_script_and_beacon_paths_itself() {
        let e = edge(html("identity", PAGE.to_vec()), true).await;
        let (res, body) = e.get("GET", "/_nbo/insights/v1/script.js", &[NAV]).await;
        assert_eq!(res.status(), 200);
        assert_eq!(body, crate::insights::script::build_script(50).as_bytes());
        assert!(res.headers().get("set-cookie").is_none());
        assert!(res.headers().get("x-nbo-edge-backend").is_none());
        let (res, body) = e.get("HEAD", "/_nbo/insights/v1/script.js", &[]).await;
        assert_eq!(res.status(), 200);
        assert!(body.is_empty());
        let (res, body) = e.get("POST", "/_nbo/insights/v1/script.js", &[]).await;
        assert_eq!(
            (res.status().as_u16(), body.as_slice()),
            (404, b"not found".as_slice())
        );
        let (res, _) = e.get("GET", "/_nbo/insights/v1/other", &[]).await;
        assert_eq!(res.status(), 404);
        let (res, _) = e.get("GET", "/_nbo/insights/v1/vitals", &[]).await;
        assert_eq!(res.status(), 405);
    }

    #[derive(Debug)]
    struct Wrapped(std::io::Error);
    impl std::fmt::Display for Wrapped {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("wrapped")
        }
    }
    impl StdError for Wrapped {
        fn source(&self) -> Option<&(dyn StdError + 'static)> {
            Some(&self.0)
        }
    }
}
