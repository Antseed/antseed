//! Buyer side: runs the TLS client through the relay, proves the session keys
//! so the seller can add its record, then carries the plaintext HTTP bytes
//! that follow the seller's head. Once the request is written it reveals the
//! request ranges Node picks, which the seller checks before it forwards the
//! request; after the response, the response ranges Node picks.

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use anyhow::{Context as _, Result, anyhow, bail};
use futures::{AsyncReadExt, AsyncWriteExt};
use mpz_vm_core::Execute;
use rustls::{
    ClientConfig, ClientConnection, ConnectionTrafficSecrets, KeyLog, NamedGroup, RootCertStore, SupportedCipherSuite,
    client::Resumption, crypto::CryptoProvider,
};
use rustls_pki_types::ServerName;
use serde_json::json;
use serde_json::Value;
use serio::{SinkExt, stream::IoStreamExt};
use tlsn_core::transcript::TlsTranscript;
use tokio::sync::{mpsc, watch};

use crate::{
    frames,
    msg::{Done, Hello, Injected, PROTOCOL_VERSION, RequestReveal, RequestVerdict, RevealRequest},
    ranges::{self, Triple},
    records::{ALERT, ALLOWED_SUITES, APPLICATION_DATA, Direction, MAX_PLAINTEXT, RecordParser},
    session::{PeerSession, TlsStream},
    zk::{INJECTED_SEQ, KeyProof, RecordRange, Side, prover_vm},
};

/// How long Node may take to write the whole request.
const REQUEST_WRITE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Waits for the ctl message of `kind`, skipping others.
async fn expect_ctl(ctl: &mut mpsc::UnboundedReceiver<Value>, kind: &str) -> Result<Value> {
    loop {
        let message = ctl.recv().await.ok_or_else(|| anyhow!("no {kind} message"))?;
        if message["type"] == kind {
            return Ok(message);
        }
    }
}

/// Node's `[[start, length], ...]` in a stream of `log`'s records, split at record boundaries.
fn split_ranges(message: &Value, log: &[([u8; 8], usize)]) -> Result<(Vec<Triple>, Vec<RecordRange>)> {
    let mut triples = Vec::new();
    let mut ranges = Vec::new();
    for pair in message["ranges"].as_array().cloned().unwrap_or_default() {
        let start = pair[0].as_u64().ok_or_else(|| anyhow!("bad reveal range"))? as usize;
        let len = pair[1].as_u64().ok_or_else(|| anyhow!("bad reveal range"))? as usize;
        for (triple, range) in ranges::split(log, start, len)? {
            triples.push(triple);
            ranges.push(range);
        }
    }
    Ok((triples, ranges))
}

#[derive(Debug, Default)]
struct MasterSecretLog(Mutex<Vec<u8>>);

impl KeyLog for MasterSecretLog {
    fn log(&self, label: &str, _client_random: &[u8], secret: &[u8]) {
        if label == "CLIENT_RANDOM" {
            *self.0.lock().unwrap() = secret.to_vec();
        }
    }
}

fn client_config(key_log: Arc<MasterSecretLog>, extra_roots_pem: Option<&str>) -> Result<ClientConfig> {
    let provider = rustls::crypto::ring::default_provider();
    let provider = CryptoProvider {
        kx_groups: provider.kx_groups.iter().filter(|g| g.name() == NamedGroup::secp256r1).copied().collect(),
        cipher_suites: provider
            .cipher_suites
            .iter()
            .filter(|s| matches!(s, SupportedCipherSuite::Tls12(t) if ALLOWED_SUITES.contains(&u16::from(t.common.suite))))
            .copied()
            .collect(),
        ..provider
    };
    let mut roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Some(pem) = extra_roots_pem {
        use rustls_pki_types::{CertificateDer, pem::PemObject};
        roots.add(CertificateDer::from_pem_slice(pem.as_bytes()).map_err(|_| anyhow!("extraRootsPem is not a PEM certificate"))?)?;
    }
    let mut config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS12])?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config.key_log = key_log;
    config.resumption = Resumption::disabled();
    config.enable_secret_extraction = true;
    Ok(config)
}

