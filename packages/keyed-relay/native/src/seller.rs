//! Seller side: relays the buyer's TLS bytes to the upstream, checks the
//! handshake it saw (certificate, signature, cipher suite, ALPN), verifies the
//! buyer's key proof and writes its own record (the request head with the
//! credential) as sequence 1. It then holds the buyer's request until the
//! buyer has revealed the parts Node checks (its headers and the body's fixed
//! tail) and Node admits it, relays ciphertext both ways and, at the end,
//! decrypts only the response ranges the buyer reveals.

use std::{sync::Arc, time::Duration};

use anyhow::{Context as _, Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use futures::{AsyncReadExt, AsyncWriteExt};
use mpz_vm_core::Execute;
use serde_json::json;
use serio::{SinkExt, stream::IoStreamExt};
use tlsn_core::{
    connection::{DnsName, HandshakeData, ServerName},
    transcript::TlsTranscript,
    webpki::{CertificateDer, RootCertStore, ServerCertVerifier},
};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::TcpStream,
    sync::{Mutex, oneshot, watch},
};

use crate::{
    frames,
    msg::{Done, Hello, Injected, PROTOCOL_VERSION, RequestReveal, RequestVerdict, RevealRequest, TagAnswer, TagOffer},
    ranges::{self, Placed, RECORD_OVERHEAD},
    records::{ALERT, ALLOWED_SUITES, APPLICATION_DATA, CHANGE_CIPHER_SPEC, HANDSHAKE, Record, RecordParser, SellerRecord, server_hello},
    session::PeerSession,
    zk::{INJECTED_SEQ, KeyProof, Side, verifier_vm},
};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
/// How long the buyer may take to send and reveal its whole request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long Node may take to admit or refuse the request.
const ADMIT_TIMEOUT: Duration = Duration::from_secs(60);
/// How long the upstream may take to end its answer, unless Node sets another limit.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const REVEAL_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the buyer may take over one step of a proof, unless Node sets another limit.
const PROOF_TIMEOUT: Duration = Duration::from_secs(120);
/// The longest request head the seller writes.
const MAX_HEAD: usize = 8192;
/// The longest request the seller holds, unless Node sets another limit.
const DEFAULT_MAX_REQUEST: usize = 32 << 20;
/// The longest answer the seller keeps, unless Node sets another limit.
const DEFAULT_MAX_RESPONSE: usize = 64 << 20;
/// What keeping a record costs beyond its bytes: an upstream may send its answer in tiny records.
const RECORD_COST: usize = 64;
/// The most bytes of one side's handshake the seller keeps.
const MAX_HANDSHAKE: usize = 256 * 1024;
/// An encrypted alert: its two bytes and the record's nonce and tag.
const ALERT_BODY: usize = RECORD_OVERHEAD + 2;
/// The most alerts a buyer sends after its request: a warning and its close_notify.
const MAX_ALERTS: usize = 2;

/// The most application-data records the seller holds for a request of up to `max_request` bytes. A
/// buyer fills its records, so this is far above what a request needs, and it bounds what tiny
/// records cost in memory beyond the request's own bytes.
fn max_request_records(max_request: usize) -> usize {
    64 + max_request / 4096
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Tracks one direction's handshake: its bytes up to and including its Finished record.
#[derive(Default)]
struct HandshakeSide {
    bytes: Vec<u8>,
    records: Vec<Record>,
    seen_ccs: bool,
    finished: bool,
}

impl HandshakeSide {
    /// Takes one record during the handshake; true once this record was the Finished.
    fn take(&mut self, record: &Record) -> Result<bool> {
        if self.bytes.len() + 5 + record.body.len() > MAX_HANDSHAKE {
            bail!("the handshake is longer than {MAX_HANDSHAKE} bytes");
        }
        record.append_wire(&mut self.bytes);
        self.records.push(record.clone());
        if record.typ == CHANGE_CIPHER_SPEC {
            self.seen_ccs = true;
        } else if record.typ == HANDSHAKE && self.seen_ccs {
            self.finished = true;
        }
        Ok(self.finished)
    }
}

fn cert_verifier(extra_roots_pem: Option<&str>) -> Result<ServerCertVerifier> {
    let mut roots = RootCertStore::mozilla();
    if let Some(pem) = extra_roots_pem {
        roots.roots.push(CertificateDer::from_pem_slice(pem.as_bytes()).map_err(|_| anyhow!("extraRootsPem is not a PEM certificate"))?);
    }
    ServerCertVerifier::new(&roots).map_err(|error| anyhow!("certificate verifier: {error}"))
}

fn raw(record: &Record) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + record.body.len());
    record.append_wire(&mut out);
    out
}

