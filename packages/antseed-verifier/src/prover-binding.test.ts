import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'

// Echo report_data back as the quote, so a test reads which binding the prover minted.
vi.mock('./collect/configfs.js', () => ({
  generateTdxQuote: (reportData: Uint8Array) => reportData,
}))

import prover from './prover.js'
import { CHANNEL_BINDING_HEADER, computeReportData, decodeAttestResponse, encodeAttestRequest } from './shared.js'
import { decodeTeeTdxEvidence } from './caps/tee-tdx.js'

const PEER = 'ab'.repeat(20)
const NONCE = randomBytes(32)
const BINDING = 'c'.repeat(64)
const NODE = 'seller-node-tee-genuine'

let savedPeer: string | undefined
beforeEach(() => {
  savedPeer = process.env['ANTSEED_TEE_PEER_ID']
  process.env['ANTSEED_TEE_PEER_ID'] = PEER
})
afterEach(() => {
  if (savedPeer === undefined) delete process.env['ANTSEED_TEE_PEER_ID']
  else process.env['ANTSEED_TEE_PEER_ID'] = savedPeer
})

/** The node quote's report_data for one attestation round, or undefined when the cap was omitted. */
async function nodeReportData(bindChannel: boolean, headers: Record<string, string>): Promise<Buffer | undefined> {
  const resp = await prover.prove({
    method: 'POST',
    path: '/_antseed/attest/antseed-verifier',
    headers: { 'content-type': 'application/json', ...headers },
    body: encodeAttestRequest(NONCE, [NODE], bindChannel),
  })
  const evidence = decodeAttestResponse(resp.body)[NODE]
  return evidence ? Buffer.from(decodeTeeTdxEvidence(evidence).quote) : undefined
}

describe('prover — connection binding', () => {
  it('binds the node quote to the connection the seller node names, when the buyer asks', async () => {
    const rd = await nodeReportData(true, { [CHANNEL_BINDING_HEADER]: BINDING })
    expect(rd?.equals(computeReportData(NONCE, PEER, BINDING))).toBe(true)
  })

  it('keeps the nonce+peerId binding for buyers that do not ask (older buyers)', async () => {
    const rd = await nodeReportData(false, { [CHANNEL_BINDING_HEADER]: BINDING })
    expect(rd?.equals(computeReportData(NONCE, PEER))).toBe(true)
  })

  it('omits the node quote rather than minting it unbound when the connection has no binding', async () => {
    expect(await nodeReportData(true, {})).toBeUndefined()
  })
})
