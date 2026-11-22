//! Framing between the sidecar and the Node process that spawned it.
//!
//! Both directions carry frames of `[channel u8][length u32 BE][payload]` on
//! stdin/stdout:
//! - `CTL` (0): one JSON object per frame (configuration in, events out);
//! - `PEER` (1): the byte stream to the other side's sidecar, carried by the
//!   Antseed relay stream; an empty frame ends it;
//! - `APP` (2): buyer only, the plaintext HTTP bytes after the seller's head
//!   (request in, response out); an empty frame ends that direction.

use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
    sync::mpsc,
};

pub const CTL: u8 = 0;
pub const PEER: u8 = 1;
pub const APP: u8 = 2;

/// Largest frame either side accepts.
const MAX_FRAME: usize = 1 << 20;

/// Sends frames to Node.
#[derive(Clone)]
pub struct Out(mpsc::UnboundedSender<(u8, Vec<u8>)>);

impl Out {
    pub fn ctl(&self, value: Value) {
        let _ = self.0.send((CTL, value.to_string().into_bytes()));
    }

    pub fn app(&self, data: Vec<u8>) {
        let _ = self.0.send((APP, data));
    }
}

pub struct Stdio {
    pub ctl: mpsc::UnboundedReceiver<Value>,
    pub app: mpsc::UnboundedReceiver<Vec<u8>>,
    pub out: Out,
    /// The sidecar's end of the peer byte stream.
    pub peer: DuplexStream,
}

pub fn start() -> Stdio {
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some((channel, data)) = out_rx.recv().await {
            let mut header = [0u8; 5];
            header[0] = channel;
            header[1..].copy_from_slice(&(data.len() as u32).to_be_bytes());
            if stdout.write_all(&header).await.is_err()
                || stdout.write_all(&data).await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });
    let out = Out(out_tx);

    let (inner, outer) = tokio::io::duplex(1 << 20);
    let (mut peer_read, mut peer_write) = tokio::io::split(outer);

    // Bytes the mux writes go to Node, in frames of at most 64 KiB.
    let peer_out = out.0.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match peer_read.read(&mut buf).await {
                Ok(0) | Err(_) => {
                    let _ = peer_out.send((PEER, Vec::new()));
                    break;
                }
                Ok(n) => {
                    if peer_out.send((PEER, buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
    let (app_tx, app_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut stdin = tokio::io::stdin();
        loop {
            let mut header = [0u8; 5];
            if stdin.read_exact(&mut header).await.is_err() {
                break;
            }
            let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
            if len > MAX_FRAME {
                break;
            }
            let mut payload = vec![0u8; len];
            if stdin.read_exact(&mut payload).await.is_err() {
                break;
            }
            match header[0] {
                CTL => match serde_json::from_slice::<Value>(&payload) {
                    Ok(value) => {
                        let _ = ctl_tx.send(value);
                    }
                    Err(_) => break,
                },
                PEER => {
                    if payload.is_empty() {
                        let _ = peer_write.shutdown().await;
                    } else if peer_write.write_all(&payload).await.is_err() {
                        break;
                    }
                }
                APP => {
                    let _ = app_tx.send(payload);
                }
                _ => break,
            }
        }
        // Node went away: closing the channels ends the session.
    });

    Stdio { ctl: ctl_rx, app: app_rx, out, peer: inner }
}
