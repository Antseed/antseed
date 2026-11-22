//! TLS 1.2 record layer pieces: parsing, AES-128-GCM records with explicit
//! nonces, the handshake facts the seller checks, and the GHASH tag the seller
//! computes for its own record.

use aes_gcm::{
    Aes128Gcm, KeyInit, Nonce,
    aead::{AeadInPlace, generic_array::GenericArray},
};
use anyhow::{Result, anyhow, bail};
use ghash::{GHash, universal_hash::UniversalHash};

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

/// The seller's record, built from the keystream and the tag mask the proof
/// gave it and the client GHASH key: the seller never holds the session key.
pub fn seal_with_keystream(seq: u64, explicit_nonce: [u8; 8], plaintext: &[u8], keystream: &[u8], tag_mask: &[u8; 16], ghash_key: &[u8; 16]) -> Result<Vec<u8>> {
    if keystream.len() < plaintext.len() {
        bail!("keystream shorter than the record");
    }
    let ciphertext: Vec<u8> = plaintext.iter().zip(keystream).map(|(p, k)| p ^ k).collect();
    let mut ghash = GHash::new(GenericArray::from_slice(ghash_key));
    ghash.update_padded(&aad(seq, APPLICATION_DATA, plaintext.len()));
    ghash.update_padded(&ciphertext);
    let mut lengths = [0u8; 16];
    lengths[..8].copy_from_slice(&((13u64) * 8).to_be_bytes());
    lengths[8..].copy_from_slice(&((ciphertext.len() as u64) * 8).to_be_bytes());
    ghash.update(&[GenericArray::clone_from_slice(&lengths)]);
    let mut tag: [u8; 16] = ghash.finalize().into();
    for (t, m) in tag.iter_mut().zip(tag_mask) {
        *t ^= m;
    }
    let mut out = Vec::with_capacity(5 + 8 + ciphertext.len() + 16);
    out.extend_from_slice(&header(APPLICATION_DATA, 8 + ciphertext.len() + 16));
    out.extend_from_slice(&explicit_nonce);
    out.extend_from_slice(&ciphertext);
    out.extend_from_slice(&tag);
    Ok(out)
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
mod tests {
    use super::*;

    #[test]
    fn keystream_record_matches_aes_gcm() {
        use aes::cipher::{BlockEncrypt, KeyInit as _};
        let key = [7u8; 16];
        let iv = [1u8, 2, 3, 4];
        let seq = 1u64;
        let plaintext = b"POST /v1/chat/completions HTTP/1.1\r\nHost: example.com\r\nAuthorization: Bearer sk-test\r\n";

        let aes = aes::Aes128::new(GenericArray::from_slice(&key));
        let block = |counter: u32| {
            let mut b = [0u8; 16];
            b[..4].copy_from_slice(&iv);
            b[4..12].copy_from_slice(&seq.to_be_bytes());
            b[12..].copy_from_slice(&counter.to_be_bytes());
            let mut ga = GenericArray::clone_from_slice(&b);
            aes.encrypt_block(&mut ga);
            let out: [u8; 16] = ga.into();
            out
        };
        let mut h = GenericArray::clone_from_slice(&[0u8; 16]);
        aes.encrypt_block(&mut h);
        let h: [u8; 16] = h.into();
        let mask = block(1);
        let keystream: Vec<u8> = (0..plaintext.len().div_ceil(16)).flat_map(|i| block(2 + i as u32)).collect();

        let seller = seal_with_keystream(seq, seq.to_be_bytes(), plaintext, &keystream, &mask, &h).unwrap();
        let mut direction = Direction::new(&key, &iv, seq).unwrap();
        let reference = direction.seal(APPLICATION_DATA, plaintext).unwrap();
        assert_eq!(seller, reference);

        let mut parser = RecordParser::default();
        let records = parser.push(&seller).unwrap();
        let mut reader = Direction::new(&key, &iv, seq).unwrap();
        assert_eq!(reader.open(&records[0]).unwrap(), plaintext);
    }
}
