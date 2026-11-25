//! The GCM tag of the seller's record, without the GHASH key.
//!
//! A GCM tag is `E_k(J0) ⊕ GHASH_H(record)`, and whoever holds `H` can change
//! any record of the session and fix its tag. So the seller never learns `H`.
//! Inside the ZK VM the buyer proves the powers of `H` the record needs,
//! without revealing them. Each proven bit is a correlated OT the two sides
//! already share (the buyer's MAC is the seller's key, plus Δ when the bit is
//! set), so the seller can offer, per bit, its GHASH block times that bit's
//! power of `x`, masked so that only a buyer holding the proven bit can use
//! it. Summed, the two sides hold XOR shares of `GHASH_H(record)`. The buyer
//! adds the tag mask of the seller's record, which it computes from its own
//! key, and returns the 16 bytes; the seller adds its share and has the tag.
//!
//! The buyer learns nothing of the record (every offer is masked by a hash of
//! a key it cannot compute). The seller learns one value, the tag of the one
//! record it wrote, and nothing it could tag another record with.

use std::sync::{Arc, LazyLock};

use anyhow::{Result, bail};
use mpz_circuits::{Circuit, CircuitBuilder, Feed, Node};
use mpz_core::Block;
use mpz_memory_core::{
    Array,
    binary::{Binary, U8},
};
use mpz_vm_core::{Call, CallableExt, Vm};

/// Bytes the seller offers per proven bit.
const OFFER: usize = 16;
/// Bits of a power of `H`.
const BITS: usize = 128;

const HASH_CONTEXT: &str = "antseed keyed-relay 2026 seller record tag";

/// The coefficient of `x` a VM wire of a block holds, and the other way
/// round. GHASH numbers the bits of a byte from its top bit; the VM from its
/// lowest.
const fn swap(i: usize) -> usize {
    8 * (i / 8) + 7 - (i % 8)
}

type Wire = Node<Feed>;

/// Reduces a product modulo `x^128 + x^7 + x^2 + x + 1` and writes the
/// circuit's output wires.
fn finish(mut builder: CircuitBuilder, mut c: Vec<Wire>) -> Circuit {
    for k in (BITS..c.len()).rev() {
        let top = c[k];
        for low in [k - 128, k - 127, k - 126, k - 121] {
            c[low] = builder.add_xor_gate(c[low], top);
        }
    }
    for wire in 0..BITS {
        // An identity gate per output: an output must be a wire of its own.
        let out = builder.add_id_gate(c[swap(wire)]);
        builder.add_output(out);
    }
    builder.build().expect("the circuit is well formed")
}

fn inputs(builder: &mut CircuitBuilder) -> Vec<Wire> {
    let wires: Vec<Wire> = (0..BITS).map(|_| builder.add_input()).collect();
    (0..BITS).map(|i| wires[swap(i)]).collect()
}

/// Karatsuba product of two polynomials of the same power-of-two length.
fn product(builder: &mut CircuitBuilder, a: &[Wire], b: &[Wire]) -> Vec<Wire> {
    let n = a.len();
    if n == 1 {
        return vec![builder.add_and_gate(a[0], b[0])];
    }
    let h = n / 2;
    let low = product(builder, &a[..h], &b[..h]);
    let high = product(builder, &a[h..], &b[h..]);
    let a_sum: Vec<Wire> = (0..h).map(|i| builder.add_xor_gate(a[i], a[h + i])).collect();
    let b_sum: Vec<Wire> = (0..h).map(|i| builder.add_xor_gate(b[i], b[h + i])).collect();
    let mut middle = product(builder, &a_sum, &b_sum);
    for i in 0..middle.len() {
        let both = builder.add_xor_gate(low[i], high[i]);
        middle[i] = builder.add_xor_gate(middle[i], both);
    }
    let zero = builder.get_const_zero();
    let mut out = vec![zero; 2 * n - 1];
    for i in 0..low.len() {
        out[i] = builder.add_xor_gate(out[i], low[i]);
        out[i + h] = builder.add_xor_gate(out[i + h], middle[i]);
        out[i + n] = builder.add_xor_gate(out[i + n], high[i]);
    }
    out
}

