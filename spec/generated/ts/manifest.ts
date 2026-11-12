// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export interface Manifest {
    $schema?:    string;
    bindings?:   Binding[];
    build:       Build;
    crons?:      Cron[];
    digests:     { [key: string]: string };
    env?:        Env;
    functions:   string[];
    images?:     Images;
    requires:    Requires;
    routing?:    Routing;
    specVersion: string;
}

export interface Binding {
    name: string;
    type: Type;
}

export type Type = "postgres" | "s3" | "redis" | "cache";

export interface Build {
    createdAt: Date;
    framework: Framework;
    id:        string;
    source?:   Source;
}

export interface Framework {
    adapter?: string;
    name:     string;
    version?: string;
}

export interface Source {
    repo:     string;
    revision: string;
}

export interface Cron {
    id:          string;
    overlap?:    Overlap;
    schedule:    string;
    target:      Target;
    timeoutSec?: number;
    timezone?:   Timezone;
}

export type Overlap = "skip" | "allow";

export interface Target {
    function: string;
    method:   Method;
    path:     string;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Timezone = "UTC";

export interface Env {
    inlinedAtBuild?:   string[];
    inlinedEnvDigest?: string;
    optional?:         string[];
    required?:         string[];
}

export interface Images {
    allowSvg?:           boolean;
    formats?:            string[];
    localPatterns?:      LocalPattern[];
    minimumCacheTTLSec?: number;
    qualities?:          number[];
    remotePatterns?:     RemotePattern[];
    widths?:             number[];
}

export interface LocalPattern {
    pathname?: string;
}

export interface RemotePattern {
    hostname?: string;
    pathname?: string;
    protocol?: string;
}

export interface Requires {
    capabilities: Capability[];
    extensions:   Extension[];
}

export type Capability = "fn.streaming" | "fn.edge" | "fn.waitUntil" | "fn.arm64" | "prerender.isr" | "prerender.onDemand" | "images.optimize" | "geo.headers";

export interface Extension {
    critical: boolean;
    id:       string;
    version:  string;
}

export interface Routing {
    caseSensitive?: boolean;
    cleanUrls?:     boolean;
    trailingSlash?: TrailingSlash;
}

export type TrailingSlash = "never" | "always" | "preserve";
