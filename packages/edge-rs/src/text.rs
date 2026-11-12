// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! Small helpers that make Rust read text the way the TypeScript edge did,
//! so the two answer alike on odd input.

use http::HeaderMap;

/// Whether `c` is whitespace to JavaScript's `String.prototype.trim` and
/// `\s` (WhiteSpace plus LineTerminator). Rust's `char::is_whitespace`
/// differs: it includes U+0085 and leaves out U+FEFF.
pub fn is_js_space(c: char) -> bool {
    ('\u{2000}'..='\u{200a}').contains(&c)
        || matches!(
            c,
            '\t' | '\n'
                | '\u{b}'
                | '\u{c}'
                | '\r'
                | ' '
                | '\u{a0}'
                | '\u{1680}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
        )
}

/// `s.trim()` as JavaScript does it.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// Header bytes as Node reads them: one character per byte (latin1).
pub fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

/// A latin1 string back to header bytes. Characters above U+00FF (which
/// latin1 input never produces) become `?`.
pub fn latin1_bytes(s: &str) -> Vec<u8> {
    s.chars()
        .map(|c| if (c as u32) <= 0xff { c as u8 } else { b'?' })
        .collect()
}

/// Every value of header `name`, joined by `sep`, or `None` when the
/// header is absent.
pub fn header_joined(headers: &HeaderMap, name: &str, sep: &str) -> Option<String> {
    let mut values = headers.get_all(name).iter().peekable();
    values.peek()?;
    Some(
        values
            .map(|v| latin1(v.as_bytes()))
            .collect::<Vec<_>>()
            .join(sep),
    )
}

/// `JSON.stringify(s)` for a string, used to quote names in error texts.
pub fn quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_trim_matches_javascript() {
        assert_eq!(js_trim("\u{feff} a \u{a0}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn latin1_round_trips() {
        let bytes = [b'a', 0xe9, 0x85];
        assert_eq!(latin1_bytes(&latin1(&bytes)), bytes);
    }

    #[test]
    fn quote_is_json() {
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
    }
}