/// `a · b` in GHASH's field.
static MULTIPLY: LazyLock<Arc<Circuit>> = LazyLock::new(|| {
    let mut builder = CircuitBuilder::new();
    let a = inputs(&mut builder);
    let b = inputs(&mut builder);
    let c = product(&mut builder, &a, &b);
    Arc::new(finish(builder, c))
});

/// `a²` in GHASH's field: no AND gate.
static SQUARE: LazyLock<Arc<Circuit>> = LazyLock::new(|| {
    let mut builder = CircuitBuilder::new();
    let a = inputs(&mut builder);
    let zero = builder.get_const_zero();
    let mut c = vec![zero; 2 * BITS - 1];
    for (i, wire) in a.into_iter().enumerate() {
        c[2 * i] = wire;
    }
    Arc::new(finish(builder, c))
});

/// `H¹..Hⁿ` in the VM, from `H`. Nothing here is decoded.
pub fn alloc_powers(vm: &mut dyn Vm<Binary>, h: Array<U8, 16>, n: usize) -> Result<Vec<Array<U8, 16>>> {
    let mut powers: Vec<Array<U8, 16>> = Vec::with_capacity(n);
    powers.push(h);
    for k in 2..=n {
        let call = if k % 2 == 0 {
            Call::builder(SQUARE.clone()).arg(powers[k / 2 - 1]).build()?
        } else {
            Call::builder(MULTIPLY.clone()).arg(powers[k - 2]).arg(h).build()?
        };
        powers.push(vm.call(call)?);
    }
    Ok(powers)
}

/// `v · x` in GHASH's field, the element read as a big-endian integer.
fn times_x(v: u128) -> u128 {
    let carry = v & 1;
    let v = v >> 1;
    if carry == 1 { v ^ (0xe1u128 << 120) } else { v }
}

/// `block · x^i` for every bit `i` of a power, in VM wire order.
fn shifted(block: &[u8; 16]) -> [[u8; 16]; BITS] {
    let mut by_coefficient = [[0u8; 16]; BITS];
    let mut v = u128::from_be_bytes(*block);
    for entry in by_coefficient.iter_mut() {
        *entry = v.to_be_bytes();
        v = times_x(v);
    }
    let mut by_wire = [[0u8; 16]; BITS];
    for (wire, entry) in by_wire.iter_mut().enumerate() {
        *entry = by_coefficient[swap(wire)];
    }
    by_wire
}

fn mask(label: &Block, block: usize, wire: usize) -> [u8; 16] {
    let mut hasher = blake3::Hasher::new_derive_key(HASH_CONTEXT);
    hasher.update(label.as_bytes());
    hasher.update(&(block as u32).to_be_bytes());
    hasher.update(&[wire as u8]);
    hasher.finalize().as_bytes()[..16].try_into().unwrap()
}

fn xor(into: &mut [u8], from: &[u8]) {
    for (a, b) in into.iter_mut().zip(from) {
        *a ^= b;
    }
}

/// The length of the seller's offer for a record of `blocks` GHASH blocks.
pub fn offer_len(blocks: usize) -> usize {
    blocks * BITS * OFFER
}

/// The seller's side. `keys` are its keys for the powers of `H`, `keys[q]`
/// for `H^(q+1)`, and `blocks` the record's GHASH blocks in order. Returns
/// the offer for the buyer and the seller's share of the GHASH.
pub fn offer(keys: &[&[Block]], delta: &Block, blocks: &[[u8; 16]]) -> Result<(Vec<u8>, [u8; 16])> {
    if keys.len() != blocks.len() || keys.iter().any(|k| k.len() != BITS) {
        bail!("the proven powers do not match the record");
    }
    let mut out = Vec::with_capacity(offer_len(blocks.len()));
    let mut share = [0u8; 16];
    for (t, block) in blocks.iter().enumerate() {
        // GHASH multiplies the first block by the highest power.
        let keys = keys[blocks.len() - 1 - t];
        let shifted = shifted(block);
        for (wire, key) in keys.iter().enumerate() {
            let unset = mask(key, t, wire);
            let mut entry = mask(&(*key ^ *delta), t, wire);
            xor(&mut entry, &unset);
            xor(&mut entry, &shifted[wire]);
            out.extend_from_slice(&entry);
            xor(&mut share, &unset);
        }
    }
    Ok((out, share))
}

