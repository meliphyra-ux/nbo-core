// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! The Speed Insights script the edge serves at
//! `/_nbo/insights/v1/script.js`: the vendored web-vitals IIFE and NBO's
//! loader in one function. Port of `packages/edge/src/insights/script.ts`;
//! the bytes are the TypeScript edge's (the black-box suite compares them).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use bytes::Bytes;
use http::header::{CACHE_CONTROL, CONTENT_TYPE};
use http::{HeaderValue, Response, StatusCode};

use super::route::{ID_PATTERN_SOURCES, MAX_ROUTE_LENGTH};
use crate::proxy::{EdgeBody, empty_body, full};
use crate::text::is_js_space;

pub const INSIGHTS_PREFIX: &str = "/_nbo/insights/v1/";
pub const SCRIPT_PATH: &str = "/_nbo/insights/v1/script.js";
pub const VITALS_PATH: &str = "/_nbo/insights/v1/vitals";

/// web-vitals 6.2.3's IIFE build (`var webVitals = ...`), vendored; a
/// TypeScript test checks it equals `node_modules/web-vitals`' copy.
const WEB_VITALS: &str = include_str!("../../assets/web-vitals.iife.js");

/// `source.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, "")`: the first
/// sourcemap comment that only whitespace follows after its line, with
/// the newline before it, is cut off with everything after it.
fn strip_source_map(source: &str) -> &str {
    const MARK: &str = "//# sourceMappingURL=";
    let mut from = 0;
    while let Some(i) = source[from..].find(MARK) {
        let at = from + i;
        let rest = &source[at + MARK.len()..];
        // `.` stops at a line terminator; `\s*$` then needs only
        // whitespace to the end.
        let line_end = rest
            .find(['\n', '\r', '\u{2028}', '\u{2029}'])
            .unwrap_or(rest.len());
        if rest[line_end..].chars().all(is_js_space) {
            let start = if source[..at].ends_with('\n') {
                at - 1
            } else {
                at
            };
            return &source[..start];
        }
        from = at + 1;
    }
    source
}

/// `JSON.stringify(s)`.
fn js_string(s: &str) -> String {
    serde_json::to_string(s).expect("a string always serialises")
}

/// NBO's few lines on top of web-vitals, byte for byte the TypeScript
/// edge's `loaderSource`. It expects a `webVitals` binding in scope, reads
/// data-e / data-d / data-s from its own <script> tag, decides once per
/// page view whether this view is sampled, and sends each final metric as
/// one beacon. It runs once per page and never throws into the page.
pub fn loader_source(sample_rate: u8) -> String {
    let patterns = ID_PATTERN_SOURCES
        .iter()
        .map(|(source, flags)| format!("new RegExp({},{})", js_string(source), js_string(flags)))
        .collect::<Vec<_>>()
        .join(",");
    let url = js_string(VITALS_PATH);
    format!(
        r#"(function(){{try{{
var w=typeof window!=="undefined"?window:null;if(w){{if(w.__nboInsights)return;w.__nboInsights=1}}
var s=document.currentScript,ds=(s&&s.dataset)||{{}};
var rate=Number(ds.s!=null&&ds.s!==""?ds.s:{sample_rate});
if(!(rate>0)||!(Math.random()*100<rate))return;
var V=typeof webVitals!=="undefined"?webVitals:null;if(!V)return;
var ids=[{patterns}];
function isId(g){{for(var i=0;i<ids.length;i++)if(ids[i].test(g))return true;return false}}
var segs=String(location.pathname||"/").split("/");
for(var i=0;i<segs.length;i++)if(segs[i]!==""&&isId(segs[i]))segs[i]="[id]";
var route=segs.join("/").slice(0,{MAX_ROUTE_LENGTH});
var n=navigator||{{}},uad=n.userAgentData,mobile;
if(uad&&typeof uad.mobile==="boolean")mobile=uad.mobile;
else mobile=/Mobi|Android|iPhone|iPod/i.test(n.userAgent||"")||(typeof innerWidth==="number"&&innerWidth>0&&innerWidth<768);
var device=mobile?"mobile":"desktop";
var url={url};
function send(m){{try{{
var b={{metric:m.name,value:m.value,route:route,device:device}};
if(ds.e!=null)b.environmentId=ds.e;if(ds.d!=null)b.contentId=ds.d;
var body=JSON.stringify(b);
if(n.sendBeacon&&n.sendBeacon(url,body))return;
if(typeof fetch==="function")fetch(url,{{method:"POST",body:body,keepalive:true,credentials:"same-origin"}}).catch(function(){{}});
}}catch(e){{}}}}
var names=["onLCP","onINP","onCLS","onFCP","onTTFB"];
for(var k=0;k<names.length;k++){{try{{V[names[k]](send)}}catch(e){{}}}}
}}catch(e){{}}}})();
"#
    )
}

