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
mod tag;
mod zk;

use std::io::Write;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(std::env::var("ANTSEED_KEYED_RELAY_LOG").unwrap_or_else(|_| "warn".into()))
        .init();
    let role = std::env::args().nth(1);
    let (result, output) = match role.as_deref() {
        Some("buyer") => {
            let (stdio, output) = frames::start();
            (buyer::run(stdio).await, output)
        }
        Some("seller") => {
            let (stdio, output) = frames::start();
            (seller::run(stdio).await, output)
        }
        Some("--version") => {
            println!("antseed-keyed-relay {} protocol {}", env!("CARGO_PKG_VERSION"), msg::PROTOCOL_VERSION);
            return;
        }
        _ => {
            eprintln!("usage: antseed-keyed-relay buyer|seller|--version");
            std::process::exit(2);
        }
    };
    // The error goes to stderr for Node; stdout carries only frames.
    if let Err(error) = &result {
        let _ = writeln!(std::io::stderr(), "antseed-keyed-relay: {error:#}");
    }
    // Every frame queued so far reaches Node before the exit: after an error too, a
    // seller's last event says what it relayed.
    output.wait().await;
    // Exit explicitly: the runtime would otherwise wait on the blocking stdin read.
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}
