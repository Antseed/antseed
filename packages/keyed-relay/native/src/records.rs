//! TLS 1.2 record layer pieces: parsing, AES-128-GCM records with explicit
//! nonces, the handshake facts the seller checks, and the seller's own record:
//! its ciphertext, the blocks its tag is computed over, and the record itself
//! once the tag is known (see `tag`).

use aes_gcm::{
    Aes128Gcm, KeyInit, Nonce,
    aead::{AeadInPlace, generic_array::GenericArray},
};
use anyhow::{Result, anyhow, bail};

pub const CHANGE_CIPHER_SPEC: u8 = 20;
pub const ALERT: u8 = 21;
pub const HANDSHAKE: u8 = 22;
pub const APPLICATION_DATA: u8 = 23;

/// TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 and TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256.
pub const ALLOWED_SUITES: [u16; 2] = [0xc02b, 0xc02f];

/// Largest plaintext in one record.
pub const MAX_PLAINTEXT: usize = 16 * 1024;

#[derive(Debug, Clone)]
pub struct Record {
    pub typ: u8,
    /// The record body: for encrypted records, explicit nonce ‖ ciphertext ‖ tag.
    pub body: Vec<u8>,
}

impl Record {
    /// Appends the record as it goes on the wire: its header, then its body.
    pub fn append_wire(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&header(self.typ, self.body.len()));
        out.extend_from_slice(&self.body);
    }
}

/// Splits a byte stream into records as they complete.
#[derive(Default)]
pub struct RecordParser {
    buf: Vec<u8>,
}

impl RecordParser {
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<Record>> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        let mut offset = 0;
        while self.buf.len() - offset >= 5 {
            let typ = self.buf[offset];
            if !(CHANGE_CIPHER_SPEC..=APPLICATION_DATA).contains(&typ) {
                bail!("not a TLS record (type {typ})");
            }
            let len = u16::from_be_bytes([self.buf[offset + 3], self.buf[offset + 4]]) as usize;
            if len > MAX_PLAINTEXT + 2048 {
                bail!("TLS record too long");
            }
            if self.buf.len() - offset < 5 + len {
                break;
            }
            out.push(Record { typ, body: self.buf[offset + 5..offset + 5 + len].to_vec() });
            offset += 5 + len;
        }
        self.buf.drain(..offset);
        Ok(out)
    }
}

fn aad(seq: u64, typ: u8, len: usize) -> [u8; 13] {
    let mut aad = [0u8; 13];
    aad[..8].copy_from_slice(&seq.to_be_bytes());
    aad[8] = typ;
    aad[9] = 3;
    aad[10] = 3;
    aad[11..].copy_from_slice(&(len as u16).to_be_bytes());
    aad
}

fn header(typ: u8, body_len: usize) -> [u8; 5] {
    let len = (body_len as u16).to_be_bytes();
    [typ, 3, 3, len[0], len[1]]
}

/// One direction's AES-128-GCM keys after the handshake.
pub struct Direction {
    cipher: Aes128Gcm,
    salt: [u8; 4],
    pub seq: u64,
}

impl Direction {
    pub fn new(key: &[u8], iv: &[u8], seq: u64) -> Result<Self> {
        if key.len() != 16 || iv.len() < 4 {
            bail!("unexpected AES-128-GCM key material");
        }
        Ok(Self {
            cipher: Aes128Gcm::new(GenericArray::from_slice(key)),
            salt: iv[..4].try_into().unwrap(),
            seq,
        })
    }

    /// Encrypts one record at the current sequence number, with the sequence number as its explicit nonce.
    pub fn seal(&mut self, typ: u8, plaintext: &[u8]) -> Result<Vec<u8>> {
        let explicit = self.seq.to_be_bytes();
        let mut nonce = [0u8; 12];
        nonce[..4].copy_from_slice(&self.salt);
        nonce[4..].copy_from_slice(&explicit);
        let mut buf = plaintext.to_vec();
        let tag = self
            .cipher
            .encrypt_in_place_detached(Nonce::from_slice(&nonce), &aad(self.seq, typ, plaintext.len()), &mut buf)
            .map_err(|_| anyhow!("record encryption failed"))?;
        self.seq += 1;
        let mut out = Vec::with_capacity(5 + 8 + buf.len() + 16);
        out.extend_from_slice(&header(typ, 8 + buf.len() + 16));
        out.extend_from_slice(&explicit);
        out.extend_from_slice(&buf);
        out.extend_from_slice(&tag);
        Ok(out)
    }

