//! Messages between the two sidecars, sent over the zero-knowledge context.

use serde::{Deserialize, Serialize};

/// Bumped on any change to the sidecar protocol.
pub const PROTOCOL_VERSION: u32 = 2;

/// Seller → buyer, first: the protocol version and the length of the seller's record.
#[derive(Debug, Serialize, Deserialize)]
pub struct Hello {
    pub version: u32,
    pub injected_len: u32,
}

/// Seller → buyer: the seller's record is on the wire; the buyer writes from sequence 2.
#[derive(Debug, Serialize, Deserialize)]
pub struct Injected {
    pub seq: u64,
}

/// Buyer → seller once its whole request is written: the request's length
/// (its plaintext after the seller's record) and the request ranges it
/// reveals, as (index of the buyer's application-data record, start, length).
/// The seller forwards nothing of the request before it admits it.
#[derive(Debug, Serialize, Deserialize)]
pub struct RequestReveal {
    pub length: u64,
    pub ranges: Vec<(u32, u32, u32)>,
}

/// Seller → buyer: whether the seller forwarded the request, and why not.
#[derive(Debug, Serialize, Deserialize)]
pub struct RequestVerdict {
    pub admitted: bool,
    pub reason: String,
}

/// Buyer → seller after the response: response ranges to reveal, as
/// (index of the server's application-data record, start, length).
#[derive(Debug, Serialize, Deserialize)]
pub struct RevealRequest {
    pub ranges: Vec<(u32, u32, u32)>,
}

/// Seller → buyer: the reveal is done.
#[derive(Debug, Serialize, Deserialize)]
pub struct Done;
