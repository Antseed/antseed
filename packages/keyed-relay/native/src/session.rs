//! The buyer ↔ seller session: one multiplexed byte stream carrying the TLS
//! bytes (stream `tls`) and the zero-knowledge protocol (an mpz context).

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Poll, Waker},
    time::Duration,
};

use anyhow::{Context as _, Result};
use mpz_common::{Context, Session as MpzSession, ThreadPool, ThreadPoolBuildError, io::Io, mux::Mux};
use tokio::{io::DuplexStream, task::JoinHandle};
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt};

pub type TlsStream = tlsn_mux::Stream;

struct MuxHandle(tlsn_mux::Handle);

impl Mux for MuxHandle {
    fn open(&self, id: &[u8]) -> Result<Io, std::io::Error> {
        let stream = self.0.new_stream(id).map_err(std::io::Error::other)?;
        Ok(Io::from_io(stream))
    }
}

pub struct PeerSession {
    pub ctx: Context,
    _executor: MpzSession,
    should_close: Arc<AtomicBool>,
    waker: Arc<Mutex<Option<Waker>>>,
    driver: JoinHandle<()>,
}

impl PeerSession {
    /// Opens the session; returns it with the `tls` byte stream.
    pub fn open(peer: DuplexStream) -> Result<(Self, TlsStream)> {
        let config = tlsn_mux::Config::builder()
            .keep_alive(true)
            .close_sync(true)
            .build()
            .context("mux config")?;
        let mut conn: tlsn_mux::Connection<Compat<DuplexStream>> = tlsn_mux::Connection::new(peer.compat(), config);
        let handle = conn.handle().context("mux handle")?;

        let should_close = Arc::new(AtomicBool::new(false));
        let waker: Arc<Mutex<Option<Waker>>> = Arc::new(Mutex::new(None));
        let (close_flag, close_waker) = (should_close.clone(), waker.clone());
        let driver = tokio::spawn(async move {
            let result = futures::future::poll_fn(|cx| {
                *close_waker.lock().unwrap() = Some(cx.waker().clone());
                if close_flag.load(Ordering::Acquire) {
                    conn.close();
                }
                match conn.poll(cx) {
                    Poll::Ready(result) => Poll::Ready(result),
                    Poll::Pending => Poll::Pending,
                }
            })
            .await;
            if let Err(error) = result {
                tracing::debug!("peer mux ended: {error}");
            }
        });

        match ThreadPool::builder()
            .num_threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4))
            .build_global()
        {
            Ok(()) | Err(ThreadPoolBuildError::AlreadyInitialized) => {}
            Err(error) => return Err(anyhow::anyhow!("thread pool: {error}")),
        }
        let executor = MpzSession::builder()
            .pool(ThreadPool::global())
            .build(MuxHandle(handle.clone()))
            .context("mpz session")?;
        let ctx = executor.new_context().context("mpz context")?;
        let tls = handle.new_stream(b"tls").context("tls stream")?;

        Ok((Self { ctx, _executor: executor, should_close, waker, driver }, tls))
    }

    /// Closes the mux after its buffered frames are sent, waiting a little for the peer.
    pub async fn close(self) {
        self.should_close.store(true, Ordering::Release);
        if let Some(waker) = self.waker.lock().unwrap().take() {
            waker.wake();
        }
        let _ = tokio::time::timeout(Duration::from_secs(5), self.driver).await;
    }
}

/// Stops a task that holds one of a session's streams, and returns once the task is gone. A session is
/// closed only after every such task has ended: a stream dropped on another thread while the mux closes
/// can make the mux skip a frame that is still queued, and the peer never gets the session's last message.
pub async fn stop<T>(task: JoinHandle<T>) {
    task.abort();
    let _ = task.await;
}

#[cfg(test)]
mod tests {
    use futures::{AsyncReadExt, AsyncWriteExt};
    use serio::{SinkExt, stream::IoStreamExt};

    use super::*;

    /// One session in which the seller refuses the request: it stops the two tasks that relay the TLS
    /// bytes, sends one last message and closes. Returns whether the buyer got that message.
    async fn refused_session() -> bool {
        let (a, b) = tokio::io::duplex(64 * 1024);
        let (mut seller, tls) = PeerSession::open(a).unwrap();
        let (mut buyer, _buyer_tls) = PeerSession::open(b).unwrap();
        seller.ctx.io_mut().send(1u32).await.unwrap();
        let first: u32 = buyer.ctx.io_mut().expect_next().await.unwrap();
        assert_eq!(first, 1);

        let (mut tls_read, mut tls_write) = tls.split();
        tls_write.write_all(b"handshake").await.unwrap();
        let up = tokio::spawn(async move {
            let mut buf = [0u8; 64];
            let _ = tls_read.read(&mut buf).await;
            std::future::pending::<()>().await;
        });
        let down = tokio::spawn(async move {
            let _held = tls_write;
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;

        stop(up).await;
        stop(down).await;
        seller.ctx.io_mut().send(2u32).await.unwrap();
        seller.close().await;
        let last: Result<u32, _> = buyer.ctx.io_mut().expect_next().await;
        last.ok() == Some(2)
    }

    /// The last message is the buyer's only word of why its request was refused, so it must arrive in
    /// every session. Many sessions at once, as a busy seller has them: the loss this guards against
    /// needs a stream dropped on one thread while the mux closes on another.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn the_last_message_before_a_close_arrives_when_the_relaying_tasks_were_stopped() {
        let workers: usize = std::env::var("SESSION_CLOSE_WORKERS").ok().and_then(|n| n.parse().ok()).unwrap_or(16);
        let rounds: usize = std::env::var("SESSION_CLOSE_ROUNDS").ok().and_then(|n| n.parse().ok()).unwrap_or(20_000);
        let runs = (0..workers).map(|_| {
            tokio::spawn(async move {
                let mut lost = 0usize;
                for _ in 0..rounds {
                    if !refused_session().await {
                        lost += 1;
                    }
                }
                lost
            })
        });
        let mut lost = 0usize;
        for run in runs.collect::<Vec<_>>() {
            lost += run.await.unwrap();
        }
        assert_eq!(lost, 0, "the last message was lost in {lost} of {} sessions", workers * rounds);
    }
}