    /// The GCM tag mask of the record at the current sequence number: the
    /// encrypted first counter block. A record with no bytes and no additional
    /// data has a GHASH of zero, so its tag is the mask.
    pub fn tag_mask(&self) -> Result<[u8; 16]> {
        let mut nonce = [0u8; 12];
        nonce[..4].copy_from_slice(&self.salt);
        nonce[4..].copy_from_slice(&self.seq.to_be_bytes());
        let tag = self
            .cipher
            .encrypt_in_place_detached(Nonce::from_slice(&nonce), &[], &mut [])
            .map_err(|_| anyhow!("tag mask failed"))?;
        Ok(tag.into())
    }

    /// Decrypts and authenticates one record at the current sequence number.
    pub fn open(&mut self, record: &Record) -> Result<Vec<u8>> {
        if record.body.len() < 8 + 16 {
            bail!("encrypted record too short");
        }
        let (explicit, rest) = record.body.split_at(8);
        let (ciphertext, tag) = rest.split_at(rest.len() - 16);
        let mut nonce = [0u8; 12];
        nonce[..4].copy_from_slice(&self.salt);
        nonce[4..].copy_from_slice(explicit);
        let mut buf = ciphertext.to_vec();
        self.cipher
            .decrypt_in_place_detached(
                Nonce::from_slice(&nonce),
                &aad(self.seq, record.typ, ciphertext.len()),
                &mut buf,
                GenericArray::from_slice(tag),
            )
            .map_err(|_| anyhow!("record authentication failed"))?;
        self.seq += 1;
        Ok(buf)
    }
}

/// The seller's record, in the pieces it is built from. The seller never
/// holds the session key or the GHASH key: the proof gives it the keystream of
/// its bytes, and the tag comes out of the exchange in `tag`.
pub struct SellerRecord {
    seq: u64,
    ciphertext: Vec<u8>,
}

impl SellerRecord {
    pub fn new(seq: u64, plaintext: &[u8], keystream: &[u8]) -> Result<Self> {
        if keystream.len() < plaintext.len() {
            bail!("keystream shorter than the record");
        }
        Ok(Self { seq, ciphertext: plaintext.iter().zip(keystream).map(|(p, k)| p ^ k).collect() })
    }

    /// How many blocks GHASH reads for a record of `len` bytes: its
    /// additional data, its ciphertext and the two lengths.
    pub fn ghash_block_count(len: usize) -> usize {
        len.div_ceil(16) + 2
    }

    /// The blocks GHASH reads for this record, in order.
    pub fn ghash_blocks(&self) -> Vec<[u8; 16]> {
        let mut blocks = Vec::with_capacity(Self::ghash_block_count(self.ciphertext.len()));
        let mut first = [0u8; 16];
        first[..13].copy_from_slice(&aad(self.seq, APPLICATION_DATA, self.ciphertext.len()));
        blocks.push(first);
        for chunk in self.ciphertext.chunks(16) {
            let mut block = [0u8; 16];
            block[..chunk.len()].copy_from_slice(chunk);
            blocks.push(block);
        }
        let mut lengths = [0u8; 16];
        lengths[..8].copy_from_slice(&(13u64 * 8).to_be_bytes());
        lengths[8..].copy_from_slice(&((self.ciphertext.len() as u64) * 8).to_be_bytes());
        blocks.push(lengths);
        blocks
    }

    /// The record on the wire, with the sequence number as its explicit nonce.
    pub fn with_tag(&self, tag: &[u8; 16]) -> Vec<u8> {
        let mut out = Vec::with_capacity(5 + 8 + self.ciphertext.len() + 16);
        out.extend_from_slice(&header(APPLICATION_DATA, 8 + self.ciphertext.len() + 16));
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.extend_from_slice(&self.ciphertext);
        out.extend_from_slice(tag);
        out
    }
}

