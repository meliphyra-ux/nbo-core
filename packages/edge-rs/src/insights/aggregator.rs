// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Folding beacons into per-minute histograms until the control-plane
//! drains them. Port of `packages/edge/src/insights/aggregator.ts`; the
//! drain's JSON is the edge-to-control-plane contract.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use super::histogram::{Metric, bucket_index};

/// A visitor's device class, from the beacon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Device {
    Mobile,
    Desktop,
}

impl Device {
    pub fn parse(name: &str) -> Option<Device> {
        match name {
            "mobile" => Some(Device::Mobile),
            "desktop" => Some(Device::Desktop),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Device::Mobile => "mobile",
            Device::Desktop => "desktop",
        }
    }
}

/// One validated beacon.
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub host: String,
    pub environment_id: String,
    pub content_id: String,
    pub route: String,
    pub metric: Metric,
    pub device: Device,
    pub value: f64,
}

/// The route beacons over the per-host route limit are counted under.
pub const OTHER_ROUTE: &str = "(other)";

/// The aggregator's limits; `Default` is the TypeScript edge's.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_routes_per_host_minute: usize,
    pub max_beacons_per_host_second: u32,
    pub max_content_ids_per_environment_minute: usize,
    /// Bounds memory when nobody drains.
    pub max_keys: usize,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            max_routes_per_host_minute: 100,
            max_beacons_per_host_second: 1000,
            max_content_ids_per_environment_minute: 5,
            max_keys: 100_000,
        }
    }
}

/// The clock, in milliseconds since the epoch (`Date.now()`).
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

fn system_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

struct Batch {
    host: String,
    environment_id: String,
    content_id: String,
    route: String,
    metric: Metric,
    device: Device,
    minute: String,
    buckets: BTreeMap<u32, u64>,
    count: u64,
}

impl Batch {
    fn to_json(&self) -> Value {
        // Bucket keys are integers, so a JavaScript object lists them in
        // ascending order; the BTreeMap does too.
        let buckets: Map<String, Value> = self
            .buckets
            .iter()
            .map(|(i, n)| (i.to_string(), json!(n)))
            .collect();
        json!({
            "host": self.host,
            "environmentId": self.environment_id,
            "contentId": self.content_id,
            "route": self.route,
            "metric": self.metric.name(),
            "device": self.device.name(),
            "minute": self.minute,
            "buckets": buckets,
            "count": self.count,
        })
    }
}

#[derive(Default)]
struct State {
    batches: Held,
    // Admission state, kept across drains: limits are per minute, and a
    // drain in the middle of a minute must not reset them.
    routes_seen: HashMap<String, HashSet<String>>,
    content_ids_seen: HashMap<String, HashSet<String>>,
    limits_minute: Option<i64>,
    rate: HashMap<String, (i64, u32)>,
    dropped: u64,
}

/// The histograms held, remembering insertion order so the oldest can go in
/// constant time (the Node edge's `Map` semantics). A key leaves the order
/// queue only with its entry, so the queue never holds a stale key.
#[derive(Default)]
struct Held {
    map: HashMap<String, Batch>,
    order: VecDeque<String>,
}

impl Held {
    fn len(&self) -> usize {
        self.map.len()
    }
    fn contains_key(&self, key: &str) -> bool {
        self.map.contains_key(key)
    }
    fn get_mut(&mut self, key: &str) -> Option<&mut Batch> {
        self.map.get_mut(key)
    }
    fn insert(&mut self, key: String, batch: Batch) {
        if self.map.insert(key.clone(), batch).is_none() {
            self.order.push_back(key);
        }
    }
    fn evict_oldest(&mut self) {
        if let Some(key) = self.order.pop_front() {
            self.map.remove(&key);
        }
    }
    fn into_ordered(mut self) -> Vec<Batch> {
        let mut out = Vec::with_capacity(self.order.len());
        for key in self.order.drain(..) {
            if let Some(b) = self.map.remove(&key) {
                out.push(b);
            }
        }
        out
    }
}

/// Holds every histogram since the last drain. Shared by the data plane
/// (beacons) and the admin API (drain).
pub struct Aggregator {
    state: Mutex<State>,
    limits: Limits,
    now: Clock,
}

impl std::fmt::Debug for Aggregator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Aggregator")
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl Default for Aggregator {
    fn default() -> Aggregator {
        Aggregator::new(Limits::default(), Arc::new(system_now))
    }
}