/// The script for one sample rate: web-vitals and the loader inside one
/// function, so `webVitals` never leaks to the page's globals.
pub fn build_script(sample_rate: u8) -> String {
    format!(
        "(function(){{\n{};\n{}}})();\n",
        strip_source_map(WEB_VITALS),
        loader_source(sample_rate)
    )
}

fn cached_script(sample_rate: u8) -> Bytes {
    static CACHE: OnceLock<Mutex<HashMap<u8, Bytes>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    cache
        .entry(sample_rate)
        .or_insert_with(|| Bytes::from(build_script(sample_rate)))
        .clone()
}

/// Serves the script (headers only for HEAD). web-vitals is compiled in,
/// so unlike the TypeScript edge there is no 503 for a broken install.
pub fn script_response(sample_rate: u8, head: bool) -> Response<EdgeBody> {
    let body = if head {
        empty_body()
    } else {
        full(cached_script(sample_rate))
    };
    let mut res = Response::new(body);
    *res.status_mut() = StatusCode::OK;
    let h = res.headers_mut();
    h.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/javascript; charset=utf-8"),
    );
    h.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_only_a_trailing_source_map_comment() {
        assert_eq!(strip_source_map("a;\n//# sourceMappingURL=x.map\n"), "a;");
        assert_eq!(
            strip_source_map("a;\r\n//# sourceMappingURL=x.map\r\n"),
            "a;\r"
        );
        assert_eq!(strip_source_map("a;//# sourceMappingURL=x.map"), "a;");
        // Code after the comment's line: not a trailing comment.
        assert_eq!(
            strip_source_map("a;\n//# sourceMappingURL=x.map\nb;"),
            "a;\n//# sourceMappingURL=x.map\nb;"
        );
        assert_eq!(strip_source_map("a;"), "a;");
    }

    #[test]
    fn the_vendored_web_vitals_loses_its_source_map_line() {
        let s = build_script(100);
        assert!(!s.contains("sourceMappingURL"));
        assert!(s.starts_with("(function(){\nvar webVitals="));
        assert!(s.contains("}({});;\n(function(){try{\n"));
        assert!(s.ends_with("}catch(e){}})();\n})();\n"));
    }

    #[test]
    fn the_loader_carries_the_rate_patterns_and_beacon_url() {
        let l = loader_source(25);
        assert!(l.contains(r#"var rate=Number(ds.s!=null&&ds.s!==""?ds.s:25);"#));
        assert!(l.contains(r#"var ids=[new RegExp("^\\d+$",""),new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","i"),"#));
        assert!(l.contains(
            r#"new RegExp("^(?=.*\\d)[A-Za-z0-9_.~%+=-]{20,}$",""),new RegExp("@","")];"#
        ));
        assert!(l.contains(r#"var route=segs.join("/").slice(0,200);"#));
        assert!(l.contains(r#"var url="/_nbo/insights/v1/vitals";"#));
    }

    #[test]
    fn serves_get_and_head_with_the_typescript_headers() {
        let r = script_response(50, false);
        assert_eq!(r.status(), 200);
        assert_eq!(
            r.headers()["content-type"],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(r.headers()["cache-control"], "public, max-age=3600");
        assert_eq!(r.headers()["x-content-type-options"], "nosniff");
        assert_eq!(cached_script(50), build_script(50));
        let h = script_response(50, true);
        assert_eq!(h.headers()["cache-control"], "public, max-age=3600");
    }
}
