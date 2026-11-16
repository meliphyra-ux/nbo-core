// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ID_PATTERNS, MAX_ROUTE_LENGTH } from "./route.js";

export const INSIGHTS_PREFIX = "/_nbo/insights/v1/";
export const SCRIPT_PATH = `${INSIGHTS_PREFIX}script.js`;
export const VITALS_PATH = `${INSIGHTS_PREFIX}vitals`;

// The web-vitals IIFE build defines `var webVitals = …`. Its file is not in
// the package's exports map, so it is found next to the package's main
// entry. Read once, at first use.
function readWebVitalsFromPackage(): string {
  const require = createRequire(import.meta.url);
  return readFileSync(join(dirname(require.resolve("web-vitals")), "web-vitals.iife.js"), "utf8");
}

let reader: () => string = readWebVitalsFromPackage;
const cache = new Map<number, string>();
let webVitalsSource: string | undefined;

// setWebVitalsReaderForTest swaps how the web-vitals source is read (to
// force a failure) and returns the previous reader. It clears the caches.
export function setWebVitalsReaderForTest(next: () => string): () => string {
  const previous = reader;
  reader = next;
  webVitalsSource = undefined;
  cache.clear();
  return previous;
}

function readWebVitals(): string {
  if (webVitalsSource === undefined) {
    webVitalsSource = reader().replace(/\n?\/\/# sourceMappingURL=.*\s*$/, "");
  }
  return webVitalsSource;
}

// loaderSource is NBO's few lines on top of web-vitals. It expects a
// `webVitals` binding in scope, reads data-e / data-d / data-s from its own
// <script> tag, decides once per page view whether this view is sampled,
// and sends each final metric as one beacon. It runs once per page (a
// window flag): a page that has both the inserted tag and a manual one
// is not counted twice. Every step is guarded: it
// must never throw into the page.
export function loaderSource(sampleRate: number): string {
  const patterns = ID_PATTERNS.map((p) => `new RegExp(${JSON.stringify(p.source)},${JSON.stringify(p.flags)})`).join(
    ",",
  );
  return `(function(){try{
var w=typeof window!=="undefined"?window:null;if(w){if(w.__nboInsights)return;w.__nboInsights=1}
var s=document.currentScript,ds=(s&&s.dataset)||{};
var rate=Number(ds.s!=null&&ds.s!==""?ds.s:${Number(sampleRate)});
if(!(rate>0)||!(Math.random()*100<rate))return;
var V=typeof webVitals!=="undefined"?webVitals:null;if(!V)return;
var ids=[${patterns}];
function isId(g){for(var i=0;i<ids.length;i++)if(ids[i].test(g))return true;return false}
var segs=String(location.pathname||"/").split("/");
for(var i=0;i<segs.length;i++)if(segs[i]!==""&&isId(segs[i]))segs[i]="[id]";
var route=segs.join("/").slice(0,${MAX_ROUTE_LENGTH});
var n=navigator||{},uad=n.userAgentData,mobile;
if(uad&&typeof uad.mobile==="boolean")mobile=uad.mobile;
else mobile=/Mobi|Android|iPhone|iPod/i.test(n.userAgent||"")||(typeof innerWidth==="number"&&innerWidth>0&&innerWidth<768);
var device=mobile?"mobile":"desktop";
var url=${JSON.stringify(VITALS_PATH)};
function send(m){try{
var b={metric:m.name,value:m.value,route:route,device:device};
if(ds.e!=null)b.environmentId=ds.e;if(ds.d!=null)b.contentId=ds.d;
var body=JSON.stringify(b);
if(n.sendBeacon&&n.sendBeacon(url,body))return;
if(typeof fetch==="function")fetch(url,{method:"POST",body:body,keepalive:true,credentials:"same-origin"}).catch(function(){});
}catch(e){}}
var names=["onLCP","onINP","onCLS","onFCP","onTTFB"];
for(var k=0;k<names.length;k++){try{V[names[k]](send)}catch(e){}}
}catch(e){}})();
`;
}

// buildScript is what /_nbo/insights/v1/script.js serves: web-vitals and
// the loader inside one function, so `webVitals` never leaks to the page's
// globals.
export function buildScript(sampleRate: number): string {
  return `(function(){\n${readWebVitals()};\n${loaderSource(sampleRate)}})();\n`;
}

// scriptResponse serves the script. If web-vitals cannot be read (a broken
// install), it answers 503 no-store rather than failing the request, and
// tries again on the next one.
export function scriptResponse(sampleRate: number): Response {
  let body = cache.get(sampleRate);
  if (body === undefined) {
    try {
      body = buildScript(sampleRate);
    } catch (err) {
      console.error(`edge: speed insights script unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return new Response("", {
        status: 503,
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }
    cache.set(sampleRate, body);
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
