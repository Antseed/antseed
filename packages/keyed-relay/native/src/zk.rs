//! The zero-knowledge part, on TLSNotary's proxy-mode building blocks.
//!
//! The buyer (prover) knows the TLS 1.2 master secret. Inside the ZK VM it
//! derives the session keys with the TLS PRF and checks both Finished records
//! the seller (verifier) saw on the wire, which binds the keys to that
//! handshake. From the same keys the VM then computes, and reveals to the
//! seller only:
//! - for the seller's record (client direction, sequence 1): the GCM tag mask
//!   and the keystream for its bytes, plus the client GHASH key;
//! - before the seller forwards the request: the client-direction keystream
//!   for the request bytes the buyer reveals (its headers and the body's
//!   fixed tail), which the seller checks;
//! - at the end, for billing: the server-direction keystream for the response
//!   bytes the buyer chooses to reveal.
//!
//! Every value the seller receives is proven: the buyer cannot hand it a wrong
//! keystream (which would let it flip bytes of the seller's record) or a wrong
//! tag mask.

use anyhow::{Context as _, Result, anyhow, bail};
use cipher::{Cipher, Keystream, aes::Aes128};
use hmac_sha256::{MSMode, NetworkMode, Prf, PrfConfig};
use mpz_common::Context;
use mpz_core::{Block, bitvec::BitVec};
use mpz_garble_core::Delta;
use mpz_memory_core::{
    Array, DecodeFutureTyped, MemoryExt, Vector, ViewExt,
    binary::{Binary, U8},
};
use mpz_ot::{
    chou_orlandi as co, ferret, kos,
    rcot::shared::{SharedRCOTReceiver, SharedRCOTSender},
};
use mpz_vm_core::{Execute, Vm};
use tlsn_core::transcript::TlsTranscript;

pub type ProverZk = mpz_zk::Prover<SharedRCOTReceiver<ferret::Receiver<kos::Receiver<co::Sender>>, bool, Block>>;
pub type VerifierZk = mpz_zk::Verifier<SharedRCOTSender<ferret::Sender<kos::Sender<co::Receiver>>, Block>>;

pub fn prover_vm() -> ProverZk {
    let mut rng = rand::rng();
    let rcot = kos::Receiver::new(kos::ReceiverConfig::default(), co::Sender::default());
    let rcot = ferret::Receiver::new(ferret::FerretConfig::default(), Block::random(&mut rng), rcot);
    ProverZk::new(Default::default(), SharedRCOTReceiver::new(rcot))
}

pub fn verifier_vm() -> VerifierZk {
    let mut rng = rand::rng();
    let delta = Delta::random(&mut rng);
    let rcot = kos::Sender::new(kos::SenderConfig::default(), delta.into_inner(), co::Receiver::default());
    let rcot = ferret::Sender::new(ferret::FerretConfig::default(), Block::random(&mut rng), rcot);
    VerifierZk::new(Default::default(), delta, SharedRCOTSender::new(rcot))
}

/// AES-GCM's first keystream counter; counter 1 is the tag mask.
const START_COUNTER: u32 = 2;
/// The explicit nonce and sequence number of the seller's record.
pub const INJECTED_SEQ: u64 = 1;

type Ks = Keystream<Array<U8, 8>, Array<U8, 4>, Array<U8, 16>>;

/// Decrypts a Finished record in the VM and checks it against the PRF's verify data.
struct FinishedCheck {
    keystream: Ks,
    ciphertext: Array<U8, 16>,
    expected: Array<U8, 12>,
    actual: Vector<U8>,
}

impl FinishedCheck {
    fn alloc(vm: &mut dyn Vm<Binary>, cipher: &mut Aes128, expected: Array<U8, 12>) -> Result<Self> {
        let ciphertext: Array<U8, 16> = vm.alloc()?;
        vm.mark_public(ciphertext)?;
        let keystream = cipher.alloc_keystream(vm, 16)?;
        let actual = keystream.apply(vm, Vector::from(ciphertext))?;
        drop(vm.decode(actual)?);
        Ok(Self { keystream, ciphertext, expected, actual })
    }

