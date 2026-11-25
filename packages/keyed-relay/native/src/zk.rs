//! The zero-knowledge part, on TLSNotary's proxy-mode building blocks.
//!
//! The buyer (prover) knows the TLS 1.2 master secret. Inside the ZK VM it
//! derives the session keys with the TLS PRF and checks both Finished records
//! the seller (verifier) saw on the wire, which binds the keys to that
//! handshake. From the same keys the VM then computes, and reveals to the
//! seller only:
//! - for the seller's record (client direction, sequence 1): the keystream
//!   for its bytes;
//! - before the seller forwards the request: the client-direction keystream
//!   for the request bytes the buyer reveals (its headers and the body's
//!   fixed tail), which the seller checks;
//! - at the end, for billing: the server-direction keystream for the response
//!   bytes the buyer chooses to reveal.
//!
//! Every keystream the seller receives is proven: the buyer cannot hand it a
//! wrong one, which would let it flip bytes of the seller's record.
//!
//! The seller's record also needs a GCM tag. The client GHASH key never leaves
//! the VM, because whoever holds it can change any record of the session and
//! fix its tag. The VM proves the powers of the key the record's tag needs,
//! unrevealed, and the two sides compute the tag from them together (`tag`).
//! The seller learns that one tag and the buyer learns nothing of the record.

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
use mpz_memory_core::correlated::{Key, Mac};
use mpz_vm_core::{Execute, Vm};
use tlsn_core::transcript::TlsTranscript;

use crate::{records::SellerRecord, tag};

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

/// The proof behind the seller's record (client direction, sequence
/// `INJECTED_SEQ`): the keystream of its bytes, which the seller learns, and
/// the powers of the client GHASH key its tag needs, which nobody learns.
struct Injection {
    keystream: Ks,
    decoded: DecodeFutureTyped<BitVec, Vec<u8>>,
    /// `H¹..Hⁿ`, one per block GHASH reads for the record. Never decoded.
    powers: Vec<Array<U8, 16>>,
}

impl Injection {
    fn alloc(vm: &mut dyn Vm<Binary>, encrypt: &mut Aes128, len: usize) -> Result<Self> {
        // The client GHASH key: AES_k(0^128).
        let zero: Array<U8, 16> = vm.alloc()?;
        vm.mark_public(zero)?;
        vm.assign(zero, [0u8; 16])?;
        vm.commit(zero)?;
        let ghash_key = encrypt.alloc_block(vm, zero)?;
        let powers = tag::alloc_powers(vm, ghash_key, SellerRecord::ghash_block_count(len))?;

        // The record's keystream: counters 2 and up. Counter 1 is the tag
        // mask, which only the buyer may hold.
        let keystream = encrypt.alloc_keystream(vm, len)?;
        let decoded = keystream.to_vector(vm, len)?;
        let decoded = vm.decode(decoded)?;
        Ok(Self { keystream, decoded, powers })
    }

    fn assign(&self, vm: &mut dyn Vm<Binary>) -> Result<()> {
        let mut counter = START_COUNTER;
        self.keystream.assign(vm, INJECTED_SEQ.to_be_bytes(), || {
            let c = counter;
            counter += 1;
            c.to_be_bytes()
        })?;
        Ok(())
    }

    fn keystream(&mut self) -> Result<Vec<u8>> {
        self.decoded.try_recv()?.ok_or_else(|| anyhow!("keystream not decoded"))
    }

    /// Seller: what it sends the buyer for the tag of a record with these
    /// GHASH blocks, and its own share of the tag.
    fn tag_offer<OT>(&self, vm: &mpz_zk::Verifier<OT>, blocks: &[[u8; 16]]) -> Result<(Vec<u8>, [u8; 16])> {
        let keys = self.powers.iter().map(|power| Ok(Key::as_blocks(vm.get_keys(*power)?))).collect::<Result<Vec<_>>>()?;
        tag::offer(&keys, vm.delta().as_block(), blocks)
    }

    /// Buyer: its share of the tag, from the seller's offer.
    fn tag_answer<OT>(&self, vm: &mpz_zk::Prover<OT>, offer: &[u8]) -> Result<[u8; 16]> {
        let macs = self.powers.iter().map(|power| Ok(Mac::as_blocks(vm.get_macs(*power)?))).collect::<Result<Vec<_>>>()?;
        tag::answer(&macs, offer)
    }
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
    injection: Injection,
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

        let injection = Injection::alloc(vm, &mut encrypt, injected_len)?;

