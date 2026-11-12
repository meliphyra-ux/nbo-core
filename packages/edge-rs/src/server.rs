// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Listeners: a hyper connection per accepted socket, each request handed
//! to a handler with the visitor's address in its extensions.

use std::future::Future;
use std::io;
use std::net::{Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use http::Method;
use http_body_util::BodyExt;
use hyper::Request;
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::server::conn::{http1, http2};
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use socket2::{Domain, Socket, Type};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpListener;
use tokio::time::{Instant, Sleep};
use tokio_rustls::TlsAcceptor;

use crate::admin::{self, AdminOptions};
use crate::config::DevAddrs;
use crate::proxy::{self, BoxError, ClientAddr, EdgeBody, ProxyOptions};
use crate::registry::Registry;

const BACKLOG: i32 = 511;

/// Binds `port` on every interface, IPv6 and IPv4 alike where the host
/// has IPv6 (as Node does for a listener without a host).
pub fn bind_any(port: u16) -> io::Result<TcpListener> {
    // Falls back to IPv4 only when the host has no usable IPv6; any other
    // failure (the port in use, say) is reported, not hidden.
    let dual = || -> io::Result<Socket> {
        let socket = Socket::new(Domain::IPV6, Type::STREAM, None)?;
        socket.set_only_v6(false)?;
        prepare(&socket)?;
        Ok(socket)
    };
    let ipv6_missing = |e: &io::Error| {
        matches!(
            e.kind(),
            io::ErrorKind::AddrNotAvailable | io::ErrorKind::Unsupported
        )
    };
    let any6 = SocketAddr::from((Ipv6Addr::UNSPECIFIED, port));
    let socket = match dual().and_then(|s| s.bind(&any6.into()).map(|()| s)) {
        Ok(s) => s,
        Err(e) if !ipv6_missing(&e) && !is_family_error(&e) => return Err(e),
        Err(_) => {
            let socket = Socket::new(Domain::IPV4, Type::STREAM, None)?;
            prepare(&socket)?;
            socket.bind(&SocketAddr::from(([0, 0, 0, 0], port)).into())?;
            socket
        }
    };
    listen(socket)
}

// The socket couldn't be an IPv6 one at all (EAFNOSUPPORT, WSAEAFNOSUPPORT).
fn is_family_error(e: &io::Error) -> bool {
    matches!(e.raw_os_error(), Some(97) | Some(47) | Some(10047))
}

/// Binds `host:port` (the admin API).
pub async fn bind_host(host: &str, port: u16) -> io::Result<TcpListener> {
    let addr = tokio::net::lookup_host((host, port))
        .await?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("no address for {host}")))?;
    let socket = Socket::new(Domain::for_address(addr), Type::STREAM, None)?;
    prepare(&socket)?;
    socket.bind(&addr.into())?;
    listen(socket)
}

fn prepare(socket: &Socket) -> io::Result<()> {
    // As Node does on Unix; on Windows SO_REUSEADDR would let another
    // process take the port.
    #[cfg(unix)]
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    Ok(())
}

fn listen(socket: Socket) -> io::Result<TcpListener> {
    socket.listen(BACKLOG)?;
    TcpListener::from_std(socket.into())
}

/// How long a request body may take to arrive, from the request's start:
/// Node's `server.requestTimeout` (300 s).
pub const REQUEST_BODY_LIMIT: Duration = Duration::from_secs(300);

/// A visitor's request body, failing once `REQUEST_BODY_LIMIT` has passed
/// since the request started and the body is still not complete, so a
/// body trickled forever can't hold a connection (and a backend's) open.
/// The timer is only made when the body first has to wait.
pub struct VisitorBody<B = Incoming> {
    inner: B,
    deadline: Instant,
    timer: Option<Pin<Box<Sleep>>>,
}

impl<B> VisitorBody<B> {
    pub fn new(inner: B, limit: Duration) -> VisitorBody<B> {
        VisitorBody {
            inner,
            deadline: Instant::now() + limit,
            timer: None,
        }
    }
}

