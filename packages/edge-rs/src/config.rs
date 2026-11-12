// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! What the environment asks the edge to be. Port of the env handling in
//! `packages/edge/src/main.ts`, with the same names and defaults; the
//! test-only names (ports, the header timeout) are honoured the same way.

use std::collections::HashMap;
use std::time::Duration;

use crate::kube_source::DEFAULT_POLL;
use crate::proxy::DEFAULT_HEADER_TIMEOUT;
use crate::server::ConnLimits;

/// The process environment, or a test's.
#[derive(Debug, Clone, Default)]
pub struct Env(HashMap<String, String>);

impl Env {
    pub fn from_process() -> Env {
        Env(std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.to_string_lossy().into_owned())))
            .collect())
    }

    pub fn from_pairs(pairs: &[(&str, &str)]) -> Env {
        Env(pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect())
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }

    /// The value, trimmed, when set and not blank.
    fn non_blank(&self, name: &str) -> Option<&str> {
        self.get(name).map(str::trim).filter(|v| !v.is_empty())
    }

    fn required(&self, name: &str) -> Result<String, String> {
        match self.get(name) {
            Some(v) if !v.trim().is_empty() => Ok(v.to_string()),
            _ => Err(format!("edge: {name} is required")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    Dev,
    /// `NBO_EDGE_SOURCE=kubernetes`: the public edge in a cluster.
    Cluster {
        namespace: String,
        drain_token: String,
    },
    /// `NBO_EDGE_MODE=relay`: a private cluster's relay.
    Relay {
        token: String,
    },
}

pub fn resolve_mode(env: &Env) -> Result<Mode, String> {
    if env.get("NBO_EDGE_SOURCE") == Some("kubernetes") {
        let drain_token = env.required("NBO_EDGE_DRAIN_TOKEN")?;
        let namespace = env
            .non_blank("NBO_EDGE_NAMESPACE")
            .unwrap_or("nbo-system")
            .to_string();
        return Ok(Mode::Cluster {
            namespace,
            drain_token,
        });
    }
    if env.get("NBO_EDGE_MODE") == Some("relay") {
        return Ok(Mode::Relay {
            token: env.required("NBO_RELAY_TOKEN")?,
        });
    }
    Ok(Mode::Dev)
}

/// Dev mode's listeners: the data plane on every interface (only the port
/// of `NBO_EDGE_ADDR` is used, as in the Node edge), the admin API on
/// `NBO_EDGE_ADMIN_ADDR`'s host, loopback by default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevAddrs {
    pub data_port: u16,
    pub admin_host: String,
    pub admin_port: u16,
}

fn parse_port(raw: &str, name: &str) -> Result<u16, String> {
    let raw = raw.trim();
    // Number("") is 0 in the Node edge: any free port.
    if raw.is_empty() {
        return Ok(0);
    }
    raw.parse::<u16>()
        .map_err(|_| format!("edge: {name} has an invalid port {raw:?}"))
}

// host:port, :port or port. An IPv6 host may be bracketed.
fn split_host_port(addr: &str, name: &str) -> Result<(Option<String>, u16), String> {
    match addr.rfind(':') {
        None => Ok((None, parse_port(addr, name)?)),
        Some(i) => {
            let host = addr[..i].trim_start_matches('[').trim_end_matches(']');
            let port = parse_port(&addr[i + 1..], name)?;
            Ok(((!host.is_empty()).then(|| host.to_string()), port))
        }
    }
}

pub fn resolve_dev_addrs(env: &Env) -> Result<DevAddrs, String> {
    let data_port = match env.get("NBO_EDGE_ADDR").filter(|v| !v.is_empty()) {
        Some(addr) => split_host_port(addr, "NBO_EDGE_ADDR")?.1,
        None => 9443,
    };
    let (admin_host, admin_port) = match env.get("NBO_EDGE_ADMIN_ADDR").filter(|v| !v.is_empty()) {
        Some(addr) => split_host_port(addr, "NBO_EDGE_ADMIN_ADDR")?,
        None => (None, 9444),
    };
    Ok(DevAddrs {
        data_port,
        admin_host: admin_host.unwrap_or_else(|| "127.0.0.1".to_string()),
        admin_port,
    })
}

/// `NBO_EDGE_HEADER_TIMEOUT_MS` (tests only): a positive whole number of
/// milliseconds, else the 30 s default.
pub fn header_timeout(env: &Env) -> Duration {
    header_timeout_or(env, DEFAULT_HEADER_TIMEOUT)
}

/// `NBO_EDGE_HEADER_TIMEOUT_MS`, else `default`.
pub fn header_timeout_or(env: &Env, default: Duration) -> Duration {
    positive_ms(env, "NBO_EDGE_HEADER_TIMEOUT_MS").unwrap_or(default)
}

// A positive whole number of milliseconds.
fn positive_ms(env: &Env, name: &str) -> Option<Duration> {
    env.non_blank(name)
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0 && n.fract() == 0.0)
        .map(|ms| Duration::from_millis(ms as u64))
}