/// What the seller checks in the plaintext ServerHello.
#[derive(Debug)]
pub struct ServerHelloFacts {
    pub cipher_suite: u16,
    pub alpn: Option<Vec<u8>>,
}

/// Finds the ServerHello in the server's handshake records sent before its ChangeCipherSpec.
pub fn server_hello(records: &[Record]) -> Result<ServerHelloFacts> {
    let mut stream = Vec::new();
    for record in records {
        if record.typ == CHANGE_CIPHER_SPEC {
            break;
        }
        if record.typ == HANDSHAKE {
            stream.extend_from_slice(&record.body);
        }
    }
    let mut offset = 0;
    while stream.len() >= offset + 4 {
        let typ = stream[offset];
        let len = u32::from_be_bytes([0, stream[offset + 1], stream[offset + 2], stream[offset + 3]]) as usize;
        let body = stream.get(offset + 4..offset + 4 + len).ok_or_else(|| anyhow!("truncated handshake message"))?;
        if typ == 2 {
            return parse_server_hello(body);
        }
        offset += 4 + len;
    }
    bail!("no ServerHello")
}

fn parse_server_hello(body: &[u8]) -> Result<ServerHelloFacts> {
    let short = || anyhow!("truncated ServerHello");
    let mut p = 2 + 32; // version, random
    let sid_len = *body.get(p).ok_or_else(short)? as usize;
    p += 1 + sid_len;
    let suite = body.get(p..p + 2).ok_or_else(short)?;
    let cipher_suite = u16::from_be_bytes([suite[0], suite[1]]);
    p += 2 + 1; // suite, compression
    let mut alpn = None;
    if let Some(ext) = body.get(p..p + 2) {
        let ext_len = u16::from_be_bytes([ext[0], ext[1]]) as usize;
        p += 2;
        let end = p + ext_len;
        let exts = body.get(p..end).ok_or_else(short)?;
        let mut q = 0;
        while exts.len() >= q + 4 {
            let typ = u16::from_be_bytes([exts[q], exts[q + 1]]);
            let len = u16::from_be_bytes([exts[q + 2], exts[q + 3]]) as usize;
            let data = exts.get(q + 4..q + 4 + len).ok_or_else(short)?;
            if typ == 16 {
                // ALPN: list length (2), then one protocol: length (1), name.
                let name_len = *data.get(2).ok_or_else(short)? as usize;
                alpn = Some(data.get(3..3 + name_len).ok_or_else(short)?.to_vec());
            }
            q += 4 + len;
        }
    }
    Ok(ServerHelloFacts { cipher_suite, alpn })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use aes::cipher::BlockEncrypt;
    use ghash::{GHash, universal_hash::UniversalHash};

    pub(crate) const KEY: [u8; 16] = [7u8; 16];
    pub(crate) const IV: [u8; 4] = [1, 2, 3, 4];
    pub(crate) const HEAD: &[u8] = b"POST /v1/chat/completions HTTP/1.1\r\nHost: example.com\r\nAuthorization: Bearer sk-test\r\n";

    fn encrypt(block: [u8; 16]) -> [u8; 16] {
        let mut block = GenericArray::clone_from_slice(&block);
        aes::Aes128::new(GenericArray::from_slice(&KEY)).encrypt_block(&mut block);
        block.into()
    }

    /// The session's client GHASH key, which the seller must never hold.
    pub(crate) fn ghash_key() -> [u8; 16] {
        encrypt([0u8; 16])
    }

    fn counter_block(seq: u64, counter: u32) -> [u8; 16] {
        let mut block = [0u8; 16];
        block[..4].copy_from_slice(&IV);
        block[4..12].copy_from_slice(&seq.to_be_bytes());
        block[12..].copy_from_slice(&counter.to_be_bytes());
        encrypt(block)
    }

    /// The keystream of a record's bytes: counters 2 and up.
    pub(crate) fn keystream(seq: u64, len: usize) -> Vec<u8> {
        (0..len.div_ceil(16)).flat_map(|i| counter_block(seq, 2 + i as u32)).collect()
    }

    fn ghash(key: &[u8], blocks: &[[u8; 16]]) -> [u8; 16] {
        let mut ghash = GHash::new(GenericArray::from_slice(key));
        for block in blocks {
            ghash.update(&[GenericArray::clone_from_slice(block)]);
        }
        ghash.finalize().into()
    }

    #[test]
    fn the_tag_mask_is_the_encrypted_first_counter_block() {
        let direction = Direction::new(&KEY, &IV, 1).unwrap();
        assert_eq!(direction.tag_mask().unwrap(), counter_block(1, 1));
        let direction = Direction::new(&KEY, &IV, 9).unwrap();
        assert_eq!(direction.tag_mask().unwrap(), counter_block(9, 1));
    }

    #[test]
    fn the_sellers_record_matches_aes_gcm() {
        for len in [1usize, 15, 16, 17, 32, HEAD.len()] {
            let plaintext = &HEAD[..len];
            let record = SellerRecord::new(1, plaintext, &keystream(1, len)).unwrap();
            let blocks = record.ghash_blocks();
            assert_eq!(blocks.len(), SellerRecord::ghash_block_count(len));

            let mut tag = ghash(&ghash_key(), &blocks);
            for (t, m) in tag.iter_mut().zip(Direction::new(&KEY, &IV, 1).unwrap().tag_mask().unwrap()) {
                *t ^= m;
            }
            let seller = record.with_tag(&tag);
            let reference = Direction::new(&KEY, &IV, 1).unwrap().seal(APPLICATION_DATA, plaintext).unwrap();
            assert_eq!(seller, reference, "{len} bytes");

            let records = RecordParser::default().push(&seller).unwrap();
            assert_eq!(Direction::new(&KEY, &IV, 1).unwrap().open(&records[0]).unwrap(), plaintext);
        }
    }

    #[test]
    fn a_keystream_shorter_than_the_record_is_refused() {
        assert!(SellerRecord::new(1, HEAD, &keystream(1, HEAD.len())[..HEAD.len() - 1]).is_err());
    }

    /// The buyer's record after the seller's, as the seller relays it.
    pub(crate) fn buyer_record() -> Record {
        let sealed = Direction::new(&KEY, &IV, 2).unwrap().seal(APPLICATION_DATA, b"{\"model\":\"example-model\",\"max_tokens\":16}").unwrap();
        RecordParser::default().push(&sealed).unwrap().remove(0)
    }

    /// How many of a relaying seller's attempts at changing the buyer's
    /// record the upstream would accept: one byte of its ciphertext flipped,
    /// and the tag recomputed with every 16 bytes of `held` taken as the
    /// GHASH key.
    pub(crate) fn accepted_retags(held: &[u8]) -> usize {
        let record = buyer_record();
        let (explicit, rest) = record.body.split_at(8);
        let (ciphertext, tag) = rest.split_at(rest.len() - 16);
        let mut changed = ciphertext.to_vec();
        changed[0] ^= 1;
        let blocks = |ciphertext: &[u8]| {
            // An all-zero keystream leaves the ciphertext as it is.
            SellerRecord::new(2, ciphertext, &vec![0u8; ciphertext.len()]).unwrap().ghash_blocks()
        };
        let (before, after) = (blocks(ciphertext), blocks(&changed));
        held.windows(16)
            .filter(|key| {
                let mut body = explicit.to_vec();
                body.extend_from_slice(&changed);
                body.extend(tag.iter().zip(ghash(key, &before)).zip(ghash(key, &after)).map(|((t, b), a)| t ^ b ^ a));
                Direction::new(&KEY, &IV, 2).unwrap().open(&Record { typ: record.typ, body }).is_ok()
            })
            .count()
    }

    #[test]
    fn whoever_holds_the_ghash_key_can_change_a_record() {
        // Why the seller must never hold it: with the key among what it
        // holds, the changed record is accepted.
        let mut held = keystream(1, HEAD.len());
        assert_eq!(accepted_retags(&held), 0);
        held.extend_from_slice(&ghash_key());
        assert_eq!(accepted_retags(&held), 1);
    }
}