impl<B> Body for VisitorBody<B>
where
    B: Body<Data = Bytes> + Unpin,
    B::Error: Into<BoxError>,
{
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        if let Poll::Ready(frame) = Pin::new(&mut self.inner).poll_frame(cx) {
            return Poll::Ready(frame.map(|f| f.map_err(Into::into)));
        }
        let deadline = self.deadline;
        let timer = self
            .timer
            .get_or_insert_with(|| Box::pin(tokio::time::sleep_until(deadline)));
        match timer.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(Some(Err(format!(
                "the request body did not arrive within {} s",
                REQUEST_BODY_LIMIT.as_secs()
            )
            .into()))),
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// A request the edge doesn't answer: the connection is closed instead,
/// as Node's HTTP server does for CONNECT with no `connect` listener.
#[derive(Debug)]
struct Refused;

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CONNECT is not supported")
    }
}

impl std::error::Error for Refused {}

/// Which protocol a connection speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Http1,
    Http2,
}

/// How long connections may sit idle. Node's server closes a keep-alive
/// connection 5 s after its last response (`keepAliveTimeout`) and gives a
/// request 60 s to send its headers (`headersTimeout`); the edge does the
/// same, for HTTP/2 as well as HTTP/1.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnLimits {
    /// Closes a connection with no request in flight and nothing read for
    /// this long after its last response.
    pub idle: Duration,
    /// The same for a connection that hasn't had a request yet, and the
    /// HTTP/1.1 header read timeout.
    pub headers: Duration,
}

pub const DEFAULT_IDLE: Duration = Duration::from_secs(5);
pub const DEFAULT_HEADERS: Duration = Duration::from_secs(60);
/// HTTP/2 pings a connection with streams in flight this often, and drops
/// it when the ping isn't answered in as long: a dead peer can't hold a
/// slow download open forever.
pub const H2_KEEP_ALIVE: Duration = Duration::from_secs(20);

impl Default for ConnLimits {
    fn default() -> ConnLimits {
        ConnLimits {
            idle: DEFAULT_IDLE,
            headers: DEFAULT_HEADERS,
        }
    }
}

static LIMITS: OnceLock<ConnLimits> = OnceLock::new();

/// Sets the limits every listener uses; the first call wins. Unset, the
/// defaults apply.
pub fn set_conn_limits(limits: ConnLimits) {
    let _ = LIMITS.set(limits);
}

pub fn conn_limits() -> ConnLimits {
    LIMITS.get().copied().unwrap_or_default()
}

/// What a connection has been doing, for its idle timer.
struct Activity {
    start: Instant,
    /// Milliseconds after `start` of the last byte read or response ended.
    last: AtomicU64,
    in_flight: AtomicUsize,
    served: AtomicBool,
}

impl Activity {
    fn new() -> Activity {
        Activity {
            start: Instant::now(),
            last: AtomicU64::new(0),
            in_flight: AtomicUsize::new(0),
            served: AtomicBool::new(false),
        }
    }

    fn touch(&self) {
        let ms = self.start.elapsed().as_millis() as u64;
        self.last.fetch_max(ms, Ordering::Relaxed);
    }

    /// When the connection counts as idle, unless something happens first.
    fn deadline(&self, limits: ConnLimits) -> Instant {
        let limit = if self.served.load(Ordering::Relaxed) {
            limits.idle
        } else {
            limits.headers
        };
        self.start + Duration::from_millis(self.last.load(Ordering::Relaxed)) + limit
    }

    fn idle(&self, limits: ConnLimits) -> bool {
        self.in_flight.load(Ordering::Relaxed) == 0 && Instant::now() >= self.deadline(limits)
    }
}

/// One request in flight: counted from the moment the handler starts
/// until the response body is finished or dropped.
struct InFlight(Arc<Activity>);

