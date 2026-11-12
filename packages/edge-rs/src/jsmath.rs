// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! JavaScript's `Math.log`, bit for bit.
//!
//! V8 computes `Math.log` with fdlibm's `__ieee754_log` (`src/base/ieee754.cc`).
//! The platform `ln` (MSVC's CRT, glibc) may round the last bit differently,
//! and at a histogram bucket edge one bit decides the bucket (and, rarely,
//! a sticky pick). This is fdlibm's `e_log.c` (FreeBSD's copy, which V8
//! uses), translated line by line, so the edge buckets and picks exactly as
//! the TypeScript edge did on every platform.

const LN2_HI: f64 = f64::from_bits(0x3fe6_2e42_fee0_0000); // 6.93147180369123816490e-01
const LN2_LO: f64 = f64::from_bits(0x3dea_39ef_3579_3c76); // 1.90821492927058770002e-10
const TWO54: f64 = f64::from_bits(0x4350_0000_0000_0000); // 1.80143985094819840000e+16
const LG1: f64 = f64::from_bits(0x3fe5_5555_5555_5593); // 6.666666666666735130e-01
const LG2: f64 = f64::from_bits(0x3fd9_9999_9997_fa04); // 3.999999999940941908e-01
const LG3: f64 = f64::from_bits(0x3fd2_4924_9422_9359); // 2.857142874366239149e-01
const LG4: f64 = f64::from_bits(0x3fcc_71c5_1d8e_78af); // 2.222219843214978396e-01
const LG5: f64 = f64::from_bits(0x3fc7_4664_96cb_03de); // 1.818357216161805012e-01
const LG6: f64 = f64::from_bits(0x3fc3_9a09_d078_c69f); // 1.531383769920937332e-01
const LG7: f64 = f64::from_bits(0x3fc2_f112_df3e_5244); // 1.479819860511658591e-01
// fdlibm's 0.33333333333333333, the double nearest 1/3.
const THIRD: f64 = f64::from_bits(0x3fd5_5555_5555_5555);

fn high_word(x: f64) -> i32 {
    (x.to_bits() >> 32) as u32 as i32
}

fn low_word(x: f64) -> u32 {
    x.to_bits() as u32
}

fn with_high_word(x: f64, hi: i32) -> f64 {
    f64::from_bits((u64::from(hi as u32) << 32) | u64::from(low_word(x)))
}

/// `Math.log(x)` as V8 computes it.
pub fn log(mut x: f64) -> f64 {
    let mut hx = high_word(x);
    let lx = low_word(x);
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        // x < 2^-1022
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY; // log(+-0) = -inf
        }
        if hx < 0 {
            return f64::NAN; // log(-#) = NaN
        }
        // subnormal number, scale up x
        k -= 54;
        x *= TWO54;
        hx = high_word(x);
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x10_0000;
    x = with_high_word(x, hx | (i ^ 0x3ff0_0000)); // normalize x or x/2
    k += i >> 20;
    let f = x - 1.0;
    if (0x000f_ffff & (2 + hx)) < 3 {
        // -2^-20 <= f < 2^-20
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = f64::from(k);
            return dk * LN2_HI + dk * LN2_LO;
        }
        let r = f * f * (0.5 - THIRD * f);
        if k == 0 {
            return f - r;
        }
        let dk = f64::from(k);
        return dk * LN2_HI - ((r - dk * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let dk = f64::from(k);
    let z = s * s;
    let mut i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_their_decimal_spelling() {
        assert_eq!(THIRD, 1.0 / 3.0);
        assert_eq!(TWO54, 2f64.powi(54));
        assert_eq!(LN2_HI + LN2_LO, std::f64::consts::LN_2);
    }

    #[test]
    fn special_values() {
        assert_eq!(log(1.0), 0.0);
        assert_eq!(log(0.0), f64::NEG_INFINITY);
        assert_eq!(log(-0.0), f64::NEG_INFINITY);
        assert!(log(-1.0).is_nan());
        assert!(log(f64::NAN).is_nan());
        assert_eq!(log(f64::INFINITY), f64::INFINITY);
        assert!((log(5e-324) - -744.440_071_921_381_3).abs() < 1e-12);
    }

    #[test]
    fn close_to_the_platform_ln() {
        let mut x = 1e-300;
        while x < 1e300 {
            let (a, b) = (log(x), x.ln());
            assert!(
                (a - b).abs() <= b.abs() * 4.0 * f64::EPSILON,
                "{x}: {a} vs {b}"
            );
            x *= 1.37;
        }
    }

    // Values printed by node (V8) with Math.log, as bit patterns.
    #[test]
    fn matches_v8_on_known_values() {
        assert_eq!(log(1.05), 0.04879016416943205);
        assert_eq!(log(2.0), std::f64::consts::LN_2);
        assert_eq!(log(10.0), std::f64::consts::LN_10);
        assert_eq!(log(1.157625), 0.14637049250829592);
        assert_eq!(log(1.1576250000000001), 0.14637049250829612);
        assert_eq!(log(0.123456789), -2.091864070778393);
        assert_eq!(log(3e-310), -712.7027665394861);
        assert_eq!(log(123456.789), 11.723646487185881);
    }
}
