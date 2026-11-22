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