/// What happens to the buyer's records after the seller's.
#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum Gate {
    /// Held: nothing of the request reaches the upstream before Node admits it.
    #[default]
    Hold,
    /// The request is complete and under Node's check: only alerts may follow it, and they are held too.
    Sealed,
    /// Admitted and forwarded: only alerts may follow.
    Open,
    /// Refused, or the buyer sent more than its request: nothing is forwarded.
    Shut,
}

/// The buyer's records after the seller's, on their way to the upstream.
#[derive(Default)]
struct RequestGate {
    gate: Gate,
    /// Held until the gate opens.
    held: Vec<Record>,
    /// Plaintext bytes of the held application-data records: the request so far.
    request_len: usize,
    /// Application-data records of the request so far.
    request_records: usize,
    /// Alerts taken so far, held or forwarded.
    alerts: usize,
}

impl RequestGate {
    /// Takes one record (application data or an alert). `Some` is forwarded now; the rest is held or
    /// dropped. A record the buyer may not send shuts the gate: nothing of the session goes upstream.
    fn take(&mut self, record: Record, max_request: usize) -> Result<Option<Record>> {
        let taken = self.check(record, max_request);
        if taken.is_err() {
            self.shut();
        }
        taken
    }

    fn check(&mut self, record: Record, max_request: usize) -> Result<Option<Record>> {
        if self.gate == Gate::Shut {
            return Ok(None);
        }
        // What is held is bounded in bytes and in records, whatever the buyer sends.
        if record.typ == ALERT {
            self.alerts += 1;
            if record.body.len() != ALERT_BODY || self.alerts > MAX_ALERTS {
                bail!("the buyer sent a malformed alert or more than {MAX_ALERTS} alerts");
            }
        }
        match self.gate {
            Gate::Hold => {
                if record.typ == APPLICATION_DATA {
                    // A buyer never seals an empty record: one would be held at no cost to its request's length.
                    if record.body.len() <= RECORD_OVERHEAD {
                        bail!("the buyer sent a record with no request bytes");
                    }
                    self.request_len += record.body.len() - RECORD_OVERHEAD;
                    self.request_records += 1;
                    if self.request_len > max_request {
                        bail!("the request is longer than {max_request} bytes");
                    }
                    if self.request_records > max_request_records(max_request) {
                        bail!("the request came in more than {} records", max_request_records(max_request));
                    }
                }
                self.held.push(record);
                Ok(None)
            }
            // The request is what Node checks, or went out as admitted: nothing may follow it but alerts.
            Gate::Sealed | Gate::Open if record.typ != ALERT => {
                bail!("the buyer sent more than the request it revealed");
            }
            Gate::Sealed => {
                self.held.push(record);
                Ok(None)
            }
            Gate::Open => Ok(Some(record)),
            Gate::Shut => Ok(None),
        }
    }

    /// Closes the request at `length` bytes and returns its application-data records, which the buyer
    /// reveals parts of. Application data that arrives later is never forwarded: it would reach the
    /// upstream unchecked.
    fn seal(&mut self, length: usize) -> Result<Vec<Record>> {
        if self.gate != Gate::Hold || self.request_len != length {
            bail!("the buyer sent {} request bytes, not the {length} it revealed", self.request_len);
        }
        self.gate = Gate::Sealed;
        Ok(self.held.iter().filter(|r| r.typ == APPLICATION_DATA).cloned().collect())
    }

    /// Opens the gate on Node's admission: the held records, to forward in order.
    fn open(&mut self) -> Result<Vec<Record>> {
        if self.gate != Gate::Sealed {
            bail!("the request is not the one Node checked");
        }
        self.gate = Gate::Open;
        Ok(std::mem::take(&mut self.held))
    }

    fn shut(&mut self) {
        self.gate = Gate::Shut;
        self.held.clear();
    }
}

/// How the relaying of the answer ended.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AnswerEnd {
    /// The upstream closed: the answer is whole.
    Upstream,
    /// The buyer's side ended first.
    Buyer,
    /// The upstream held the answer open past the response deadline.
    Deadline,
    /// The answer grew past what the seller keeps.
    Length,
}

