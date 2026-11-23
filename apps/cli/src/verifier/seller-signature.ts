import { encodeResponseAuthSigningPayload, hexToBytes, verifySignature } from '@antseed/node'
import { keccak256 } from 'ethers'
import type { ProxyAuditEvidenceExchangeV1 } from './proxy-evidence.js'
import { peerComparisonKey } from './utils.js'

/** An answer as evidence stores it: the record the seller signed and the exact bytes it signed over. */
export type StoredSignedAnswer = Pick<ProxyAuditEvidenceExchangeV1['responseAuth'], 'record' | 'signedPreimages'>

/**
 * Why a stored answer is not the seller's own, or null when it is: the stored request and response hash to what the
 * record names, the record is what was signed, and the signature is the peer's the record names. Whose answer it
 * had to be is another check (`assertBoundToSeller`).
 *
 * The buyer proxy checks this when the answer arrives. Evidence read from another auditor's publication has not
 * been through that proxy, and its hash only proves which file was published, so its reader checks it again.
 */
export function sellerSignatureProblem(answer: StoredSignedAnswer): string | null {
  const { record, signedPreimages } = answer
  if (!record || !signedPreimages) return 'it holds no signed record with the bytes it was signed over'
  try {
    if (typeof signedPreimages.requestBase64 !== 'string' || typeof signedPreimages.responseBase64 !== 'string') {
      return 'its signed bytes are missing'
    }
    if (keccak256(Buffer.from(signedPreimages.requestBase64, 'base64')) !== record.requestHash) {
      return 'its stored request is not the one the seller signed for'
    }
    if (keccak256(Buffer.from(signedPreimages.responseBase64, 'base64')) !== record.responseHash) {
      return 'its stored response is not the one the seller signed'
    }
    const { signature, receivedAt: _receivedAt, verified: _verified, verificationError: _verificationError, ...unsigned } = record
    const signed = encodeResponseAuthSigningPayload(unsigned)
    if (Buffer.from(signed).toString('base64') !== signedPreimages.responseAuthSigningBase64) {
      return 'its stored signing bytes are not those of its record'
    }
    const peerId = peerComparisonKey(record.sellerPeerId)
    return verifySignature(peerId, hexToBytes(signature), signed) ? null : 'its signature is not the seller\'s'
  } catch {
    return 'its signed record cannot be read'
  }
}
