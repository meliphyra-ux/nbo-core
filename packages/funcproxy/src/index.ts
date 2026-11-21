// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export type { FetchHandler, Resolver } from "./proxy.js";
export { proxyRequest, hostScriptPath } from "./proxy.js";
export { createStaticURLs } from "./static-urls.js";
export { createLocalSpawner } from "./local-spawner.js";
export type { IdentityTokenFetcher } from "./cloudrun.js";
export { createCloudRunURLs, metadataServerIdentityToken, cloudRunConfig, metadataServerConfig } from "./cloudrun.js";
export { createLambdaURLs } from "./lambda.js";