/// The buyer's side. `macs` are its MACs for the powers of `H`, in the
/// seller's order; a MAC's lowest bit is the bit it proves. Returns the
/// buyer's share of the GHASH.
pub fn answer(macs: &[&[Block]], offer: &[u8]) -> Result<[u8; 16]> {
    if offer.len() != offer_len(macs.len()) || macs.iter().any(|m| m.len() != BITS) {
        bail!("the seller's tag offer does not match the record length it announced");
    }
    let mut share = [0u8; 16];
    let mut entries = offer.chunks_exact(OFFER);
    for t in 0..macs.len() {
        for (wire, mac) in macs[macs.len() - 1 - t].iter().enumerate() {
            let entry = entries.next().expect("length checked");
            xor(&mut share, &mask(mac, t, wire));
            if mac.lsb() {
                xor(&mut share, entry);
            }
        }
    }
    Ok(share)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use aes::cipher::{BlockEncrypt, KeyInit};
    use ghash::{GHash, universal_hash::UniversalHash};

    fn bits(bytes: &[u8]) -> impl Iterator<Item = bool> + '_ {
        bytes.iter().flat_map(|byte| (0..8).map(move |r| (byte >> r) & 1 == 1))
    }

    fn bytes(bits: &[bool]) -> [u8; 16] {
        let mut out = [0u8; 16];
        for (i, bit) in bits.iter().enumerate() {
            out[i / 8] |= (*bit as u8) << (i % 8);
        }
        out
    }

    /// `a · b` by the `ghash` crate.
    pub(crate) fn reference_multiply(a: &[u8; 16], b: &[u8; 16]) -> [u8; 16] {
        let mut ghash = GHash::new(a.into());
        ghash.update(&[(*b).into()]);
        ghash.finalize().into()
    }

    fn sample(seed: u8) -> [u8; 16] {
        let cipher = aes::Aes128::new(&[seed; 16].into());
        let mut block = [seed.wrapping_mul(31); 16].into();
        cipher.encrypt_block(&mut block);
        block.into()
    }

    #[test]
    fn the_multiply_circuit_is_the_ghash_field_product() {
        assert_eq!(MULTIPLY.and_count(), 2187);
        for seed in 0..24u8 {
            let (a, b) = (sample(seed), sample(seed.wrapping_add(101)));
            let out = MULTIPLY.evaluate(bits(&a).chain(bits(&b))).unwrap();
            assert_eq!(bytes(&out), reference_multiply(&a, &b), "seed {seed}");
        }
        let one = { let mut v = [0u8; 16]; v[0] = 0x80; v };
        let a = sample(7);
        assert_eq!(bytes(&MULTIPLY.evaluate(bits(&a).chain(bits(&one))).unwrap()), a);
    }

    #[test]
    fn the_square_circuit_is_the_ghash_field_square() {
        assert_eq!(SQUARE.and_count(), 0);
        for seed in 0..24u8 {
            let a = sample(seed);
            let out = SQUARE.evaluate(bits(&a)).unwrap();
            assert_eq!(bytes(&out), reference_multiply(&a, &a), "seed {seed}");
        }
    }

    #[test]
    fn a_block_times_a_power_of_x_matches_the_field() {
        let block = sample(3);
        let by_wire = shifted(&block);
        for wire in [0usize, 1, 7, 8, 63, 64, 120, 127] {
            // The element with only this wire's bit set.
            let mut unit = [0u8; 16];
            unit[wire / 8] = 1 << (wire % 8);
            assert_eq!(by_wire[wire], reference_multiply(&block, &unit), "wire {wire}");
        }
    }

    /// What each side holds for the powers of `h`: the seller's keys and Δ, the buyer's MACs.
    pub(crate) struct Labels {
        pub delta: Block,
        pub keys: Vec<Vec<Block>>,
        pub macs: Vec<Vec<Block>>,
    }

    pub(crate) fn labels(h: &[u8; 16], n: usize, seed: u8) -> Labels {
        let block = |i: usize, lsb: Option<bool>| {
            let mut b = sample(seed.wrapping_add(i as u8)).map(|v| v ^ (i >> 8) as u8);
            b[..8].copy_from_slice(&(i as u64).to_le_bytes());
            b = sample_from(&b);
            if let Some(lsb) = lsb {
                b[0] = (b[0] & 0xfe) | lsb as u8;
            }
            Block::new(b)
        };
        let delta = block(usize::MAX >> 1, Some(true));
        let mut powers = vec![*h];
        for _ in 1..n {
            powers.push(reference_multiply(powers.last().unwrap(), h));
        }
        let mut keys = Vec::new();
        let mut macs = Vec::new();
        for (q, power) in powers.iter().enumerate() {
            let k: Vec<Block> = (0..BITS).map(|w| block(q * BITS + w, Some(false))).collect();
            let m: Vec<Block> = k.iter().zip(bits(power)).map(|(k, bit)| if bit { *k ^ delta } else { *k }).collect();
            keys.push(k);
            macs.push(m);
        }
        Labels { delta, keys, macs }
    }

    fn sample_from(input: &[u8; 16]) -> [u8; 16] {
        let cipher = aes::Aes128::new(&[0x5a; 16].into());
        let mut block = (*input).into();
        cipher.encrypt_block(&mut block);
        block.into()
    }

    pub(crate) fn refs(labels: &[Vec<Block>]) -> Vec<&[Block]> {
        labels.iter().map(|l| l.as_slice()).collect()
    }

    fn reference_ghash(h: &[u8; 16], blocks: &[[u8; 16]]) -> [u8; 16] {
        let mut ghash = GHash::new(h.into());
        for block in blocks {
            ghash.update(&[(*block).into()]);
        }
        ghash.finalize().into()
    }

    #[test]
    fn the_two_shares_add_up_to_the_ghash_of_the_blocks() {
        let h = sample(11);
        for n in [1usize, 2, 3, 7] {
            let blocks: Vec<[u8; 16]> = (0..n).map(|i| sample(40 + i as u8)).collect();
            let l = labels(&h, n, 9);
            let (sent, seller) = offer(&refs(&l.keys), &l.delta, &blocks).unwrap();
            assert_eq!(sent.len(), offer_len(n));
            let buyer = answer(&refs(&l.macs), &sent).unwrap();
            let mut sum = seller;
            xor(&mut sum, &buyer);
            assert_eq!(sum, reference_ghash(&h, &blocks), "{n} blocks");
        }
    }

    #[test]
    fn an_offer_of_another_length_is_refused() {
        let h = sample(11);
        let blocks: Vec<[u8; 16]> = (0..3).map(|i| sample(40 + i as u8)).collect();
        let l = labels(&h, 3, 9);
        let (sent, _) = offer(&refs(&l.keys), &l.delta, &blocks).unwrap();
        assert!(answer(&refs(&l.macs), &sent[..sent.len() - OFFER]).is_err());
        assert!(answer(&refs(&l.macs[..2]), &sent).is_err());
        assert!(offer(&refs(&l.keys[..2]), &l.delta, &blocks).is_err());
    }

    #[test]
    fn the_buyer_cannot_read_a_block_from_the_offer() {
        // What the buyer holds for a bit is its MAC and the offer entry. For
        // a set bit the entry opens to the seller's mask plus the block, and
        // for a clear bit to nothing: either way a mask of a key the buyer
        // does not hold covers the block.
        let h = sample(11);
        let blocks = [sample(77)];
        let l = labels(&h, 1, 9);
        let (sent, _) = offer(&refs(&l.keys), &l.delta, &blocks).unwrap();
        let by_wire = shifted(&blocks[0]);
        for (wire, entry) in sent.chunks_exact(OFFER).enumerate() {
            let mut opened: [u8; 16] = entry.try_into().unwrap();
            xor(&mut opened, &mask(&l.macs[0][wire], 0, wire));
            assert_ne!(opened, by_wire[wire], "wire {wire} opens to the block");
        }
    }
}
