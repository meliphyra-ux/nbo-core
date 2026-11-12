// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export interface Function {
    $schema?:    string;
    artifact:    Artifact;
    concurrency: Concurrency;
    handler:     Handler;
    name:        string;
    requires?:   Require[];
    resources?:  Resources;
    runtime:     Runtime;
}

export interface Artifact {
    digest: string;
    files:  string;
    path:   string;
    type:   ArtifactType;
}

export type ArtifactType = "bundle";

export type Concurrency = "multi";

export interface Handler {
    entry:  string;
    export: string;
    style:  Style;
}

export type Style = "fetch";

export type Require = "fn.streaming" | "fn.edge" | "fn.waitUntil" | "fn.arm64" | "prerender.isr" | "prerender.onDemand" | "images.optimize" | "geo.headers";

export interface Resources {
    maxDurationSec?:   number;
    maxRequestBodyMb?: number;
    memoryMb?:         number;
}

export interface Runtime {
    kind:     Kind;
    version?: string;
}

export type Kind = "node";
