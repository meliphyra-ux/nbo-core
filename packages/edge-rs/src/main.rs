// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// The nbo-edge binary: dev mode (the data plane and the admin API on
// NBO_EDGE_ADDR / NBO_EDGE_ADMIN_ADDR), cluster mode (NBO_EDGE_SOURCE=
// kubernetes) and relay mode (NBO_EDGE_MODE=relay).
use std::process::ExitCode;
use std::sync::Arc;

use nbo_edge::config::{self, Env, Mode};
use nbo_edge::insights::aggregator::Aggregator;
use nbo_edge::proxy::{Clients, ProxyOptions};
use nbo_edge::{cluster, relay, server};

fn main() -> ExitCode {
    let env = Env::from_process();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("edge: {err}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(env)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

async fn run(env: Env) -> Result<(), String> {
    server::set_conn_limits(config::conn_limits(&env));
    match config::resolve_mode(&env)? {
        Mode::Dev => {
            let addrs = config::resolve_dev_addrs(&env)?;
            let clients = Clients::new(config::header_timeout(&env))?;
            let options = ProxyOptions {
                clients: Arc::new(clients),
                scheme: None,
                insights: Arc::new(Aggregator::default()),
            };
            server::run_dev(addrs, options)
                .await
                .map_err(|err| format!("edge: {err}"))
        }
        Mode::Cluster {
            namespace,
            drain_token,
        } => cluster::run(&env, namespace, drain_token).await,
        Mode::Relay { token } => relay::run(&env, token).await,
    }
}