impl InFlight {
    fn start(activity: &Arc<Activity>) -> InFlight {
        activity.in_flight.fetch_add(1, Ordering::Relaxed);
        activity.touch();
        InFlight(Arc::clone(activity))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.served.store(true, Ordering::Relaxed);
        self.0.touch();
        self.0.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

/// A response body holding its request's `InFlight` until it ends.
struct Tracked {
    inner: EdgeBody,
    _in_flight: InFlight,
}

impl Body for Tracked {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        Pin::new(&mut self.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// The connection's socket, noting every read as activity.
struct Watched<I> {
    io: I,
    activity: Arc<Activity>,
}

impl<I: AsyncRead + Unpin> AsyncRead for Watched<I> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.io).poll_read(cx, buf);
        if buf.filled().len() > before {
            self.activity.touch();
        }
        polled
    }
}

impl<I: AsyncWrite + Unpin> AsyncWrite for Watched<I> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.io).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }
}

// Runs a hyper connection to its end, shutting it down gracefully once it
// is idle. (A macro: the HTTP/1.1 and HTTP/2 connections are different
// types with the same `graceful_shutdown`.)
macro_rules! drive {
    ($conn:expr, $activity:expr, $limits:expr) => {{
        let conn = $conn;
        let activity: &Activity = $activity;
        let limits: ConnLimits = $limits;
        tokio::pin!(conn);
        loop {
            // The deadline moves as requests come and go, so look again at
            // least once per idle period.
            let wake = activity
                .deadline(limits)
                .min(tokio::time::Instant::now() + limits.idle);
            tokio::select! {
                _ = conn.as_mut() => break,
                () = tokio::time::sleep_until(wake) => {
                    if activity.idle(limits) {
                        conn.as_mut().graceful_shutdown();
                        // Idle means no stream to finish; the bound is a
                        // backstop for a peer that never reads the GOAWAY.
                        let _ = tokio::time::timeout(limits.headers, conn.as_mut()).await;
                        break;
                    }
                }
            }
        }
    }};
}

/// Serves one connection until it closes, with the process's limits.
pub async fn serve_connection<I, H, F>(io: I, peer: SocketAddr, protocol: Protocol, handler: H)
where
    I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    H: Fn(Request<VisitorBody>) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = hyper::Response<EdgeBody>> + Send + 'static,
{
    serve_connection_with(io, peer, protocol, conn_limits(), handler).await;
}

/// Serves one connection until it closes or sits idle past `limits`. Each
/// request gets the visitor's address in its extensions. CONNECT is never
/// answered: over HTTP/1.1 the connection is closed, over HTTP/2 the
/// stream is reset, as no proxy tunnel exists.
pub async fn serve_connection_with<I, H, F>(
    io: I,
    peer: SocketAddr,
    protocol: Protocol,
    limits: ConnLimits,
    handler: H,
) where
    I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    H: Fn(Request<VisitorBody>) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = hyper::Response<EdgeBody>> + Send + 'static,
{
    let activity = Arc::new(Activity::new());
    let io = TokioIo::new(Watched {
        io,
        activity: Arc::clone(&activity),
    });
    let counted = Arc::clone(&activity);
    let service = service_fn(move |req: Request<Incoming>| {
        let refused = req.method() == Method::CONNECT;
        let mut req = req.map(|b| VisitorBody::new(b, REQUEST_BODY_LIMIT));
        req.extensions_mut().insert(ClientAddr(peer));
        let in_flight = InFlight::start(&counted);
        let fut = (!refused).then(|| handler(req));
        async move {
            match fut {
                Some(fut) => Ok(fut.await.map(|body| {
                    Tracked {
                        inner: body,
                        _in_flight: in_flight,
                    }
                    .boxed_unsync()
                })),
                None => Err(Refused),
            }
        }
    });
    // A visitor going away mid-request is normal, not an error.
    match protocol {
        Protocol::Http1 => {
            // Node allows 2000 headers and a 16 KB head (maxHeaderSize); a larger
            // head gets 431.
            let conn = http1::Builder::new()
                .max_headers(2000)
                .max_buf_size(16 * 1024)
                .timer(TokioTimer::new())
                .header_read_timeout(limits.headers)
                .serve_connection(io, service);
            drive!(conn, &activity, limits);
        }
        Protocol::Http2 => {
            let conn = http2::Builder::new(TokioExecutor::new())
                .timer(TokioTimer::new())
                .keep_alive_interval(Some(H2_KEEP_ALIVE))
                .keep_alive_timeout(H2_KEEP_ALIVE)
                .serve_connection(io, service);
            drive!(conn, &activity, limits);
        }
    }
}

