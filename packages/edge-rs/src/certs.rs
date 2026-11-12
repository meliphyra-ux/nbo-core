// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Cluster mode's certificates: one key pair per Kubernetes Secret name,
//! found for a host through its target's `tls` name. Port of
//! `packages/edge/src/cert-store.ts`'s `CertStore`; the ACME challenges
//! live in the registry's snapshot instead, swapped with the route table.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};

use crate::registry::{Registry, Snapshot};
use crate::text::quote;

/// The key pairs by Secret name.
#[derive(Debug, Default)]
pub struct CertStore {
    pairs: RwLock<HashMap<String, Loaded>>,
}

#[derive(Debug)]
struct Loaded {
    cert_pem: String,
    key_pem: String,
    key: Arc<CertifiedKey>,
}

/// A PEM certificate chain and its private key as one rustls key pair, or
/// why not.
pub fn certified_key(cert_pem: &str, key_pem: &str) -> Result<CertifiedKey, String> {
    let (chain, key) = pem_pair(cert_pem.as_bytes(), key_pem.as_bytes())?;
    CertifiedKey::from_der(chain, key, &rustls::crypto::ring::default_provider())
        .map_err(|e| e.to_string())
}

/// A PEM certificate chain (at least one certificate) and a PEM private
/// key (PKCS#8, PKCS#1 or SEC1).
pub type PemPair = (Vec<CertificateDer<'static>>, PrivateKeyDer<'static>);

pub fn pem_pair(cert_pem: &[u8], key_pem: &[u8]) -> Result<PemPair, String> {
    let chain = CertificateDer::pem_slice_iter(cert_pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("certificate: {e}"))?;
    if chain.is_empty() {
        return Err("certificate: no PEM certificate".to_string());
    }
    let key = PrivateKeyDer::from_pem_slice(key_pem).map_err(|e| format!("private key: {e}"))?;
    Ok((chain, key))
}

impl CertStore {
    pub fn new() -> CertStore {
        CertStore::default()
    }

    /// Loads `secret_name`'s pair. A bad pair never takes the edge down:
    /// it is logged and the name has no certificate until a good pair
    /// arrives; every other name keeps serving.
    pub fn set(&self, secret_name: &str, cert_pem: &str, key_pem: &str) -> Result<(), String> {
        // Every poll lists every Secret again: an unchanged pair is not
        // parsed again.
        if let Some(old) = self.read().get(secret_name)
            && old.cert_pem == cert_pem
            && old.key_pem == key_pem
        {
            return Ok(());
        }
        match certified_key(cert_pem, key_pem) {
            Ok(key) => {
                self.write().insert(
                    secret_name.to_string(),
                    Loaded {
                        cert_pem: cert_pem.to_string(),
                        key_pem: key_pem.to_string(),
                        key: Arc::new(key),
                    },
                );
                Ok(())
            }
            Err(err) => {
                eprintln!("edge: certificate {} skipped: {err}", quote(secret_name));
                self.write().remove(secret_name);
                Err(err)
            }
        }
    }

    pub fn remove(&self, secret_name: &str) {
        self.write().remove(secret_name);
    }

    /// The pair stored under `secret_name`.
    pub fn get(&self, secret_name: &str) -> Option<Arc<CertifiedKey>> {
        self.read().get(secret_name).map(|l| Arc::clone(&l.key))
    }

    /// The pair for `host`: its target's `tls` Secret, when loaded.
    pub fn for_host(&self, host: &str, snapshot: &Snapshot) -> Option<Arc<CertifiedKey>> {
        let name = snapshot.target(host)?.tls.as_deref()?;
        self.get(name)
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, HashMap<String, Loaded>> {
        self.pairs.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, Loaded>> {
        self.pairs.write().unwrap_or_else(|e| e.into_inner())
    }
}

/// Picks the certificate by the visitor's SNI name. No name, no target, no
/// `tls` name or no loaded pair: the handshake fails.
#[derive(Debug)]
pub struct SniResolver {
    pub registry: Arc<Registry>,
    pub certs: Arc<CertStore>,
}

impl ResolvesServerCert for SniResolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let name = hello.server_name()?;
        self.certs.for_host(name, &self.registry.snapshot())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::route_table::parse_route_table;

    /// A self-signed pair for `name`, made at test time.
    pub(crate) fn pair(name: &str) -> (String, String) {
        let key = rcgen::KeyPair::generate().unwrap();
        let params = rcgen::CertificateParams::new(vec![name.to_string()]).unwrap();
        let cert = params.self_signed(&key).unwrap();
        (cert.pem(), key.serialize_pem())
    }

    fn registry_with_tls() -> Registry {
        let registry = Registry::new();
        let table = parse_route_table(
            r#"{"version":1,"targets":{
                "a.test":{"backends":[{"url":"http://127.0.0.1:1","weight":1}],"tls":"a-tls"},
                "b.test":{"backends":[{"url":"http://127.0.0.1:1","weight":1}],"tls":"b-tls"},
                "plain.test":{"backends":[{"url":"http://127.0.0.1:1","weight":1}]}
            },"challenges":{}}"#,
        )
        .unwrap();
        registry.replace_table(&table).unwrap();
        registry
    }

    #[test]
    fn a_bad_pair_is_skipped_and_the_others_keep_serving() {
        let store = CertStore::new();
        let (a_cert, a_key) = pair("a.test");
        let (b_cert, b_key) = pair("b.test");
        store.set("a-tls", &a_cert, &a_key).unwrap();
        store.set("b-tls", &b_cert, &b_key).unwrap();

        // Garbage, an empty chain and a key that belongs to another
        // certificate are all refused, each leaving b-tls without a pair.
        assert!(store.set("b-tls", "not a cert", "not a key").is_err());
        assert!(store.get("b-tls").is_none());
        store.set("b-tls", &b_cert, &b_key).unwrap();
        assert!(store.set("b-tls", "", &b_key).is_err());
        assert!(store.get("b-tls").is_none());
        store.set("b-tls", &b_cert, &b_key).unwrap();
        assert!(store.set("b-tls", &b_cert, &a_key).is_err());
        assert!(store.get("b-tls").is_none());

        // a-tls was never touched.
        let registry = registry_with_tls();
        let snap = registry.snapshot();
        assert!(store.for_host("a.test", &snap).is_some());
        assert!(store.for_host("A.Test.", &snap).is_some());
        assert!(store.for_host("b.test", &snap).is_none());
        assert!(store.for_host("plain.test", &snap).is_none());
        assert!(store.for_host("unknown.test", &snap).is_none());
    }

    #[test]
    fn remove_drops_only_that_name() {
        let store = CertStore::new();
        let (a_cert, a_key) = pair("a.test");
        let (b_cert, b_key) = pair("b.test");
        store.set("a-tls", &a_cert, &a_key).unwrap();
        store.set("b-tls", &b_cert, &b_key).unwrap();
        store.remove("b-tls");
        store.remove("never-there");
        assert!(store.get("a-tls").is_some());
        assert!(store.get("b-tls").is_none());
    }

    #[test]
    fn the_same_pair_again_keeps_the_loaded_key() {
        let store = CertStore::new();
        let (cert, key) = pair("a.test");
        store.set("a-tls", &cert, &key).unwrap();
        let first = store.get("a-tls").unwrap();
        store.set("a-tls", &cert, &key).unwrap();
        assert!(Arc::ptr_eq(&first, &store.get("a-tls").unwrap()));
    }
}