/// `count` comma-separated ports, as the Node edge's `portList` reads
/// them (`Number(p.trim())`, so a blank entry is port 0). Unset or blank:
/// `None`, the defaults.
fn port_list(env: &Env, name: &str, count: usize) -> Result<Option<Vec<u16>>, String> {
    let Some(raw) = env.non_blank(name) else {
        return Ok(None);
    };
    let bad = || format!("edge: {name} must be {count} comma-separated ports");
    let ports = raw
        .split(',')
        .map(|p| {
            let p = p.trim();
            let n = if p.is_empty() {
                Some(0.0)
            } else {
                p.parse::<f64>().ok()
            };
            n.filter(|n| n.fract() == 0.0 && (0.0..=65535.0).contains(n))
                .map(|n| n as u16)
                .ok_or_else(bad)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if ports.len() != count {
        return Err(bad());
    }
    Ok(Some(ports))
}

const SA_DIR: &str = "/var/run/secrets/kubernetes.io/serviceaccount";

/// Cluster mode's ports and cluster API. Unset, every value is the
/// production default; the test-only names point it at a fake API on
/// free ports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClusterConfig {
    pub api_base: String,
    pub token_file: String,
    pub ca_file: String,
    pub http_port: u16,
    pub https_port: u16,
    pub admin_port: u16,
    pub interval: Duration,
}

pub fn resolve_cluster_config(env: &Env) -> Result<ClusterConfig, String> {
    let ports = port_list(env, "NBO_EDGE_CLUSTER_PORTS", 3)?.unwrap_or(vec![8080, 8443, 9444]);
    Ok(ClusterConfig {
        api_base: env
            .non_blank("NBO_EDGE_KUBE_API")
            .unwrap_or("https://kubernetes.default.svc")
            .to_string(),
        token_file: env
            .non_blank("NBO_EDGE_KUBE_TOKEN_FILE")
            .map_or_else(|| format!("{SA_DIR}/token"), str::to_string),
        ca_file: env
            .non_blank("NBO_EDGE_KUBE_CA_FILE")
            .map_or_else(|| format!("{SA_DIR}/ca.crt"), str::to_string),
        http_port: ports[0],
        https_port: ports[1],
        admin_port: ports[2],
        interval: positive_ms(env, "NBO_EDGE_KUBE_POLL_MS").unwrap_or(DEFAULT_POLL),
    })
}

/// The relay's port: `NBO_EDGE_RELAY_PORT` (tests), else 8443.
pub fn resolve_relay_port(env: &Env) -> Result<u16, String> {
    Ok(port_list(env, "NBO_EDGE_RELAY_PORT", 1)?.map_or(8443, |p| p[0]))
}

/// `NBO_EDGE_RELAY_UPSTREAM_OVERRIDE` (`host:port`, tests only): the relay
/// still checks `x-nbo-upstream` against its pattern, then connects here
/// instead of the Service name, which doesn't resolve outside a cluster.
pub fn resolve_relay_upstream_override(env: &Env) -> Result<Option<String>, String> {
    let Some(v) = env.non_blank("NBO_EDGE_RELAY_UPSTREAM_OVERRIDE") else {
        return Ok(None);
    };
    let ok = v.rsplit_once(':').is_some_and(|(host, port)| {
        !host.is_empty()
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            && (1..=5).contains(&port.len())
            && port.bytes().all(|b| b.is_ascii_digit())
    });
    if !ok {
        return Err("edge: NBO_EDGE_RELAY_UPSTREAM_OVERRIDE must be host:port".to_string());
    }
    Ok(Some(v.to_string()))
}

/// The idle limits for visitor connections: `NBO_EDGE_IDLE_TIMEOUT_MS`
/// (tests only) replaces the 5 s keep-alive idle time.
pub fn conn_limits(env: &Env) -> ConnLimits {
    let mut limits = ConnLimits::default();
    if let Some(idle) = positive_ms(env, "NBO_EDGE_IDLE_TIMEOUT_MS") {
        limits.idle = idle;
    }
    limits
}

/// HTTP/2 on cluster mode's HTTPS listener, offered by ALPN, unless
/// `NBO_EDGE_HTTP2=off`.
pub fn http2_enabled(env: &Env) -> bool {
    !env.non_blank("NBO_EDGE_HTTP2")
        .is_some_and(|v| v.eq_ignore_ascii_case("off"))
}

/// Reads a file the edge can't run without, naming it on failure.
pub fn read_file(path: &str, what: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("edge: {what} {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_defaults_to_dev_and_needs_its_secrets() {
        assert_eq!(resolve_mode(&Env::default()), Ok(Mode::Dev));
        assert_eq!(
            resolve_mode(&Env::from_pairs(&[("NBO_EDGE_SOURCE", "kubernetes")])),
            Err("edge: NBO_EDGE_DRAIN_TOKEN is required".to_string())
        );
        assert_eq!(
            resolve_mode(&Env::from_pairs(&[
                ("NBO_EDGE_SOURCE", "kubernetes"),
                ("NBO_EDGE_DRAIN_TOKEN", "t")
            ])),
            Ok(Mode::Cluster {
                namespace: "nbo-system".into(),
                drain_token: "t".into()
            })
        );
        assert_eq!(
            resolve_mode(&Env::from_pairs(&[
                ("NBO_EDGE_SOURCE", "kubernetes"),
                ("NBO_EDGE_DRAIN_TOKEN", "t"),
                ("NBO_EDGE_NAMESPACE", " nbo-edge ")
            ])),
            Ok(Mode::Cluster {
                namespace: "nbo-edge".into(),
                drain_token: "t".into()
            })
        );
        assert_eq!(
            resolve_mode(&Env::from_pairs(&[
                ("NBO_EDGE_MODE", "relay"),
                ("NBO_RELAY_TOKEN", " ")
            ])),
            Err("edge: NBO_RELAY_TOKEN is required".to_string())
        );
    }

    #[test]
    fn dev_addrs_follow_the_node_edge() {
        assert_eq!(
            resolve_dev_addrs(&Env::default()).unwrap(),
            DevAddrs {
                data_port: 9443,
                admin_host: "127.0.0.1".into(),
                admin_port: 9444
            }
        );
        assert_eq!(
            resolve_dev_addrs(&Env::from_pairs(&[
                ("NBO_EDGE_ADDR", "1.2.3.4:8000"),
                ("NBO_EDGE_ADMIN_ADDR", ":7000")
            ]))
            .unwrap(),
            DevAddrs {
                data_port: 8000,
                admin_host: "127.0.0.1".into(),
                admin_port: 7000
            }
        );
        assert_eq!(
            resolve_dev_addrs(&Env::from_pairs(&[
                ("NBO_EDGE_ADDR", "8001"),
                ("NBO_EDGE_ADMIN_ADDR", "0.0.0.0:7001")
            ]))
            .unwrap(),
            DevAddrs {
                data_port: 8001,
                admin_host: "0.0.0.0".into(),
                admin_port: 7001
            }
        );
        assert!(resolve_dev_addrs(&Env::from_pairs(&[("NBO_EDGE_ADDR", ":http")])).is_err());
    }

    #[test]
    fn cluster_config_defaults_and_test_overrides() {
        let c = resolve_cluster_config(&Env::default()).unwrap();
        assert_eq!(
            c,
            ClusterConfig {
                api_base: "https://kubernetes.default.svc".into(),
                token_file: format!("{SA_DIR}/token"),
                ca_file: format!("{SA_DIR}/ca.crt"),
                http_port: 8080,
                https_port: 8443,
                admin_port: 9444,
                interval: Duration::from_secs(5),
            }
        );
        let c = resolve_cluster_config(&Env::from_pairs(&[
            ("NBO_EDGE_CLUSTER_PORTS", "1, 2,3"),
            ("NBO_EDGE_KUBE_API", "https://127.0.0.1:9"),
            ("NBO_EDGE_KUBE_TOKEN_FILE", "/t"),
            ("NBO_EDGE_KUBE_CA_FILE", "/c"),
            ("NBO_EDGE_KUBE_POLL_MS", "100"),
        ]))
        .unwrap();
        assert_eq!((c.http_port, c.https_port, c.admin_port), (1, 2, 3));
        assert_eq!(c.api_base, "https://127.0.0.1:9");
        assert_eq!((c.token_file.as_str(), c.ca_file.as_str()), ("/t", "/c"));
        assert_eq!(c.interval, Duration::from_millis(100));
        for bad in ["1,2", "1,2,3,4", "1,2,x", "1,2,65536", "1,2,1.5"] {
            assert_eq!(
                resolve_cluster_config(&Env::from_pairs(&[("NBO_EDGE_CLUSTER_PORTS", bad)])),
                Err("edge: NBO_EDGE_CLUSTER_PORTS must be 3 comma-separated ports".to_string()),
                "{bad}"
            );
        }
    }

    #[test]
    fn relay_settings() {
        assert_eq!(resolve_relay_port(&Env::default()), Ok(8443));
        assert_eq!(
            resolve_relay_port(&Env::from_pairs(&[("NBO_EDGE_RELAY_PORT", "9000")])),
            Ok(9000)
        );
        assert!(resolve_relay_port(&Env::from_pairs(&[("NBO_EDGE_RELAY_PORT", "1,2")])).is_err());
        assert_eq!(resolve_relay_upstream_override(&Env::default()), Ok(None));
        assert_eq!(
            resolve_relay_upstream_override(&Env::from_pairs(&[(
                "NBO_EDGE_RELAY_UPSTREAM_OVERRIDE",
                "127.0.0.1:8080"
            )])),
            Ok(Some("127.0.0.1:8080".into()))
        );
        for bad in ["127.0.0.1", "a:b", "a_b:1", ":1", "a:123456", "http://a:1"] {
            assert!(
                resolve_relay_upstream_override(&Env::from_pairs(&[(
                    "NBO_EDGE_RELAY_UPSTREAM_OVERRIDE",
                    bad
                )]))
                .is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn idle_limit_defaults_to_node_keep_alive() {
        assert_eq!(
            conn_limits(&Env::default()),
            ConnLimits {
                idle: Duration::from_secs(5),
                headers: Duration::from_secs(60)
            }
        );
        let l = conn_limits(&Env::from_pairs(&[("NBO_EDGE_IDLE_TIMEOUT_MS", "250")]));
        assert_eq!(l.idle, Duration::from_millis(250));
        assert_eq!(l.headers, Duration::from_secs(60));
        assert_eq!(
            conn_limits(&Env::from_pairs(&[("NBO_EDGE_IDLE_TIMEOUT_MS", "-1")])).idle,
            Duration::from_secs(5)
        );
    }

    #[test]
    fn http2_is_on_unless_turned_off() {
        assert!(http2_enabled(&Env::default()));
        assert!(http2_enabled(&Env::from_pairs(&[("NBO_EDGE_HTTP2", "on")])));
        assert!(!http2_enabled(&Env::from_pairs(&[(
            "NBO_EDGE_HTTP2",
            "off"
        )])));
        assert!(!http2_enabled(&Env::from_pairs(&[(
            "NBO_EDGE_HTTP2",
            " OFF "
        )])));
    }

    #[test]
    fn header_timeout_takes_positive_whole_milliseconds() {
        assert_eq!(header_timeout(&Env::default()), Duration::from_secs(30));
        assert_eq!(
            header_timeout(&Env::from_pairs(&[("NBO_EDGE_HEADER_TIMEOUT_MS", "1000")])),
            Duration::from_millis(1000)
        );
        for bad in ["0", "-5", "1.5", "abc", " ", "inf"] {
            assert_eq!(
                header_timeout(&Env::from_pairs(&[("NBO_EDGE_HEADER_TIMEOUT_MS", bad)])),
                Duration::from_secs(30),
                "{bad}"
            );
        }
    }
}