// Whether `value` may be counted as itself under `key`: already seen, or
// a new one while fewer than `max` are held.
fn admit_value(
    seen: &mut HashMap<String, HashSet<String>>,
    key: &str,
    value: &str,
    max: usize,
) -> bool {
    let set = seen.entry(key.to_string()).or_default();
    if set.contains(value) {
        return true;
    }
    if set.len() >= max {
        return false;
    }
    set.insert(value.to_string());
    true
}

impl Aggregator {
    pub fn new(limits: Limits, now: Clock) -> Aggregator {
        Aggregator {
            state: Mutex::new(State::default()),
            limits,
            now,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Takes one beacon of `host` against its per-second rate. It is
    /// checked before the beacon's body is read, so a flood costs no
    /// parsing; false means drop it (and it is counted as dropped).
    pub fn admit(&self, host: &str) -> bool {
        let second = ((self.now)() as f64 / 1000.0).floor() as i64;
        let mut s = self.lock();
        match s.rate.get_mut(host) {
            Some((sec, count)) if *sec == second => {
                if *count >= self.limits.max_beacons_per_host_second {
                    s.dropped += 1;
                    return false;
                }
                *count += 1;
            }
            _ => {
                if s.rate.len() > 10_000 {
                    s.rate.clear();
                }
                s.rate.insert(host.to_string(), (second, 1));
            }
        }
        true
    }

    /// Counts an admitted, validated beacon.
    pub fn add(&self, sample: &Sample) {
        let t = (self.now)();
        let minute_ms = t.div_euclid(60_000) * 60_000;
        let mut s = self.lock();
        let s = &mut *s;

        if s.limits_minute != Some(minute_ms) {
            s.limits_minute = Some(minute_ms);
            s.routes_seen = HashMap::new();
            s.content_ids_seen = HashMap::new();
        }
        let route = if admit_value(
            &mut s.routes_seen,
            &sample.host,
            &sample.route,
            self.limits.max_routes_per_host_minute,
        ) {
            sample.route.as_str()
        } else {
            OTHER_ROUTE
        };
        let content_id = if admit_value(
            &mut s.content_ids_seen,
            &format!("{}\0{}", sample.host, sample.environment_id),
            &sample.content_id,
            self.limits.max_content_ids_per_environment_minute,
        ) {
            sample.content_id.as_str()
        } else {
            ""
        };

        let minute = iso_minute(minute_ms);
        let key = [
            sample.host.as_str(),
            sample.environment_id.as_str(),
            content_id,
            route,
            sample.metric.name(),
            sample.device.name(),
            minute.as_str(),
        ]
        .join("\0");
        if !s.batches.contains_key(&key) {
            // Nothing drains in a core-only install: keep the newest, drop the
            // oldest, in constant time (see `Held`).
            if s.batches.len() >= self.limits.max_keys {
                s.batches.evict_oldest();
                s.dropped += 1;
            }
            let batch = Batch {
                host: sample.host.clone(),
                environment_id: sample.environment_id.clone(),
                content_id: content_id.to_string(),
                route: route.to_string(),
                metric: sample.metric,
                device: sample.device,
                minute,
                buckets: BTreeMap::new(),
                count: 0,
            };
            s.batches.insert(key.clone(), batch);
        }
        let batch = s.batches.get_mut(&key).expect("inserted above");
        *batch
            .buckets
            .entry(bucket_index(sample.metric, sample.value))
            .or_insert(0) += 1;
        batch.count += 1;
    }

    /// Every histogram held, as `GET /insights/drain` answers, forgotten in
    /// the same step, so no beacon is counted twice or lost in between.
    pub fn drain(&self) -> Value {
        let batches = std::mem::take(&mut self.lock().batches);
        json!({ "batches": batches.into_ordered().iter().map(Batch::to_json).collect::<Vec<_>>() })
    }

    /// Beacons refused by the per-host rate cap or the key cap.
    pub fn dropped(&self) -> u64 {
        self.lock().dropped
    }
}

/// `new Date(ms).toISOString()` for a whole minute.
fn iso_minute(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let hour = rem / 3_600_000;
    let minute = rem % 3_600_000 / 60_000;
    let second = rem % 60_000 / 1000;
    let millis = rem % 1000;
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

// Howard Hinnant's days-to-civil algorithm (proleptic Gregorian).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    // 2026-11-03T10:15:42.123Z
    const T0: i64 = 1_793_700_942_123;

    fn clock(start: i64) -> (Arc<AtomicI64>, Clock) {
        let now = Arc::new(AtomicI64::new(start));
        let read = Arc::clone(&now);
        (now, Arc::new(move || read.load(Ordering::SeqCst)))
    }

    fn sample() -> Sample {
        Sample {
            host: "app.test".into(),
            environment_id: "env_a".into(),
            content_id: "sha256:abc".into(),
            route: "/".into(),
            metric: Metric::Lcp,
            device: Device::Mobile,
            value: 1000.0,
        }
    }

    fn batches(v: &Value) -> Vec<Value> {
        v["batches"].as_array().unwrap().clone()
    }

    #[test]
    fn t0_is_the_typescript_tests_instant() {
        assert_eq!(iso_minute(T0 / 60_000 * 60_000), "2026-11-03T10:15:00.000Z");
        assert_eq!(iso_minute(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_minute(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn folds_samples_with_the_same_key_into_one_histogram_per_minute() {
        let (now, c) = clock(T0);
        let agg = Aggregator::new(Limits::default(), c);
        agg.add(&sample());
        agg.add(&sample());
        agg.add(&Sample {
            value: 2000.0,
            ..sample()
        });
        agg.add(&Sample {
            device: Device::Desktop,
            ..sample()
        });

        let b = batches(&agg.drain());
        assert_eq!(b.len(), 2);
        let mobile = b.iter().find(|x| x["device"] == "mobile").unwrap();
        let mut buckets = Map::new();
        buckets.insert(bucket_index(Metric::Lcp, 1000.0).to_string(), json!(2));
        buckets.insert(bucket_index(Metric::Lcp, 2000.0).to_string(), json!(1));
        assert_eq!(
            *mobile,
            json!({
                "host": "app.test",
                "environmentId": "env_a",
                "contentId": "sha256:abc",
                "route": "/",
                "metric": "LCP",
                "device": "mobile",
                "minute": "2026-11-03T10:15:00.000Z",
                "buckets": buckets,
                "count": 3,
            })
        );
        // The drain's key order is the contract's.
        let keys: Vec<&String> = mobile.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "host",
                "environmentId",
                "contentId",
                "route",
                "metric",
                "device",
                "minute",
                "buckets",
                "count"
            ]
        );

        now.fetch_add(60_000, Ordering::SeqCst);
        agg.add(&sample());
        assert_eq!(
            batches(&agg.drain())[0]["minute"],
            "2026-11-03T10:16:00.000Z"
        );
    }

    #[test]
    fn bucket_keys_ascend_numerically() {
        let (_, c) = clock(T0);
        let agg = Aggregator::new(Limits::default(), c);
        for v in [5000.0, 3.0, 40.0] {
            agg.add(&Sample {
                value: v,
                ..sample()
            });
        }
        let b = batches(&agg.drain());
        let keys: Vec<u32> = b[0]["buckets"]
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.parse().unwrap())
            .collect();
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        assert_eq!(keys, sorted);
    }

    #[test]
    fn drain_clears_what_it_returned() {
        let (_, c) = clock(T0);
        let agg = Aggregator::new(Limits::default(), c);
        agg.add(&sample());
        assert_eq!(batches(&agg.drain()).len(), 1);
        assert_eq!(batches(&agg.drain()).len(), 0);
    }

    #[test]
    fn counts_routes_beyond_100_per_host_per_minute_under_other() {
        let (now, c) = clock(T0);
        let agg = Aggregator::new(Limits::default(), c);
        for i in 0..105 {
            agg.add(&Sample {
                route: format!("/p{i}"),
                ..sample()
            });
        }
        agg.add(&Sample {
            route: "/p3".into(),
            ..sample()
        });
        agg.add(&Sample {
            host: "other.test".into(),
            route: "/p104".into(),
            ..sample()
        });

        let b = batches(&agg.drain());
        let for_app: Vec<&Value> = b.iter().filter(|x| x["host"] == "app.test").collect();
        let routes: HashSet<&str> = for_app
            .iter()
            .map(|x| x["route"].as_str().unwrap())
            .collect();
        assert_eq!(routes.len(), 101);
        let count = |r: &str| for_app.iter().find(|x| x["route"] == r).unwrap()["count"].clone();
        assert_eq!(count("(other)"), 5);
        assert_eq!(count("/p3"), 2);
        assert_eq!(
            b.iter().find(|x| x["host"] == "other.test").unwrap()["route"],
            "/p104"
        );

        now.fetch_add(60_000, Ordering::SeqCst);
        agg.add(&Sample {
            route: "/p104".into(),
            ..sample()
        });
        assert_eq!(batches(&agg.drain())[0]["route"], "/p104");
    }

    #[test]
    fn drops_beacons_beyond_1000_per_host_per_second_and_counts_them() {
        let (now, c) = clock(T0);
        let agg = Aggregator::new(Limits::default(), c);
        let offer = |s: Sample| {
            if agg.admit(&s.host) {
                agg.add(&s);
            }
        };
        for _ in 0..1005 {
            offer(sample());
        }
        offer(Sample {
            host: "other.test".into(),
            ..sample()
        });
        assert_eq!(agg.dropped(), 5);
        now.fetch_add(1000, Ordering::SeqCst);
        offer(sample());

        let b = batches(&agg.drain());
        let count = |h: &str| b.iter().find(|x| x["host"] == h).unwrap()["count"].clone();
        assert_eq!(count("app.test"), 1001);
        assert_eq!(count("other.test"), 1);
    }

    #[test]
    fn the_rate_window_is_the_wall_clock_second() {
        // 999 ms into a second: one more millisecond starts a new window.
        let (now, c) = clock(1_000_999);
        let agg = Aggregator::new(Limits::default(), c);
        for _ in 0..1000 {
            assert!(agg.admit("app.test"));
        }
        assert!(!agg.admit("app.test"));
        now.fetch_add(1, Ordering::SeqCst);
        assert!(agg.admit("app.test"));
    }

    #[test]
    fn limits_distinct_content_ids_per_environment_per_minute() {
        let (_, c) = clock(T0);
        let agg = Aggregator::new(Limits::default(), c);
        for i in 0..8 {
            agg.add(&Sample {
                content_id: format!("sha256:{i}"),
                ..sample()
            });
        }
        let ids: HashSet<String> = batches(&agg.drain())
            .iter()
            .map(|b| b["contentId"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids.len(), 6);
        assert!(ids.contains(""));
    }

    #[test]
    fn at_the_cap_the_oldest_key_goes_first_and_the_bound_holds() {
        let (_, c) = clock(T0);
        let agg = Aggregator::new(
            Limits {
                max_keys: 3,
                ..Limits::default()
            },
            c,
        );
        for route in ["/a", "/b", "/c", "/d", "/e"] {
            agg.add(&Sample {
                route: route.into(),
                ..sample()
            });
        }
        assert_eq!(agg.dropped(), 2);
        let routes: Vec<Value> = batches(&agg.drain())
            .iter()
            .map(|b| b["route"].clone())
            .collect();
        assert_eq!(routes, vec![json!("/c"), json!("/d"), json!("/e")]);
        // A flood of distinct keys never grows past the cap.
        for i in 0..1000 {
            agg.add(&Sample {
                host: format!("h{i}.test"),
                ..sample()
            });
        }
        let b = batches(&agg.drain());
        assert_eq!(b.len(), 3);
        assert_eq!(b[2]["host"], "h999.test");
    }

    #[test]
    fn at_100k_keys_drops_the_oldest_and_counts_it_as_dropped() {
        let (_, c) = clock(T0);
        let agg = Aggregator::new(Limits::default(), c);
        for i in 0..100_000 {
            agg.add(&Sample {
                host: format!("h{i}.test"),
                ..sample()
            });
        }
        assert_eq!(agg.dropped(), 0);
        // A new key pushes out the oldest (h0); an existing one still counts.
        agg.add(&Sample {
            host: "one-too-many.test".into(),
            ..sample()
        });
        agg.add(&Sample {
            host: "h7.test".into(),
            ..sample()
        });
        assert_eq!(agg.dropped(), 1);
        let b = batches(&agg.drain());
        assert_eq!(b.len(), 100_000);
        assert!(b.iter().all(|x| x["host"] != "h0.test"));
        assert!(b.iter().any(|x| x["host"] == "one-too-many.test"));
        assert_eq!(
            b.iter().find(|x| x["host"] == "h7.test").unwrap()["count"],
            2
        );
        // A drain makes room again.
        agg.add(&Sample {
            host: "one-too-many.test".into(),
            ..sample()
        });
        assert_eq!(batches(&agg.drain()).len(), 1);
    }
}