/// The server's application-data records after the handshake. The seller
/// keeps them all for the reveal that ends the session, so it keeps a bounded
/// answer and relays no more than it keeps.
#[derive(Default)]
struct Answer {
    records: Vec<Record>,
    /// What the records cost to keep: their bytes and `RECORD_COST` each.
    kept: usize,
    /// The answer passed the limit: no more of it is kept or relayed.
    cut: bool,
}

impl Answer {
    /// Keeps the records of one read from the upstream, all or none. False
    /// when they take the answer past `max`: the answer ends before them.
    fn keep(&mut self, records: Vec<Record>, max: usize) -> bool {
        let cost: usize = records.iter().map(|record| record.body.len() + RECORD_COST).sum();
        if self.cut || cost > max.saturating_sub(self.kept) {
            self.cut = true;
            return false;
        }
        self.kept += cost;
        self.records.extend(records);
        true
    }
}

/// The plaintext the buyer revealed, as Node gets it: offset in the stream and the bytes.
fn shown(placed: &[Placed], keystreams: Vec<Vec<u8>>) -> Vec<serde_json::Value> {
    let pieces = placed
        .iter()
        .zip(keystreams)
        .map(|(piece, keystream)| (piece.offset, piece.ciphertext.iter().zip(&keystream).map(|(c, k)| c ^ k).collect()))
        .collect();
    ranges::join(pieces).into_iter().map(|(offset, plaintext)| json!({ "offset": offset, "data": B64.encode(plaintext) })).collect()
}

#[derive(Default)]
struct Shared {
    client: HandshakeSide,
    server: HandshakeSide,
    request: RequestGate,
    answer: Answer,
    bytes_up: u64,
    bytes_down: u64,
}

/// One step of a proof, under a deadline. Each step waits on the buyer's part
/// in it, and a buyer that stays connected and sends no more of it would hold
/// the session, and what the seller keeps for it, open.
async fn proof_step<T>(limit: Duration, step: &str, work: impl Future<Output = T>) -> Result<T> {
    tokio::time::timeout(limit, work).await.map_err(|_| anyhow!("the buyer did not finish the {step} in time"))
}