struct Handshake {
    ms: [u8; 48],
    tx: Direction,
    rx: Direction,
    sent: Vec<u8>,
    recv: Vec<u8>,
}

fn direction(secrets: (u64, ConnectionTrafficSecrets)) -> Result<Direction> {
    match secrets.1 {
        ConnectionTrafficSecrets::Aes128Gcm { key, iv } => Direction::new(key.as_ref(), iv.as_ref(), secrets.0),
        _ => bail!("the session did not use AES-128-GCM"),
    }
}

async fn handshake(tls: &mut TlsStream, server_name: &str, extra_roots_pem: Option<&str>) -> Result<Handshake> {
    let ms_log = Arc::new(MasterSecretLog::default());
    let config = client_config(ms_log.clone(), extra_roots_pem)?;
    let name = ServerName::try_from(server_name.to_string()).context("server name")?;
    let mut conn = ClientConnection::new(Arc::new(config), name)?;
    let (mut sent, mut recv) = (Vec::new(), Vec::new());
    let mut buf = vec![0u8; 32 * 1024];
    while conn.is_handshaking() {
        while conn.wants_write() {
            let mut out = Vec::new();
            conn.write_tls(&mut out)?;
            sent.extend_from_slice(&out);
            tls.write_all(&out).await?;
        }
        tls.flush().await?;
        if !conn.is_handshaking() {
            break;
        }
        let n = tls.read(&mut buf).await?;
        if n == 0 {
            bail!("the relay closed during the TLS handshake");
        }
        recv.extend_from_slice(&buf[..n]);
        let mut slice = &buf[..n];
        while !slice.is_empty() {
            conn.read_tls(&mut slice)?;
            conn.process_new_packets()?;
        }
    }
    if conn.wants_write() {
        bail!("the TLS client has bytes left after the handshake");
    }
    let ms: [u8; 48] = ms_log.0.lock().unwrap().clone().try_into().map_err(|_| anyhow!("no master secret logged"))?;
    let secrets = conn.dangerous_extract_secrets()?;
    Ok(Handshake { ms, tx: direction(secrets.tx)?, rx: direction(secrets.rx)?, sent, recv })
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub async fn run() -> Result<()> {
    let frames::Stdio { mut ctl, mut app, out, peer } = frames::start();
    let start = ctl.recv().await.ok_or_else(|| anyhow!("no start message"))?;
    let server_name = start["serverName"].as_str().ok_or_else(|| anyhow!("serverName missing"))?.to_string();
    // Tests only: an extra trusted root (PEM).
    let extra_roots = start["extraRootsPem"].as_str().map(str::to_string);

    let (mut session, mut tls) = PeerSession::open(peer)?;
    let hello: Hello = session.ctx.io_mut().expect_next().await.context("seller hello")?;
    if hello.version != PROTOCOL_VERSION {
        bail!("seller speaks keyed-relay protocol {}, this buyer {}", hello.version, PROTOCOL_VERSION);
    }
    if hello.injected_len == 0 || hello.injected_len > 8192 {
        bail!("seller record length {} is out of range", hello.injected_len);
    }

    let mut vm = prover_vm();
    let mut proof = KeyProof::alloc(&mut vm, true, hello.injected_len as usize)?;
    vm.flush(&mut session.ctx).await.context("preprocessing")?;

    let Handshake { ms, mut tx, mut rx, sent, recv } = handshake(&mut tls, &server_name, extra_roots.as_deref()).await?;
    let transcript = TlsTranscript::builder().time(now()).tls_sent(&sent).tls_recv(&recv).build()?;
    proof.prove(&mut vm, &mut session.ctx, Some(ms), &transcript).await.context("key proof")?;

    let injected: Injected = session.ctx.io_mut().expect_next().await.context("seller injection")?;
    if injected.seq != INJECTED_SEQ || tx.seq != INJECTED_SEQ {
        bail!("unexpected record sequence (seller {}, client {})", injected.seq, tx.seq);
    }
    // The seller's record took sequence 1.
    tx.seq += 1;
    out.ctl(json!({ "type": "ready" }));

    let (mut tls_read, mut tls_write) = tls.split();
    // (explicit nonce, plaintext length) of each request record this side sealed, in order.
    let client_records: Arc<Mutex<Vec<([u8; 8], usize)>>> = Arc::default();
    // The request's length once Node names it: the writer seals nothing past it.
    let limit = Arc::new(AtomicUsize::new(usize::MAX));
    let (written_tx, mut written) = watch::channel(0usize);
    let writer_records = client_records.clone();
    let writer_limit = limit.clone();
    let writer = tokio::spawn(async move {
        let mut total = 0usize;
        while let Some(data) = app.recv().await {
            if data.is_empty() {
                break;
            }
            if total + data.len() > writer_limit.load(Ordering::SeqCst) {
                bail!("Node wrote more than the request it revealed");
            }
            for chunk in data.chunks(MAX_PLAINTEXT) {
                let nonce = tx.seq.to_be_bytes();
                let record = tx.seal(APPLICATION_DATA, chunk)?;
                writer_records.lock().unwrap().push((nonce, chunk.len()));
                tls_write.write_all(&record).await?;
            }
            tls_write.flush().await?;
            total += data.len();
            let _ = written_tx.send(total);
        }
        Ok::<_, anyhow::Error>(tls_write)
    });

    // Node names the request's length and the ranges to reveal once it wrote
    // all of it; the seller checks them before the upstream sees any of it.
    let message = expect_ctl(&mut ctl, "request").await?;
    let length = message["length"].as_u64().ok_or_else(|| anyhow!("request length missing"))? as usize;
    limit.store(length, Ordering::SeqCst);
    tokio::time::timeout(REQUEST_WRITE_TIMEOUT, written.wait_for(|n| *n >= length))
        .await
        .map_err(|_| anyhow!("the request was not written in time"))?
        .map_err(|_| anyhow!("the request writer stopped"))?;
    if *written.borrow() != length {
        bail!("Node wrote {} request bytes, not {length}", *written.borrow());
    }
    let (triples, request_ranges) = {
        let log = client_records.lock().unwrap();
        split_ranges(&message, &log)?
    };
    if triples.is_empty() {
        bail!("no request range to reveal");
    }
    session.ctx.io_mut().send(RequestReveal { length: length as u64, ranges: triples }).await?;
    proof.reveal(&mut vm, &mut session.ctx, Side::Client, &request_ranges).await.context("request reveal")?;
    let verdict: RequestVerdict = session.ctx.io_mut().expect_next().await.context("seller verdict")?;
    if !verdict.admitted {
        bail!("the seller refused the request: {}", verdict.reason);
    }
    out.ctl(json!({ "type": "admitted" }));

    // (explicit nonce, plaintext length) of each server application-data record, in order.
    let mut server_records: Vec<([u8; 8], usize)> = Vec::new();
    let mut parser = RecordParser::default();
    let mut buf = vec![0u8; 32 * 1024];
    let mut length = 0usize;
    'read: loop {
        let n = tls_read.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        for record in parser.push(&buf[..n])? {
            match record.typ {
                APPLICATION_DATA => {
                    let plaintext = rx.open(&record)?;
                    server_records.push((record.body[..8].try_into().unwrap(), plaintext.len()));
                    length += plaintext.len();
                    out.app(plaintext);
                }
                ALERT => {
                    let alert = rx.open(&record)?;
                    if alert.get(1) == Some(&0) {
                        break 'read;
                    }
                    bail!("the upstream sent TLS alert {:?}", alert);
                }
                other => bail!("unexpected TLS record type {other} after the handshake"),
            }
        }
    }
    writer.abort();
    out.app(Vec::new());
    out.ctl(json!({ "type": "responseEnd", "length": length }));

    // Node answers with the response ranges to reveal for billing (offsets in the response bytes).
    let message = expect_ctl(&mut ctl, "reveal").await?;
    let (triples, response_ranges) = split_ranges(&message, &server_records)?;
    session.ctx.io_mut().send(RevealRequest { ranges: triples }).await?;
    proof.reveal(&mut vm, &mut session.ctx, Side::Server, &response_ranges).await.context("reveal")?;
    let _: Done = session.ctx.io_mut().expect_next().await.context("seller done")?;
    out.ctl(json!({ "type": "done" }));
    session.close().await;
    Ok(())
}