        Ok(Self { prf, ms, cf_vd, cf_check, sf_check, encrypt, decrypt, injection })
    }

    /// Runs the key proof over the handshake both sides saw. The prover passes
    /// the master secret; the verifier passes `None` and learns only the
    /// keystream of its record, and only if both Finished records check out.
    pub async fn prove<V>(&mut self, vm: &mut V, ctx: &mut Context, ms: Option<[u8; 48]>, transcript: &TlsTranscript) -> Result<Vec<u8>>
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

        self.injection.assign(vm)?;
        vm.execute_all(ctx).await?;

        self.cf_check.check(vm)?;
        self.sf_check.check(vm)?;

        self.injection.keystream()
    }

    /// Seller, after `prove`: what it sends the buyer for the tag of its
    /// record, and its own share of that tag.
    pub fn tag_offer<OT>(&self, vm: &mpz_zk::Verifier<OT>, record: &SellerRecord) -> Result<(Vec<u8>, [u8; 16])> {
        self.injection.tag_offer(vm, &record.ghash_blocks())
    }

    /// Buyer, after `prove`: what it answers the seller's offer with, given
    /// the tag mask of the seller's record. The seller's share added to it is
    /// the tag. Call it once per session: two answers to two offers, added
    /// together, lose the mask and tell the seller about the GHASH key.
    pub fn tag_answer<OT>(&self, vm: &mpz_zk::Prover<OT>, offer: &[u8], tag_mask: &[u8; 16]) -> Result<[u8; 16]> {
        let mut answer = self.injection.tag_answer(vm, offer)?;
        for (a, m) in answer.iter_mut().zip(tag_mask) {
            *a ^= m;
        }
        Ok(answer)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        records::{
            APPLICATION_DATA, Direction,
            tests::{HEAD, IV, KEY, accepted_retags, ghash_key, keystream},
        },
        tag::tests::reference_multiply,
    };
    use mpz_common::context::test_st_context;
    use mpz_ot::ideal::rcot::ideal_rcot;
    use rand::{RngExt, SeedableRng, rngs::StdRng};

    fn alloc(vm: &mut dyn Vm<Binary>, prover: bool, len: usize) -> Result<Injection> {
        let key: Array<U8, 16> = vm.alloc()?;
        let iv: Array<U8, 4> = vm.alloc()?;
        if prover {
            vm.mark_private(key)?;
            vm.mark_private(iv)?;
            vm.assign(key, KEY)?;
            vm.assign(iv, IV)?;
        } else {
            vm.mark_blind(key)?;
            vm.mark_blind(iv)?;
        }
        vm.commit(key)?;
        vm.commit(iv)?;
        let mut encrypt = Aes128::default();
        encrypt.set_key(key);
        encrypt.set_iv(iv);
        let injection = Injection::alloc(vm, &mut encrypt, len)?;
        injection.assign(vm)?;
        Ok(injection)
    }

    /// The seller's record for `head`, made by a prover and a verifier in
    /// this process, and everything the seller held on the way.
    async fn sellers_record(head: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut rng = StdRng::seed_from_u64(head.len() as u64);
        let delta = Delta::random(&mut rng);
        let (mut ctx_p, mut ctx_v) = test_st_context(8);
        let (ot_send, ot_recv) = ideal_rcot(rng.random(), delta.into_inner());
        let mut prover = mpz_zk::Prover::new(Default::default(), ot_recv);
        let mut verifier = mpz_zk::Verifier::new(Default::default(), delta, ot_send);

        let buyer = alloc(&mut prover, true, head.len()).unwrap();
        let mut seller = alloc(&mut verifier, false, head.len()).unwrap();
        let (proved, verified) = futures::join!(prover.execute_all(&mut ctx_p), verifier.execute_all(&mut ctx_v));
        proved.unwrap();
        verified.unwrap();

        let stream = seller.keystream().unwrap();
        assert_eq!(stream, keystream(INJECTED_SEQ, head.len())[..head.len()]);

        // Each side's labels prove the powers of the GHASH key, bit by bit.
        let mut held = stream.clone();
        held.extend_from_slice(delta.as_block().as_bytes());
        let mut power = ghash_key();
        for array in &seller.powers {
            let keys = verifier.get_keys(*array).unwrap();
            let macs = prover.get_macs(*array).unwrap();
            let mut proven = [0u8; 16];
            for (i, (key, mac)) in keys.iter().zip(macs).enumerate() {
                assert_eq!(key.auth(mac.pointer(), &delta), *mac);
                proven[i / 8] |= (mac.pointer() as u8) << (i % 8);
                held.extend_from_slice(key.as_block().as_bytes());
            }
            assert_eq!(proven, power);
            power = reference_multiply(&power, &ghash_key());
        }

        let record = SellerRecord::new(INJECTED_SEQ, head, &stream).unwrap();
        let (offer, share) = seller.tag_offer(&verifier, &record.ghash_blocks()).unwrap();
        let mut answer = buyer.tag_answer(&prover, &offer).unwrap();
        let mask = Direction::new(&KEY, &IV, INJECTED_SEQ).unwrap().tag_mask().unwrap();
        answer.iter_mut().zip(mask).for_each(|(a, m)| *a ^= m);
        let mut tag = share;
        tag.iter_mut().zip(answer).for_each(|(t, a)| *t ^= a);
        let record = record.with_tag(&tag);

        held.extend_from_slice(&offer);
        held.extend_from_slice(&share);
        held.extend_from_slice(&answer);
        held.extend_from_slice(&record);
        (record, held)
    }

    #[tokio::test]
    async fn the_sellers_record_carries_the_tag_the_upstream_expects() {
        for len in [1usize, 16, 33, HEAD.len()] {
            let (record, _) = sellers_record(&HEAD[..len]).await;
            let reference = Direction::new(&KEY, &IV, INJECTED_SEQ).unwrap().seal(APPLICATION_DATA, &HEAD[..len]).unwrap();
            assert_eq!(record, reference, "{len} bytes");
        }
    }

    #[tokio::test]
    async fn a_later_buyer_record_cannot_be_retagged_with_what_the_seller_holds() {
        let (_, mut held) = sellers_record(HEAD).await;
        assert_eq!(accepted_retags(&held), 0, "the seller re-tagged a changed buyer record and it was accepted");
        // The same attempt with the GHASH key in hand, which the seller used to get.
        held.extend_from_slice(&ghash_key());
        assert_eq!(accepted_retags(&held), 1);
    }
}
