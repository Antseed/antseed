//! Byte ranges of one direction's plaintext stream (the request after the
//! seller's record, or the response), mapped onto that direction's
//! application-data records.

use anyhow::{Result, anyhow, bail};

use crate::{records::Record, zk::RecordRange};

/// Bytes an encrypted record adds to its plaintext: explicit nonce and tag.
pub const RECORD_OVERHEAD: usize = 8 + 16;

/// A range as the buyer names it to the seller: (record index, start, length).
pub type Triple = (u32, u32, u32);

/// Splits `[start, start + len)` of the stream at record boundaries. `log`
/// holds each record's explicit nonce and plaintext length, in order.
pub fn split(log: &[([u8; 8], usize)], start: usize, len: usize) -> Result<Vec<(Triple, RecordRange)>> {
    let total: usize = log.iter().map(|(_, n)| n).sum();
    if len == 0 || start.checked_add(len).is_none_or(|end| end > total) {
        bail!("range {start}+{len} is outside the {total} bytes sent");
    }
    let mut out = Vec::new();
    let (mut pos, mut offset) = (start, 0usize);
    for (index, (nonce, record_len)) in log.iter().enumerate() {
        let record_end = offset + record_len;
        if pos < record_end && pos < start + len {
            let take = (start + len).min(record_end) - pos;
            out.push(((index as u32, (pos - offset) as u32, take as u32), RecordRange { explicit_nonce: *nonce, start: pos - offset, len: take }));
            pos += take;
        }
        offset = record_end;
    }
    Ok(out)
}

/// One revealed piece on the seller's side: where it starts in the stream, and its ciphertext.
pub struct Placed<'a> {
    pub offset: usize,
    pub ciphertext: &'a [u8],
}

/// The seller's side of a reveal: checks the buyer's triples against the
/// records it relayed itself (application data only) and takes each explicit
/// nonce from those records, never from the buyer.
pub fn place<'a>(records: &'a [Record], triples: &[Triple]) -> Result<(Vec<RecordRange>, Vec<Placed<'a>>)> {
    let lengths: Vec<usize> = records.iter().map(|r| r.body.len().saturating_sub(RECORD_OVERHEAD)).collect();
    let offsets: Vec<usize> = lengths
        .iter()
        .scan(0usize, |acc, len| {
            let start = *acc;
            *acc += len;
            Some(start)
        })
        .collect();
    let mut ranges = Vec::with_capacity(triples.len());
    let mut placed = Vec::with_capacity(triples.len());
    for (index, start, len) in triples {
        let (index, start, len) = (*index as usize, *start as usize, *len as usize);
        let record = records.get(index).ok_or_else(|| anyhow!("reveal names an unknown record"))?;
        if len == 0 || start + len > lengths[index] {
            bail!("reveal range outside its record");
        }
        ranges.push(RecordRange { explicit_nonce: record.body[..8].try_into().unwrap(), start, len });
        placed.push(Placed { offset: offsets[index] + start, ciphertext: &record.body[8 + start..8 + start + len] });
    }
    Ok((ranges, placed))
}

/// Joins revealed pieces that follow one another in the stream, so a range
/// that crosses records reads as the one range the buyer named.
pub fn join(pieces: Vec<(usize, Vec<u8>)>) -> Vec<(usize, Vec<u8>)> {
    let mut joined: Vec<(usize, Vec<u8>)> = Vec::with_capacity(pieces.len());
    for (offset, bytes) in pieces {
        match joined.last_mut() {
            Some((start, so_far)) if *start + so_far.len() == offset => so_far.extend(bytes),
            _ => joined.push((offset, bytes)),
        }
    }
    joined
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_range_across_records() {
        let log = [([1; 8], 10), ([2; 8], 5), ([3; 8], 20)];
        let pieces: Vec<Triple> = split(&log, 8, 10).unwrap().into_iter().map(|(t, _)| t).collect();
        assert_eq!(pieces, vec![(0, 8, 2), (1, 0, 5), (2, 0, 3)]);
        assert!(split(&log, 30, 6).is_err());
        assert!(split(&log, 0, 0).is_err());
    }

    #[test]
    fn places_triples_on_relayed_records_only() {
        let record = |nonce: u8, len: usize| Record { typ: 23, body: [vec![nonce; 8], vec![0xaa; len], vec![0; 16]].concat() };
        let records = [record(1, 10), record(2, 5)];
        let (ranges, placed) = place(&records, &[(1, 1, 4)]).unwrap();
        assert_eq!(ranges[0].explicit_nonce, [2; 8]);
        assert_eq!(placed[0].offset, 11);
        assert_eq!(placed[0].ciphertext.len(), 4);
        assert!(place(&records, &[(1, 2, 4)]).is_err());
        assert!(place(&records, &[(2, 0, 1)]).is_err());
    }

    #[test]
    fn joins_pieces_that_follow_one_another() {
        let pieces = vec![(0, vec![1, 2]), (8, vec![3]), (9, vec![4, 5]), (11, vec![6]), (20, vec![7])];
        assert_eq!(join(pieces), vec![(0, vec![1, 2]), (8, vec![3, 4, 5, 6]), (20, vec![7])]);
    }
}