    fn assign(&self, vm: &mut dyn Vm<Binary>, explicit_nonce: &[u8], ciphertext: &[u8]) -> Result<()> {
        let explicit_nonce: [u8; 8] = explicit_nonce.try_into().context("finished explicit nonce")?;
        let ciphertext: [u8; 16] = ciphertext.try_into().context("finished ciphertext")?;
        self.keystream.assign(vm, explicit_nonce, || START_COUNTER.to_be_bytes())?;
        vm.assign(self.ciphertext, ciphertext)?;
        vm.commit(self.ciphertext)?;
        Ok(())
    }

    fn check(&self, vm: &mut dyn Vm<Binary>) -> Result<()> {
        let mut actual = self.actual;
        // The first 4 bytes are the handshake message header.
        let actual: Array<U8, 12> = Array::try_from(actual.split_off(4)).map_err(|_| anyhow!("verify data length"))?;
        let expected = vm.get(self.expected)?.ok_or_else(|| anyhow!("expected verify data missing"))?;
        let actual = vm.get(actual)?.ok_or_else(|| anyhow!("actual verify data missing"))?;
        if expected != actual {
            bail!("Finished verify data does not match: the keys are not this session's");
        }
        Ok(())
    }
}

/// What the seller needs to write its own record without the session key.
pub struct Injection {
    pub tag_mask: [u8; 16],
    pub keystream: Vec<u8>,
    pub ghash_key: [u8; 16],
}

/// Whose records a reveal reads: the buyer's (the request) or the upstream's (the response).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Client,
    Server,
}

/// A range to reveal: one record's explicit nonce, and the byte range inside
/// that record's plaintext.
#[derive(Debug, Clone, Copy)]
pub struct RecordRange {
    pub explicit_nonce: [u8; 8],
    pub start: usize,
    pub len: usize,
}

pub struct KeyProof {
    prf: Prf,
    ms: Array<U8, 48>,
    cf_vd: DecodeFutureTyped<BitVec, [u8; 12]>,
    cf_check: FinishedCheck,
    sf_check: FinishedCheck,
    encrypt: Aes128,
    decrypt: Aes128,
    ghash_key: DecodeFutureTyped<BitVec, [u8; 16]>,
    injection_keystream: Ks,
    injection: DecodeFutureTyped<BitVec, Vec<u8>>,
}

impl KeyProof {
    /// Allocates the proof for a seller record of `injected_len` bytes. Both
    /// sides must allocate in the same order; only the master secret's
    /// visibility differs.
    pub fn alloc(vm: &mut dyn Vm<Binary>, prover: bool, injected_len: usize) -> Result<Self> {
        let ms: Array<U8, 48> = vm.alloc()?;
        if prover {
            vm.mark_private(ms)?;
        } else {
            vm.mark_blind(ms)?;
        }
        let mut prf = Prf::new(PrfConfig::new(NetworkMode::Normal, MSMode::Direct));
        let output = prf.alloc_ms(vm, ms)?;

        let mut encrypt = Aes128::default();
        encrypt.set_key(output.keys.client_write_key);
        encrypt.set_iv(output.keys.client_iv);
        let mut decrypt = Aes128::default();
        decrypt.set_key(output.keys.server_write_key);
        decrypt.set_iv(output.keys.server_iv);

        let cf_vd = vm.decode(output.cf_vd)?;
        drop(vm.decode(output.sf_vd)?);
        let cf_check = FinishedCheck::alloc(vm, &mut encrypt, output.cf_vd)?;
        let sf_check = FinishedCheck::alloc(vm, &mut decrypt, output.sf_vd)?;

        // The client GHASH key: AES_k(0^128).
        let zero: Array<U8, 16> = vm.alloc()?;
        vm.mark_public(zero)?;
        vm.assign(zero, [0u8; 16])?;
        vm.commit(zero)?;
        let ghash_key = encrypt.alloc_block(vm, zero)?;
        let ghash_key = vm.decode(ghash_key)?;

        // One block for the tag mask (counter 1), then the record's keystream (counters 2..).
        let len = 16 + injected_len;
        let injection_keystream = encrypt.alloc_keystream(vm, len)?;
        let injection = injection_keystream.to_vector(vm, len)?;
        let injection = vm.decode(injection)?;

        Ok(Self { prf, ms, cf_vd, cf_check, sf_check, encrypt, decrypt, ghash_key, injection_keystream, injection })
    }

