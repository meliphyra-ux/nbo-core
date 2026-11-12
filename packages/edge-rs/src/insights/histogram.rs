// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Log-bucket histograms for Speed Insights, the contract shared with the
//! control-plane (`packages/edge/src/insights/histogram.ts`):
//!
//! - a value `v` (ms for timing metrics; CLS scaled by 1000 first) goes to
//!   bucket 0 when `v <= 0`, else to `1 + floor(ln v / ln 1.05)`, at least 1;
//! - bucket `i >= 1` stands for `1.05^(i - 0.5)`.

use crate::jsmath;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Metric {
    Lcp,
    Inp,
    Cls,
    Fcp,
    Ttfb,
}

impl Metric {
    pub const ALL: [Metric; 5] = [
        Metric::Lcp,
        Metric::Inp,
        Metric::Cls,
        Metric::Fcp,
        Metric::Ttfb,
    ];

    /// The beacon's metric name (`LCP`, `INP`, `CLS`, `FCP`, `TTFB`).
    pub fn parse(name: &str) -> Option<Metric> {
        Metric::ALL.into_iter().find(|m| m.name() == name)
    }

    pub fn name(self) -> &'static str {
        match self {
            Metric::Lcp => "LCP",
            Metric::Inp => "INP",
            Metric::Cls => "CLS",
            Metric::Fcp => "FCP",
            Metric::Ttfb => "TTFB",
        }
    }

    fn scale(self) -> f64 {
        if self == Metric::Cls { 1000.0 } else { 1.0 }
    }
}

/// `Math.log(1.05)` in V8, the bucket width; `jsmath::log(1.05)` gives the
/// same bits (a test checks).
const LN_1_05: f64 = f64::from_bits(0x3fa8_fb06_3ef2_c7f0);

/// The bucket for `value` (ms, or plain CLS).
pub fn bucket_index(metric: Metric, value: f64) -> u32 {
    let v = value * metric.scale();
    // As !(v > 0) in JavaScript: NaN goes to bucket 0 too.
    if v.is_nan() || v <= 0.0 {
        return 0;
    }
    let index = 1.0 + (jsmath::log(v) / LN_1_05).floor();
    // `as` saturates: +Infinity becomes u32::MAX (JavaScript gives Infinity).
    index.max(1.0) as u32
}

/// Bucket `index`'s representative value in scaled units (ms, or CLS x 1000).
pub fn bucket_value(index: u32) -> f64 {
    if index == 0 {
        0.0
    } else {
        1.05f64.powf(f64::from(index) - 0.5)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn golden_vectors_match_the_typescript_edge() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/golden/histogram.json"
        ));
        let cases: Vec<Value> = serde_json::from_str(raw).unwrap();
        assert_eq!(cases.len(), 2500);
        let mut wrong = Vec::new();
        for c in &cases {
            let metric = Metric::parse(c["metric"].as_str().unwrap()).unwrap();
            let value = c["value"].as_f64().unwrap();
            let want = c["index"].as_u64().unwrap() as u32;
            let got = bucket_index(metric, value);
            if got != want {
                wrong.push(format!(
                    "{} {value:e}: want {want}, got {got}",
                    metric.name()
                ));
            }
        }
        assert!(
            wrong.is_empty(),
            "{} mismatches:\n{}",
            wrong.len(),
            wrong.join("\n")
        );
    }

    #[test]
    fn ln_1_05_is_v8s_value() {
        assert_eq!(LN_1_05.to_bits(), jsmath::log(1.05).to_bits());
    }

    #[test]
    fn zero_negative_and_nan_go_to_bucket_0() {
        assert_eq!(bucket_index(Metric::Lcp, 0.0), 0);
        assert_eq!(bucket_index(Metric::Lcp, -5.0), 0);
        assert_eq!(bucket_index(Metric::Cls, 0.0), 0);
        assert_eq!(bucket_index(Metric::Lcp, f64::NAN), 0);
    }

    #[test]
    fn timing_metrics_and_cls_scaling() {
        assert_eq!(bucket_index(Metric::Lcp, 1000.0), 142);
        assert_eq!(bucket_index(Metric::Ttfb, 1.0), 1);
        assert_eq!(bucket_index(Metric::Inp, 0.5), 1);
        assert_eq!(
            bucket_index(Metric::Cls, 0.1),
            bucket_index(Metric::Lcp, 100.0)
        );
    }

    #[test]
    fn bucket_value_is_the_log_space_midpoint() {
        assert_eq!(bucket_value(0), 0.0);
        assert!((bucket_value(142) - 1.05f64.powf(141.5)).abs() < 1e-6);
        for v in [3.0, 47.0, 180.0, 950.0, 2600.0, 4100.0, 60_000.0] {
            assert!((bucket_value(bucket_index(Metric::Lcp, v)) - v).abs() / v < 0.05);
        }
    }

    #[test]
    fn metric_names_round_trip() {
        for m in Metric::ALL {
            assert_eq!(Metric::parse(m.name()), Some(m));
        }
        assert_eq!(Metric::parse("lcp"), None);
    }
}