pub async fn run(stdio: frames::Stdio) -> Result<()> {
    let frames::Stdio { mut ctl, app: _, out, peer } = stdio;
    let start = ctl.recv().await.ok_or_else(|| anyhow!("no start message"))?;
    let host = start["host"].as_str().ok_or_else(|| anyhow!("host missing"))?.to_string();
    let port = start["port"].as_u64().unwrap_or(443) as u16;
    let server_name = start["serverName"].as_str().unwrap_or(&host).to_string();
    let head = B64.decode(start["head"].as_str().ok_or_else(|| anyhow!("head missing"))?).context("head")?;
    // Tests only: extra trusted roots (PEM) on top of the Mozilla set.
    let extra_roots = start["extraRootsPem"].as_str().map(str::to_string);
    if head.is_empty() || head.len() > MAX_HEAD {
        bail!("request head length {} is out of range", head.len());
    }
    let max_request = start["maxRequestBytes"].as_u64().map_or(DEFAULT_MAX_REQUEST, |n| n as usize);
    let response_timeout = start["responseTimeoutMs"].as_u64().map_or(RESPONSE_TIMEOUT, Duration::from_millis);
    let max_response = start["maxResponseBytes"].as_u64().map_or(DEFAULT_MAX_RESPONSE, |n| n as usize);
    let proof_timeout = start["proofTimeoutMs"].as_u64().map_or(PROOF_TIMEOUT, Duration::from_millis);

    let (mut session, tls) = PeerSession::open(peer)?;
    session.ctx.io_mut().send(Hello { version: PROTOCOL_VERSION, injected_len: head.len() as u32 }).await?;
    let mut vm = verifier_vm();
    let mut proof = KeyProof::alloc(&mut vm, false, head.len())?;
    proof_step(proof_timeout, "preprocessing", vm.flush(&mut session.ctx)).await?.context("preprocessing")?;

    let upstream = TcpStream::connect((host.as_str(), port)).await.with_context(|| format!("connect {host}:{port}"))?;
    upstream.set_nodelay(true)?;
    let (mut up_read, up_write) = upstream.into_split();
    // Shared with the admission below, which flushes the held request; whoever
    // writes holds this lock, so the request goes out before anything after it.
    let up_write = Arc::new(Mutex::new(up_write));
    let (mut tls_read, mut tls_write) = tls.split();

    let shared = Arc::new(Mutex::new(Shared::default()));
    let (client_done_tx, mut client_done) = watch::channel(false);
    let (server_done_tx, mut server_done) = watch::channel(false);
    let (inject_tx, inject_rx) = oneshot::channel::<Vec<u8>>();
    let (closed_tx, mut closed) = watch::channel(false);
    let (request_len_tx, mut request_len) = watch::channel(0usize);

    // Buyer → upstream: the handshake, then nothing until the seller's record
    // is written, then nothing of the request until Node admits it.
    let up_shared = shared.clone();
    let up_writer = up_write.clone();
    let up = tokio::spawn(async move {
        let mut parser = RecordParser::default();
        let mut buf = vec![0u8; 32 * 1024];
        let mut inject = Some(inject_rx);
        loop {
            let n = tls_read.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            for record in parser.push(&buf[..n])? {
                if let Some(rx) = inject.take() {
                    let finished = up_shared.lock().await.client.take(&record)?;
                    up_writer.lock().await.write_all(&raw(&record)).await?;
                    if finished {
                        let _ = client_done_tx.send(true);
                        // Hold the buyer's bytes until the seller's record is on the wire.
                        let injected = rx.await.map_err(|_| anyhow!("no record to inject"))?;
                        up_writer.lock().await.write_all(&injected).await?;
                    } else {
                        inject = Some(rx);
                    }
                    continue;
                }
                // Application data and alerts (close_notify) only: no renegotiation.
                if record.typ != APPLICATION_DATA && record.typ != ALERT {
                    bail!("the buyer sent a TLS record of type {} after the handshake", record.typ);
                }
                let mut state = up_shared.lock().await;
                let forward = state.request.take(record, max_request)?;
                let request_len = state.request.request_len;
                request_len_tx.send_if_modified(|len| std::mem::replace(len, request_len) != request_len);
                if let Some(record) = forward {
                    let bytes = raw(&record);
                    state.bytes_up += bytes.len() as u64;
                    drop(state);
                    up_writer.lock().await.write_all(&bytes).await?;
                }
            }
        }
        let _ = up_writer.lock().await.shutdown().await;
        Ok::<_, anyhow::Error>(())
    });

    // Upstream → buyer: forward everything, up to the answer the seller keeps; keep the handshake
    // and the response records.
    let down_shared = shared.clone();
    let down = tokio::spawn(async move {
        let mut parser = RecordParser::default();
        let mut buf = vec![0u8; 32 * 1024];
        let mut in_handshake = true;
        loop {
            let n = up_read.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            let records = parser.push(&buf[..n])?;
            {
                let mut shared = down_shared.lock().await;
                let mut relayed = 0;
                let mut answer = Vec::new();
                for record in records {
                    if in_handshake {
                        if shared.server.take(&record)? {
                            in_handshake = false;
                            let _ = server_done_tx.send(true);
                        }
                    } else {
                        relayed += 5 + record.body.len() as u64;
                        if record.typ == APPLICATION_DATA {
                            answer.push(record);
                        }
                    }
                }
                // Checked before these bytes go to the buyer, so what is
                // reported as relayed is what was.
                if !shared.answer.keep(answer, max_response) {
                    break;
                }
                shared.bytes_down += relayed;
            }
            tls_write.write_all(&buf[..n]).await?;
            tls_write.flush().await?;
        }
        let _ = tls_write.close().await;
        let _ = closed_tx.send(true);
        Ok::<_, anyhow::Error>(())
    });

    let handshake = async {
        client_done.wait_for(|done| *done).await.map_err(|_| anyhow!("the buyer left during the handshake"))?;
        server_done.wait_for(|done| *done).await.map_err(|_| anyhow!("the upstream left during the handshake"))?;
        Ok::<_, anyhow::Error>(())
    };
    tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake).await.map_err(|_| anyhow!("handshake timed out"))??;

    // Check the handshake before anything secret is computed or written.
    let transcript = {
        let shared = shared.lock().await;
        let hello = server_hello(&shared.server.records)?;
        if !ALLOWED_SUITES.contains(&hello.cipher_suite) {
            bail!("the upstream chose cipher suite {:#06x}", hello.cipher_suite);
        }
        if let Some(alpn) = &hello.alpn {
            if alpn.as_slice() != b"http/1.1" {
                bail!("the upstream chose ALPN {:?}, not http/1.1", String::from_utf8_lossy(alpn));
            }
        }
        TlsTranscript::builder().time(now()).tls_sent(&shared.client.bytes).tls_recv(&shared.server.bytes).build()?
    };
    let tlsn_core::connection::CertBinding::V1_2(binding) = transcript.certificate_binding() else {
        bail!("only TLS 1.2 is supported");
    };
    let handshake_data = HandshakeData {
        certs: transcript.server_cert_chain().ok_or_else(|| anyhow!("no certificate chain"))?.to_vec(),
        sig: transcript.server_signature().ok_or_else(|| anyhow!("no server signature"))?.clone(),
        binding: transcript.certificate_binding().clone(),
    };
    let dns = DnsName::try_from(server_name.as_str()).map_err(|_| anyhow!("invalid server name"))?;
    handshake_data
        .verify(&cert_verifier(extra_roots.as_deref())?, now(), &binding.server_ephemeral_key, &ServerName::Dns(dns))
        .map_err(|error| anyhow!("the upstream's certificate or signature did not verify: {error}"))?;

    let keystream = proof_step(proof_timeout, "key proof", proof.prove(&mut vm, &mut session.ctx, None, &transcript)).await?.context("key proof")?;
    let record = SellerRecord::new(INJECTED_SEQ, &head, &keystream)?;
    // The record's tag, without the GHASH key: the buyer answers the offer
    // with its share and the tag mask, and learns nothing of the record.
    let (entries, share) = proof.tag_offer(&vm, &record)?;
    session.ctx.io_mut().send(TagOffer { entries }).await?;
    let answer: TagAnswer = tokio::time::timeout(HANDSHAKE_TIMEOUT, session.ctx.io_mut().expect_next())
        .await
        .map_err(|_| anyhow!("the buyer did not answer the record tag"))?
        .context("record tag")?;
    let mut tag = share;
    for (t, a) in tag.iter_mut().zip(answer.value) {
        *t ^= a;
    }
    inject_tx.send(record.with_tag(&tag)).map_err(|_| anyhow!("the relay ended before the record was written"))?;
    session.ctx.io_mut().send(Injected { seq: INJECTED_SEQ }).await?;
    out.ctl(json!({ "type": "injected" }));

    // The buyer names its request's length and reveals parts of it; its
    // records may still be on their way.
    let reveal: RequestReveal = tokio::time::timeout(REQUEST_TIMEOUT, session.ctx.io_mut().expect_next())
        .await
        .map_err(|_| anyhow!("the buyer revealed no request"))??;
    let length = usize::try_from(reveal.length).unwrap_or(usize::MAX);
    if length == 0 || length > max_request {
        bail!("request length {length} is out of range");
    }
    tokio::time::timeout(REQUEST_TIMEOUT, request_len.wait_for(|n| *n >= length))
        .await
        .map_err(|_| anyhow!("the buyer's request did not arrive"))?
        .map_err(|_| anyhow!("the relay ended before the request arrived"))?;
    let request = shared.lock().await.request.seal(length)?;
    let (request_ranges, placed) = ranges::place(&request, &reveal.ranges)?;
    if request_ranges.is_empty() {
        bail!("the buyer revealed nothing of its request");
    }
    let keystreams = proof_step(proof_timeout, "request reveal", proof.reveal(&mut vm, &mut session.ctx, Side::Client, &request_ranges))
        .await?
        .context("request reveal")?;
    out.ctl(json!({ "type": "request", "length": length, "ranges": shown(&placed, keystreams) }));
    drop(request);

    let decision = tokio::time::timeout(ADMIT_TIMEOUT, async {
        while let Some(message) = ctl.recv().await {
            if message["type"] == "admit" || message["type"] == "refuse" {
                return Some(message);
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    let refusal = match &decision {
        Some(message) if message["type"] == "admit" => None,
        Some(message) => Some(message["reason"].as_str().unwrap_or("refused").chars().take(300).collect::<String>()),
        None => Some("the seller did not decide in time".to_string()),
    };
    if let Some(reason) = refusal {
        // Nothing of the request ever reaches the upstream.
        shared.lock().await.request.shut();
        up.abort();
        down.abort();
        session.ctx.io_mut().send(RequestVerdict { admitted: false, reason: reason.clone() }).await?;
        out.ctl(json!({ "type": "refused", "reason": reason }));
        session.close().await;
        return Ok(());
    }
    {
        let mut writer = up_write.lock().await;
        let held = {
            let mut state = shared.lock().await;
            let held = state.request.open()?;
            state.bytes_up += held.iter().map(|r| 5 + r.body.len() as u64).sum::<u64>();
            held
        };
        for record in &held {
            writer.write_all(&raw(record)).await?;
        }
        writer.flush().await?;
    }
    session.ctx.io_mut().send(RequestVerdict { admitted: true, reason: String::new() }).await?;
    out.ctl(json!({ "type": "admitted" }));

    // The answer ends when the upstream closes. A buyer whose side ends first
    // has left, or has read the whole answer, and an upstream may hold its
    // answer open past the deadline or send more than the seller keeps: in
    // each case no more of it is relayed, and what was is reported, so the
    // request is still billed.
    let mut up = up;
    let end = tokio::select! {
        ended = tokio::time::timeout(response_timeout, closed.wait_for(|done| *done)) => if ended.is_ok() { AnswerEnd::Upstream } else { AnswerEnd::Deadline },
        _ = &mut up => AnswerEnd::Buyer,
    };
    up.abort();
    if end != AnswerEnd::Upstream {
        // Still reading the upstream: stopped, so nothing waits on it.
        down.abort();
    }
    if let Ok(Err(error)) = down.await {
        tracing::debug!("relay to the buyer ended: {error}");
    }

    let (responses, bytes_up, bytes_down, end) = {
        let mut shared = shared.lock().await;
        let end = if shared.answer.cut { AnswerEnd::Length } else { end };
        (std::mem::take(&mut shared.answer.records), shared.bytes_up, shared.bytes_down, end)
    };
    let length: usize = responses.iter().map(|r| r.body.len().saturating_sub(RECORD_OVERHEAD)).sum();
    out.ctl(json!({ "type": "responseEnd", "length": length, "bytesUp": bytes_up, "bytesDown": bytes_down }));
    if end == AnswerEnd::Deadline {
        // The buyer has no whole answer to reveal the usage of: Node bills what was relayed.
        bail!("the upstream did not finish its answer in time");
    }
    if end == AnswerEnd::Length {
        // The same: the buyer has part of an answer, and Node bills what was relayed.
        bail!("the upstream's answer is longer than the seller keeps ({max_response} bytes)");
    }

    let request: RevealRequest = tokio::time::timeout(REVEAL_TIMEOUT, session.ctx.io_mut().expect_next())
        .await
        .map_err(|_| anyhow!("no reveal from the buyer"))?
        .context("the buyer left without revealing the answer's usage")?;
    let (response_ranges, placed) = ranges::place(&responses, &request.ranges)?;
    // The answer's length is reported by now: a buyer that stops here is billed for what was relayed.
    let keystreams = proof_step(proof_timeout, "reveal of the answer", proof.reveal(&mut vm, &mut session.ctx, Side::Server, &response_ranges))
        .await?
        .context("reveal")?;
    out.ctl(json!({ "type": "revealed", "length": length, "ranges": shown(&placed, keystreams) }));
    session.ctx.io_mut().send(Done).await?;
    session.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX: usize = 1 << 20;

    fn data(plaintext: usize) -> Record {
        Record { typ: APPLICATION_DATA, body: vec![7; RECORD_OVERHEAD + plaintext] }
    }

    fn alert() -> Record {
        Record { typ: ALERT, body: vec![9; RECORD_OVERHEAD + 2] }
    }

    #[test]
    fn holds_the_request_until_it_is_admitted() {
        let mut gate = RequestGate::default();
        assert!(gate.take(data(10), MAX).unwrap().is_none());
        assert!(gate.take(data(5), MAX).unwrap().is_none());
        assert!(gate.seal(14).is_err());
        assert_eq!(gate.seal(15).unwrap().len(), 2);
        assert_eq!(gate.open().unwrap().len(), 2);
        // After the request, only alerts pass.
        assert_eq!(gate.take(alert(), MAX).unwrap().unwrap().typ, ALERT);
        assert!(gate.take(data(1), MAX).is_err());
    }

    #[test]
    fn forwards_nothing_that_arrives_after_the_request_was_checked() {
        let mut gate = RequestGate::default();
        gate.take(data(10), MAX).unwrap();
        assert_eq!(gate.seal(10).unwrap().len(), 1);
        // A close_notify may follow the request, and goes out after it.
        assert!(gate.take(alert(), MAX).unwrap().is_none());
        // More application data while Node decides is not part of the checked request.
        assert!(gate.take(data(4), MAX).is_err());
        // The buyer broke the session: nothing of it reaches the upstream.
        assert!(gate.open().is_err());
    }

    #[test]
    fn forwards_the_checked_request_and_a_closing_alert() {
        let mut gate = RequestGate::default();
        gate.take(data(10), MAX).unwrap();
        gate.seal(10).unwrap();
        gate.take(alert(), MAX).unwrap();
        let types: Vec<u8> = gate.open().unwrap().iter().map(|r| r.typ).collect();
        assert_eq!(types, vec![APPLICATION_DATA, ALERT]);
    }

    #[test]
    fn rejects_an_application_data_record_with_no_plaintext() {
        let mut gate = RequestGate::default();
        assert!(gate.take(data(0), MAX).is_err());
    }

    #[test]
    fn holds_a_bounded_number_of_records_for_a_request() {
        let mut gate = RequestGate::default();
        // One byte per record: the request stays far under its byte limit.
        let held = (0..100_000).take_while(|_| gate.take(data(1), MAX).is_ok()).count();
        assert!(held < 10_000, "held {held} one-byte records");
    }

    #[test]
    fn holds_a_bounded_number_of_alerts_before_and_after_the_request_is_sealed() {
        let mut gate = RequestGate::default();
        gate.take(data(10), MAX).unwrap();
        let held = (0..1000).take_while(|_| gate.take(alert(), MAX).is_ok()).count();
        assert!(held < 1000, "held {held} alerts with the request");

        let mut gate = RequestGate::default();
        gate.take(data(10), MAX).unwrap();
        gate.seal(10).unwrap();
        let held = (0..1000).take_while(|_| gate.take(alert(), MAX).is_ok()).count();
        assert!(held < 1000, "held {held} alerts after the request was sealed");
    }

    #[test]
    fn rejects_an_alert_of_another_size() {
        let mut gate = RequestGate::default();
        gate.take(data(10), MAX).unwrap();
        assert!(gate.take(Record { typ: ALERT, body: vec![9; 16_000] }, MAX).is_err());
        // The session is over: nothing of it is forwarded.
        assert!(gate.seal(10).is_err());

        let mut gate = RequestGate::default();
        gate.take(data(10), MAX).unwrap();
        assert!(gate.take(Record { typ: ALERT, body: vec![9; RECORD_OVERHEAD] }, MAX).is_err());
    }

    #[test]
    fn keeps_an_answer_up_to_its_limit_and_nothing_past_it() {
        let mut answer = Answer::default();
        let cost = |plaintext: usize| RECORD_OVERHEAD + plaintext + RECORD_COST;
        let max = cost(100) + cost(50);
        assert!(answer.keep(vec![data(100)], max));
        // The records of one read are kept together or not at all.
        assert!(!answer.keep(vec![data(10), data(41)], max));
        assert_eq!(answer.records.len(), 1);
        // And nothing after the cut, however small.
        assert!(!answer.keep(vec![data(1)], max));
        assert!(!answer.keep(Vec::new(), max));
        assert_eq!(answer.records.len(), 1);

        let mut answer = Answer::default();
        assert!(answer.keep(vec![data(100)], max));
        assert!(answer.keep(vec![data(50)], max));
        assert!(answer.keep(Vec::new(), max));
        assert_eq!(answer.records.len(), 2);
    }

    #[test]
    fn tiny_records_count_for_what_they_cost_to_keep() {
        let mut answer = Answer::default();
        let records = |n: usize| (0..n).map(|_| data(1)).collect::<Vec<_>>();
        let max = 1000 * (RECORD_OVERHEAD + 1);
        // A thousand one-byte records fit by their bytes, and not by what holding them takes.
        assert!(!answer.keep(records(1000), max));
        let mut answer = Answer::default();
        assert!(answer.keep(records(max / (RECORD_OVERHEAD + 1 + RECORD_COST)), max));
        assert!(!answer.keep(records(1), max));
    }

    #[test]
    fn a_refused_request_is_dropped() {
        let mut gate = RequestGate::default();
        gate.take(data(10), MAX).unwrap();
        gate.seal(10).unwrap();
        gate.shut();
        assert!(gate.take(data(1), MAX).unwrap().is_none());
        assert!(gate.open().is_err());
    }
}