// Accepts the next connection; on failure (out of file descriptors and
// the like) waits a moment instead of spinning.
async fn accept(listener: &TcpListener) -> (tokio::net::TcpStream, SocketAddr) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let _ = stream.set_nodelay(true);
                return (stream, peer);
            }
            Err(err) => {
                eprintln!("edge: accept failed: {err}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

/// Serves HTTP/1.1 on `listener` forever, one task per connection.
pub async fn serve_http1<H, F>(listener: TcpListener, handler: H)
where
    H: Fn(Request<VisitorBody>) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = hyper::Response<EdgeBody>> + Send + 'static,
{
    loop {
        let (stream, peer) = accept(&listener).await;
        let handler = handler.clone();
        tokio::spawn(serve_connection(stream, peer, Protocol::Http1, handler));
    }
}

/// How long a visitor gets to finish the TLS handshake (Node's
/// `handshakeTimeout`).
pub const HANDSHAKE_LIMIT: Duration = Duration::from_secs(120);

/// Serves HTTPS on `listener` forever, one task per connection: HTTP/2
/// when ALPN picked `h2`, else HTTP/1.1.
pub async fn serve_tls<H, F>(listener: TcpListener, acceptor: TlsAcceptor, handler: H)
where
    H: Fn(Request<VisitorBody>) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = hyper::Response<EdgeBody>> + Send + 'static,
{
    loop {
        let (stream, peer) = accept(&listener).await;
        let handler = handler.clone();
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            // A failed handshake (no certificate for the name, a scanner)
            // just ends the connection.
            let Ok(Ok(tls)) = tokio::time::timeout(HANDSHAKE_LIMIT, acceptor.accept(stream)).await
            else {
                return;
            };
            let protocol = if tls.get_ref().1.alpn_protocol() == Some(b"h2") {
                Protocol::Http2
            } else {
                Protocol::Http1
            };
            serve_connection(tls, peer, protocol, handler).await;
        });
    }
}

/// The ALPN protocols to offer: `h2` first when HTTP/2 is on, and always
/// `http/1.1`.
pub fn alpn(http2: bool) -> Vec<Vec<u8>> {
    let mut protocols = Vec::new();
    if http2 {
        protocols.push(b"h2".to_vec());
    }
    protocols.push(b"http/1.1".to_vec());
    protocols
}