    /// Runs the key proof over the handshake both sides saw. The prover passes
    /// the master secret; the verifier passes `None` and learns only the
    /// injection values, and only if both Finished records check out.
    pub async fn prove<V>(&mut self, vm: &mut V, ctx: &mut Context, ms: Option<[u8; 48]>, transcript: &TlsTranscript) -> Result<Injection>
    where
        V: Vm<Binary> + Execute + Send,
    {
        if let Some(ms) = ms {
            vm.assign(self.ms, ms)?;
        }
        vm.commit(self.ms)?;

        let tlsn_core::connection::CertBinding::V1_2(binding) = transcript.certificate_binding() else {
            bail!("only TLS 1.2 is supported");
        };
        let cf_hash = transcript.cf_hash().ok_or_else(|| anyhow!("client Finished hash missing"))?;
        self.prf.set_client_random(binding.client_random);
        self.prf.set_server_random(binding.server_random)?;
        self.prf.set_cf_hash(cf_hash)?;
        while self.prf.wants_flush() {
            self.prf.flush(vm)?;
            vm.execute_all(ctx).await?;
        }
        let cf_vd = self.cf_vd.try_recv()?.ok_or_else(|| anyhow!("client verify data not decoded"))?;
        let sf_hash = transcript.sf_hash(&cf_vd).ok_or_else(|| anyhow!("server Finished hash missing"))?;
        self.prf.set_sf_hash(sf_hash)?;
        while self.prf.wants_flush() {
            self.prf.flush(vm)?;
            vm.execute_all(ctx).await?;
        }

        let cf = transcript.client_finished();
        self.cf_check.assign(vm, &cf.explicit_nonce, &cf.ciphertext)?;
        let sf = transcript.server_finished();
        self.sf_check.assign(vm, &sf.explicit_nonce, &sf.ciphertext)?;

        let mut counter = 1u32;
        self.injection_keystream.assign(vm, INJECTED_SEQ.to_be_bytes(), || {
            let c = counter;
            counter += 1;
            c.to_be_bytes()
        })?;
        vm.execute_all(ctx).await?;

        self.cf_check.check(vm)?;
        self.sf_check.check(vm)?;

        let ghash_key = self.ghash_key.try_recv()?.ok_or_else(|| anyhow!("GHASH key not decoded"))?;
        let injection = self.injection.try_recv()?.ok_or_else(|| anyhow!("keystream not decoded"))?;
        let tag_mask: [u8; 16] = injection[..16].try_into().unwrap();
        Ok(Injection { tag_mask, keystream: injection[16..].to_vec(), ghash_key })
    }

    /// Reveals `side`'s keystream for `ranges`. Both sides pass the same
    /// ranges; the verifier takes each explicit nonce from the records it relayed.
    pub async fn reveal<V>(&mut self, vm: &mut V, ctx: &mut Context, side: Side, ranges: &[RecordRange]) -> Result<Vec<Vec<u8>>>
    where
        V: Vm<Binary> + Execute + Send,
    {
        if ranges.is_empty() {
            return Ok(Vec::new());
        }
        let cipher = match side {
            Side::Client => &mut self.encrypt,
            Side::Server => &mut self.decrypt,
        };
        let mut pending = Vec::with_capacity(ranges.len());
        for range in ranges {
            if range.len == 0 {
                bail!("empty reveal range");
            }
            let first_block = range.start / 16;
            let blocks = (range.start + range.len).div_ceil(16) - first_block;
            let keystream = cipher.alloc_keystream(vm, blocks * 16)?;
            let vector = keystream.to_vector(vm, blocks * 16)?;
            let skip = range.start - first_block * 16;
            // Only the requested bytes are decoded, not the rest of their blocks.
            let wanted = vector.get(skip..skip + range.len).ok_or_else(|| anyhow!("reveal range out of bounds"))?;
            let decoded = vm.decode(wanted)?;
            let mut counter = START_COUNTER + first_block as u32;
            keystream.assign(vm, range.explicit_nonce, || {
                let c = counter;
                counter += 1;
                c.to_be_bytes()
            })?;
            pending.push(decoded);
        }
        vm.execute_all(ctx).await?;
        pending
            .into_iter()
            .map(|mut decoded| decoded.try_recv()?.ok_or_else(|| anyhow!("reveal not decoded")))
            .collect()
    }
}
