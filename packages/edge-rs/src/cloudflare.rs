// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! The address ranges Cloudflare connects from. The edge believes
//! `cf-connecting-ip` only when the socket peer is in them. Port of
//! `packages/edge/src/cloudflare-trust.ts`.
//!
//! A plain value: it lives in the registry's snapshot next to the targets,
//! so one route-table swap replaces both together.

use std::net::IpAddr;

use ipnet::IpNet;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloudflareTrust {
    ranges: Vec<IpNet>,
}

impl CloudflareTrust {
    pub fn new() -> CloudflareTrust {
        CloudflareTrust::default()
    }

    /// The set of `cidrs`. An invalid range is skipped (the route table
    /// parser already rejects them).
    pub fn from_cidrs(cidrs: &[String]) -> CloudflareTrust {
        CloudflareTrust {
            ranges: cidrs
                .iter()
                .filter_map(|c| c.trim().parse::<IpNet>().ok())
                .collect(),
        }
    }

    /// Whether the address text `ip` is in a range; false for anything
    /// that is not an address.
    pub fn has(&self, ip: &str) -> bool {
        ip.parse::<IpAddr>().is_ok_and(|addr| self.has_addr(addr))
    }

    /// Whether `addr` is in a range. An IPv4-mapped IPv6 address (how a
    /// dual-stack socket reports an IPv4 peer) is checked as IPv4.
    pub fn has_addr(&self, addr: IpAddr) -> bool {
        let addr = addr.to_canonical();
        self.ranges.iter().any(|net| net.contains(&addr))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trust(cidrs: &[&str]) -> CloudflareTrust {
        CloudflareTrust::from_cidrs(&cidrs.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn is_empty_by_default() {
        assert!(!CloudflareTrust::new().has("104.16.0.1"));
    }

    #[test]
    fn matches_ipv4_ranges() {
        let t = trust(&["104.16.0.0/13"]);
        assert!(t.has("104.16.0.1"));
        assert!(t.has("104.23.255.255"));
        assert!(!t.has("104.24.0.0"));
        assert!(!t.has("8.8.8.8"));
    }

    #[test]
    fn matches_ipv6_ranges() {
        let t = trust(&["2606:4700::/32"]);
        assert!(t.has("2606:4700::1"));
        assert!(!t.has("2001:db8::1"));
    }

    #[test]
    fn is_false_for_non_addresses() {
        let t = trust(&["104.16.0.0/13"]);
        assert!(!t.has("not-an-ip"));
        assert!(!trust(&[]).has("104.16.0.1"));
    }

    #[test]
    fn skips_invalid_ranges() {
        let t = trust(&["nope", "10.0.0.0/99", "1.2.3.4", "104.16.0.0/13"]);
        assert!(t.has("104.16.0.1"));
        assert!(!t.has("10.0.0.1"));
        assert!(!t.has("1.2.3.4"));
    }

    #[test]
    fn checks_ipv4_mapped_peers_as_ipv4() {
        let t = trust(&["104.16.0.0/13"]);
        assert!(t.has_addr("::ffff:104.16.0.1".parse().unwrap()));
        assert!(!t.has_addr("::ffff:8.8.8.8".parse().unwrap()));
    }
}
