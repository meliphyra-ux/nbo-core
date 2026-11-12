// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export interface Prerender {
    $schema?:    string;
    prerenders?: PrerenderConfig[];
    version:     number;
}

export interface PrerenderConfig {
    allowQuery?:   string[];
    bypassToken:   BypassToken;
    expireSec:     number;
    function:      string;
    id:            string;
    match:         string;
    onMiss:        OnMiss;
    revalidateSec: number;
    seeds?:        { [key: string]: Seed };
    tags?:         string[];
    varyHeaders?:  string[];
    "x-nbo-ppr"?:  XNboPpr;
}

export interface BypassToken {
    env: string;
}

export type OnMiss = "blocking" | "shell" | "notFound";

export interface Seed {
    file: string;
}

export interface XNboPpr {
    postponedState: string;
}