/// Dev mode: the data plane and the admin API, sharing one registry.
pub async fn run_dev(addrs: DevAddrs, options: ProxyOptions) -> io::Result<()> {
    let registry = Arc::new(Registry::new());
    let admin_options = Arc::new(AdminOptions {
        insights: Some(Arc::clone(&options.insights)),
        ..AdminOptions::default()
    });
    let options = Arc::new(options);
    let data = bind_any(addrs.data_port)?;
    let admin = bind_host(&addrs.admin_host, addrs.admin_port).await?;
    println!(
        "edge: data-plane listening on :{}",
        data.local_addr()?.port()
    );
    println!(
        "edge: admin API listening on {}:{}",
        addrs.admin_host,
        admin.local_addr()?.port()
    );

    let data_registry = Arc::clone(&registry);
    let data_task = tokio::spawn(serve_http1(data, move |req| {
        let registry = Arc::clone(&data_registry);
        let options = Arc::clone(&options);
        async move { proxy::handle(req, &registry, &options).await }
    }));
    let admin_task = tokio::spawn(serve_http1(admin, move |req| {
        let registry = Arc::clone(&registry);
        let options = Arc::clone(&admin_options);
        async move { admin::handle(req, &registry, &options).await }
    }));
    // The listeners run forever; one ending (a panic) ends the process
    // with an error.
    let ended = tokio::select! {
        r = data_task => ("data-plane", r),
        r = admin_task => ("admin API", r),
    };
    Err(io::Error::other(match ended {
        (name, Err(e)) => format!("{name} listener failed: {e}"),
        (name, Ok(())) => format!("{name} listener stopped"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    // A body that never sends anything.
    struct Stalled;

    impl Body for Stalled {
        type Data = Bytes;
        type Error = BoxError;

        fn poll_frame(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
            Poll::Pending
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_body_fails_at_the_limit() {
        let started = Instant::now();
        let err = VisitorBody::new(Stalled, REQUEST_BODY_LIMIT)
            .collect()
            .await
            .err()
            .unwrap();
        assert_eq!(
            err.to_string(),
            "the request body did not arrive within 300 s"
        );
        assert_eq!(started.elapsed(), REQUEST_BODY_LIMIT);
    }

    #[tokio::test(start_paused = true)]
    async fn a_complete_body_passes_through() {
        let body = http_body_util::Full::new(Bytes::from_static(b"hello"));
        let got = VisitorBody::new(body, REQUEST_BODY_LIMIT)
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(got, Bytes::from_static(b"hello"));
    }

    // ---------- connection limits

    use std::sync::atomic::AtomicUsize as Counter;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    const TEST_LIMITS: ConnLimits = ConnLimits {
        idle: Duration::from_millis(200),
        headers: Duration::from_millis(600),
    };

    fn peer() -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], 40000))
    }

    // Serves one in-memory connection with a handler that counts calls and
    // answers "ok"; returns the client's end and the call counter.
    fn serve(protocol: Protocol) -> (DuplexStream, Arc<Counter>) {
        let (client, server) = tokio::io::duplex(1 << 16);
        let calls = Arc::new(Counter::new(0));
        let seen = Arc::clone(&calls);
        tokio::spawn(serve_connection_with(
            server,
            peer(),
            protocol,
            TEST_LIMITS,
            move |_req| {
                seen.fetch_add(1, Ordering::Relaxed);
                async { proxy::text(http::StatusCode::OK, "ok") }
            },
        ));
        (client, calls)
    }

    // Reads until EOF (the server closed) or `within` passes; returns what
    // was read and whether EOF came.
    async fn read_until_closed(c: &mut DuplexStream, within: Duration) -> (Vec<u8>, bool) {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        let end = Instant::now() + within;
        loop {
            match tokio::time::timeout_at(end, c.read(&mut buf)).await {
                Ok(Ok(0)) | Ok(Err(_)) => return (out, true),
                Ok(Ok(n)) => out.extend_from_slice(&buf[..n]),
                Err(_) => return (out, false),
            }
        }
    }

    #[tokio::test]
    async fn an_idle_http1_keep_alive_connection_is_closed() {
        let (mut c, calls) = serve(Protocol::Http1);
        c.write_all(b"GET / HTTP/1.1\r\nhost: a.test\r\n\r\n")
            .await
            .unwrap();
        let started = Instant::now();
        let (out, closed) = read_until_closed(&mut c, Duration::from_secs(5)).await;
        assert!(String::from_utf8_lossy(&out).starts_with("HTTP/1.1 200 OK"));
        assert!(closed, "the idle keep-alive connection stayed open");
        // Closed by the idle limit, not later by the header timer.
        let took = started.elapsed();
        assert!(
            took >= TEST_LIMITS.idle && took < TEST_LIMITS.headers,
            "{took:?}"
        );
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn a_connection_without_a_request_gets_the_header_limit() {
        let (mut c, _) = serve(Protocol::Http1);
        let started = Instant::now();
        let (_, closed) = read_until_closed(&mut c, Duration::from_secs(5)).await;
        assert!(closed);
        assert!(
            started.elapsed() >= TEST_LIMITS.headers,
            "{:?}",
            started.elapsed()
        );
    }

    // ---------- raw HTTP/2 frames (a client library refuses to send
    // malformed requests, so the test writes the frames itself)

    const PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
    const HEADERS: u8 = 1;
    const RST_STREAM: u8 = 3;
    const SETTINGS: u8 = 4;
    const GOAWAY: u8 = 7;

    fn frame(kind: u8, flags: u8, stream: u32, payload: &[u8]) -> Vec<u8> {
        let len = payload.len() as u32;
        let mut f = vec![(len >> 16) as u8, (len >> 8) as u8, len as u8, kind, flags];
        f.extend_from_slice(&stream.to_be_bytes());
        f.extend_from_slice(payload);
        f
    }

    // HPACK: a literal header field without indexing, new name, no Huffman.
    fn literal(name: &str, value: &str) -> Vec<u8> {
        let mut out = vec![0x00, name.len() as u8];
        out.extend_from_slice(name.as_bytes());
        out.push(value.len() as u8);
        out.extend_from_slice(value.as_bytes());
        out
    }

    // GET https://a.test/ with the given extra headers, as one HEADERS frame.
    fn get(stream: u32, extra: &[(&str, &str)]) -> Vec<u8> {
        // :method GET, :scheme https, :path / from the static table, then
        // :authority with an indexed name (static index 1).
        let mut block = vec![0x82, 0x87, 0x84, 0x01, 6];
        block.extend_from_slice(b"a.test");
        for (n, v) in extra {
            block.extend(literal(n, v));
        }
        // END_STREAM | END_HEADERS
        frame(HEADERS, 0x5, stream, &block)
    }

    // The frames in `bytes`, as (type, stream).
    fn frames(bytes: &[u8]) -> Vec<(u8, u32)> {
        let mut out = Vec::new();
        let mut i = 0;
        while i + 9 <= bytes.len() {
            let len = (usize::from(bytes[i]) << 16)
                | (usize::from(bytes[i + 1]) << 8)
                | usize::from(bytes[i + 2]);
            let stream =
                u32::from_be_bytes([bytes[i + 5], bytes[i + 6], bytes[i + 7], bytes[i + 8]])
                    & 0x7fff_ffff;
            out.push((bytes[i + 3], stream));
            i += 9 + len;
        }
        out
    }

    async fn h2_session(requests: &[Vec<u8>]) -> (Vec<(u8, u32)>, bool, usize) {
        let (mut c, calls) = serve(Protocol::Http2);
        c.write_all(PREFACE).await.unwrap();
        c.write_all(&frame(SETTINGS, 0, 0, &[])).await.unwrap();
        for r in requests {
            c.write_all(r).await.unwrap();
        }
        let (out, closed) = read_until_closed(&mut c, Duration::from_secs(5)).await;
        (frames(&out), closed, calls.load(Ordering::Relaxed))
    }

    #[tokio::test]
    async fn an_idle_http2_connection_gets_goaway_and_is_closed() {
        let (frames, closed, calls) = h2_session(&[get(1, &[])]).await;
        assert_eq!(calls, 1);
        assert!(frames.contains(&(HEADERS, 1)), "{frames:?}");
        assert!(frames.iter().any(|f| f.0 == GOAWAY), "{frames:?}");
        assert!(closed, "the idle HTTP/2 connection stayed open");
    }

    #[tokio::test]
    async fn http2_connection_specific_headers_are_refused_before_the_handler() {
        for (name, value) in [
            ("connection", "keep-alive"),
            ("transfer-encoding", "chunked"),
            ("keep-alive", "timeout=5"),
            ("upgrade", "websocket"),
            ("proxy-connection", "keep-alive"),
            ("te", "gzip"),
        ] {
            let (frames, _, calls) = h2_session(&[get(1, &[(name, value)])]).await;
            assert_eq!(calls, 0, "{name} reached the handler");
            assert!(
                !frames.contains(&(HEADERS, 1)),
                "{name} was answered: {frames:?}"
            );
            assert!(
                frames.contains(&(RST_STREAM, 1)) || frames.iter().any(|f| f.0 == GOAWAY),
                "{name}: {frames:?}"
            );
        }
        // te: trailers is the one allowed value.
        let (frames, _, calls) = h2_session(&[get(1, &[("te", "trailers")])]).await;
        assert_eq!(calls, 1);
        assert!(frames.contains(&(HEADERS, 1)), "{frames:?}");
    }
}
