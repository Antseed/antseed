//! Framing between the sidecar and the Node process that spawned it.
//!
//! Both directions carry frames of `[channel u8][length u32 BE][payload]` on
//! stdin/stdout:
//! - `CTL` (0): one JSON object per frame (configuration in, events out);
//! - `PEER` (1): the byte stream to the other side's sidecar, carried by the
//!   Antseed relay stream; an empty frame ends it;
//! - `APP` (2): buyer only, the plaintext HTTP bytes after the seller's head
//!   (request in, response out); an empty frame ends that direction.

use std::time::Duration;

use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

pub const CTL: u8 = 0;
pub const PEER: u8 = 1;
pub const APP: u8 = 2;

/// Largest frame either side accepts.
const MAX_FRAME: usize = 1 << 20;

/// How long the mux's last bytes get to leave it before the process exits. After a closed
/// session its stream has ended and nothing waits; after an error it may never end.
const PEER_GRACE: Duration = Duration::from_millis(50);

/// How long a parent that reads nothing holds up the exit.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

/// What waits for stdout: a frame, or the mark `Finish` waits on.
enum Queued {
    Frame(u8, Vec<u8>),
    /// Answered once every frame queued before it has been written.
    Written(oneshot::Sender<()>),
}

/// Sends frames to Node.
#[derive(Clone)]
pub struct Out(mpsc::UnboundedSender<Queued>);

impl Out {
    pub fn ctl(&self, value: Value) {
        let _ = self.0.send(Queued::Frame(CTL, value.to_string().into_bytes()));
    }

    pub fn app(&self, data: Vec<u8>) {
        let _ = self.0.send(Queued::Frame(APP, data));
    }
}

/// The end of the process's output: `main` waits on it before it exits, so the frames a
/// role queued (a seller's `responseEnd` with what it relayed) are not lost with the process.
pub struct Finish {
    out: Out,
    peer: JoinHandle<()>,
}

impl Finish {
    pub async fn wait(self) {
        self.wait_within(DRAIN_TIMEOUT).await;
    }

    /// Returns when every frame queued so far has been written, when stdout has failed
    /// (the parent is gone), or after `limit` with a parent that reads nothing.
    async fn wait_within(mut self, limit: Duration) {
        let _ = tokio::time::timeout(PEER_GRACE, &mut self.peer).await;
        let (written, done) = oneshot::channel();
        if self.out.0.send(Queued::Written(written)).is_ok() {
            let _ = tokio::time::timeout(limit, done).await;
        }
    }
}

pub struct Stdio {
    pub ctl: mpsc::UnboundedReceiver<Value>,
    pub app: mpsc::UnboundedReceiver<Vec<u8>>,
    pub out: Out,
    /// The sidecar's end of the peer byte stream.
    pub peer: DuplexStream,
}

pub fn start() -> (Stdio, Finish) {
    start_on(tokio::io::stdin(), tokio::io::stdout())
}

fn start_on(
    mut stdin: impl AsyncRead + Unpin + Send + 'static,
    mut stdout: impl AsyncWrite + Unpin + Send + 'static,
) -> (Stdio, Finish) {
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Queued>();
    tokio::spawn(async move {
        while let Some(queued) = out_rx.recv().await {
            let (channel, data) = match queued {
                Queued::Frame(channel, data) => (channel, data),
                Queued::Written(written) => {
                    let _ = written.send(());
                    continue;
                }
            };
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
    let peer_done = tokio::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match peer_read.read(&mut buf).await {
                Ok(0) | Err(_) => {
                    let _ = peer_out.send(Queued::Frame(PEER, Vec::new()));
                    break;
                }
                Ok(n) => {
                    if peer_out.send(Queued::Frame(PEER, buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
    let (app_tx, app_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
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

    let finish = Finish { out: out.clone(), peer: peer_done };
    (Stdio { ctl: ctl_rx, app: app_rx, out, peer: inner }, finish)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// A sidecar's framing on in-memory pipes: `stdout` holds `pipe` bytes until they are read.
    fn framing(pipe: usize) -> (Stdio, Finish, DuplexStream, DuplexStream) {
        let (stdin, stdin_far) = tokio::io::duplex(1024);
        let (stdout, stdout_far) = tokio::io::duplex(pipe);
        let (stdio, finish) = start_on(stdin, stdout);
        (stdio, finish, stdin_far, stdout_far)
    }

    #[tokio::test]
    async fn the_wait_ends_only_after_every_queued_frame_was_written() {
        let (stdio, finish, _stdin, mut stdout) = framing(1024);
        // Far more than the pipe holds, then the event a seller ends with.
        for _ in 0..64 {
            stdio.out.app(vec![7u8; 4096]);
        }
        stdio.out.ctl(serde_json::json!({ "type": "responseEnd" }));
        drop(stdio);

        // The parent reads nothing for longer than the old fixed delay before the exit.
        let waited = tokio::spawn(finish.wait());
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waited.is_finished(), "the wait ended with frames still unwritten");

        let mut read = Vec::new();
        let reader = tokio::spawn(async move {
            let _ = stdout.read_to_end(&mut read).await;
            read
        });
        waited.await.unwrap();
        // Every task that held the writer's queue has ended with the wait, so stdout closes.
        let read = reader.await.unwrap();
        // The dropped session ended the peer stream, which is the frame after the event.
        let last = br#"{"type":"responseEnd"}"#;
        let end_of_peer = [PEER, 0, 0, 0, 0];
        assert_eq!(read.len(), 64 * (5 + 4096) + 5 + last.len() + end_of_peer.len(), "frames are missing from the output");
        assert!(read.ends_with(&end_of_peer), "the output does not end with the end of the peer stream");
        assert!(read[..read.len() - end_of_peer.len()].ends_with(last), "the seller's last event is not in the output");
    }

    #[tokio::test]
    async fn a_parent_that_is_gone_does_not_hold_up_the_exit() {
        let (stdio, finish, _stdin, stdout) = framing(1024);
        drop(stdout);
        for _ in 0..8 {
            stdio.out.app(vec![7u8; 4096]);
        }
        let started = Instant::now();
        finish.wait().await;
        assert!(started.elapsed() < Duration::from_secs(2), "the wait ran {:?} with stdout closed", started.elapsed());
    }

    #[tokio::test]
    async fn a_parent_that_reads_nothing_holds_up_the_exit_only_for_the_limit() {
        let (stdio, finish, _stdin, _stdout) = framing(1024);
        for _ in 0..8 {
            stdio.out.app(vec![7u8; 4096]);
        }
        let started = Instant::now();
        finish.wait_within(Duration::from_millis(200)).await;
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(200) && took < Duration::from_secs(2), "the wait ran {took:?}; its limit is 200 ms");
    }
}
