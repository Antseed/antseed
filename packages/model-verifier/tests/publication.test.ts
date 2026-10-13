import { canonicalHashBytes32, canonicalJsonStringify } from '@antseed/fingerprints'
import { describe, expect, it } from 'vitest'
import { resolveAuditReference } from '../src/publication.js'
import { testReference } from './fixtures.js'

const CID = 'bafybeigdyrztestcid'
const GATEWAY = 'https://gateway.example.test/ipfs'

function publishedAudit() {
  const small = testReference(100)
  const large = testReference(200)
  const evidence = {
    version: 1,
    kind: 'antseed-verifier-model-audit-evidence',
    model: 'open-model-70b',
    references: [
      { referenceId: small.referenceId, queryProfileHash: 'q', probeCount: 100, path: 'references/small.json' },
      { referenceId: large.referenceId, queryProfileHash: 'q', probeCount: 200, path: 'references/large.json' },
      { referenceId: 'missing', queryProfileHash: 'q', probeCount: 500, path: null },
    ],
  }
  const evidenceHash = canonicalHashBytes32(evidence)
  const files: Record<string, unknown> = {
    'publication.json': {
      kind: 'antseed-verifier-ipfs-publication',
      evidenceHash,
      evidencePath: 'runs/run-1/models/open-model-70b/evidence.json',
    },
    'runs/run-1/models/open-model-70b/evidence.json': evidence,
    'runs/run-1/models/open-model-70b/references/small.json': small,
    'runs/run-1/models/open-model-70b/references/large.json': large,
  }
  const requested: string[] = []
  const fetchImpl = (async (url: string) => {
    requested.push(url)
    const path = url.slice(`${GATEWAY}/${CID}/`.length)
    const body = files[path]
    return body === undefined
      ? new Response('not found', { status: 404 })
      : new Response(canonicalJsonStringify(body))
  }) as unknown as typeof fetch
  return { files, evidenceHash, large, fetchImpl, requested }
}

describe('resolveAuditReference', () => {
  it('loads the largest exported reference from a published audit', async () => {
    const { evidenceHash, large, fetchImpl, requested } = publishedAudit()
    const resolved = await resolveAuditReference(`ipfs://${CID}`, { fetchImpl, ipfsGateway: GATEWAY, evidenceHash })
    expect(resolved).toMatchObject({ cid: CID, model: 'open-model-70b', evidenceHash })
    expect(resolved.reference.referenceId).toBe(large.referenceId)
    expect(requested.at(-1)).toBe(`${GATEWAY}/${CID}/runs/run-1/models/open-model-70b/references/large.json`)
  })

  it('rejects evidence that does not match the on-chain hash', async () => {
    const { fetchImpl } = publishedAudit()
    await expect(resolveAuditReference(CID, { fetchImpl, ipfsGateway: GATEWAY, evidenceHash: `0x${'0'.repeat(64)}` }))
      .rejects.toThrow(/does not match/)
  })

  it('rejects publication paths that escape the CID root', async () => {
    const { files, fetchImpl } = publishedAudit()
    ;(files['publication.json'] as { evidencePath: string }).evidencePath = '../other/evidence.json'
    await expect(resolveAuditReference(CID, { fetchImpl, ipfsGateway: GATEWAY })).rejects.toThrow(/escapes/)
  })
})
