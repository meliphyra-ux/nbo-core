// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

//! NBO's edge: the reverse proxy every visitor request passes through.
//! A port of the TypeScript edge (`packages/edge`), held to the same
//! contract by its black-box suite and by golden vectors generated from
//! the TypeScript functions (`tests/golden`). See ADR 0005.

pub mod admin;
pub mod certs;
pub mod cloudflare;
pub mod cluster;
pub mod config;
pub mod insights;
pub mod jsmath;
pub mod kube_source;
pub mod navigation;
pub mod proxy;
pub mod registry;
pub mod relay;
pub mod route_table;
pub mod server;
pub mod sticky;
pub mod text;
