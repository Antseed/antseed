//! `antseed-keyed-relay buyer|seller`: the sidecar behind the seller-keyed
//! blind relay. Node spawns it per relayed request and talks to it over
//! framed stdin/stdout (see `frames`).

mod buyer;
mod frames;
mod msg;
mod ranges;
mod records;
mod seller;
mod session;
mod zk;

use std::io::Write;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(std::env::var("ANTSEED_KEYED_RELAY_LOG").unwrap_or_else(|_| "warn".into()))
        .init();
    let role = std::env::args().nth(1);
    let result = match role.as_deref() {
        Some("buyer") => buyer::run().await,
        Some("seller") => seller::run().await,
        Some("--version") => {
            println!("antseed-keyed-relay {} protocol {}", env!("CARGO_PKG_VERSION"), msg::PROTOCOL_VERSION);
            return;
        }
        _ => {
            eprintln!("usage: antseed-keyed-relay buyer|seller|--version");
            std::process::exit(2);
        }
    };
    // Exit explicitly: the runtime would otherwise wait on the blocking stdin read.
    match result {
        Ok(()) => {
            // Give the stdout writer a moment to flush the last frames.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            std::process::exit(0);
        }
        Err(error) => {
            // The error goes to stderr for Node; stdout carries only frames.
            let _ = writeln!(std::io::stderr(), "antseed-keyed-relay: {error:#}");
            // The frames before the error (what a seller relayed) still reach Node.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            std::process::exit(1);
        }
    }
}
