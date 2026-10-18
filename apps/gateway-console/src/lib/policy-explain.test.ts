import { describe, expect, it } from 'vitest'
import type { Peer, RoutePreview } from '../api/types'
import { exclusionCounts, exclusionsFor, policySentences } from './policy-explain'

const A = 'aa'.repeat(20)
const B = 'bb'.repeat(20)
const C = 'cc'.repeat(20)
const peer = (peerId: string, name: string, tee = false) => ({ peerId, displayName: name, tee, verified: false, reputationScore: null }) as unknown as Peer
const PEERS = [peer(A, 'Alpha', true), peer(B, 'Beta'), peer(C, 'Gamma')]

const candidate = (peerId: string, eligible: boolean, trustScore: number, input = 1): RoutePreview['candidates'][number] => ({
  peerId, displayName: null, rank: eligible ? 1 : null, eligible, reasons: [], inputUsdPerMillion: input, outputUsdPerMillion: 2, trustScore, selection: null,
})

describe('policy sentences', () => {
  it('says each rule in words, with seller names', () => {
    expect(policySentences({
      allowedModels: ['m1'], blockedPeerIds: [B], requireTee: true, minTrustScore: 40, maxInputUsdPerMillion: 2,
      modelRoutes: { m1: { peerIds: [A, C], strict: true } }, sort: 'price', preferFreePeers: true,
    }, PEERS)).toEqual([
      'Only these models: m1.',
      'Never uses Beta.',
      'Only sellers running in a TEE.',
      'Only sellers with trust 40 or more.',
      'Pays at most $2.00/M input.',
      'For m1: tries Alpha, then Gamma first, and no other seller.',
      'Ranks the cheapest seller first.',
      'Free sellers first.',
    ])
  })

  it('is empty for no policy, and names peer lists', () => {
    expect(policySentences(null, PEERS)).toEqual([])
    expect(policySentences({ allowedPeerLists: ['pl_1'] }, PEERS, [{ id: 'pl_1', name: 'Ours', description: null, peerIds: [A], createdAt: 0 }]))
      .toEqual(['Only these sellers: the “Ours” list.'])
  })
})

describe('which level keeps a seller out', () => {
  const preview: RoutePreview = {
    model: 'm1', modelAllowed: true, policy: {},
    sources: [
      { level: 'buyer', id: null, policy: { minTrustScore: 60 } },
      { level: 'gateway', id: null, policy: { blockedPeerIds: [B] } },
      { level: 'workspace', id: 'ws', policy: { maxInputUsdPerMillion: 2 } },
    ],
    candidates: [candidate(A, true, 90), candidate(B, false, 90), candidate(C, false, 50, 3)],
  }

  it('names every level that excludes it, top to bottom', () => {
    expect(exclusionsFor(preview, preview.candidates[1]!, PEERS)).toEqual([{ level: 'gateway', levelId: null, rule: 'blocks it' }])
    expect(exclusionsFor(preview, preview.candidates[2]!, PEERS).map((entry) => `${entry.level}: ${entry.rule}`)).toEqual([
      'buyer: requires trust 60+ (it has 50)',
      'workspace: caps input at $2.00/M (it asks $3.00)',
    ])
    expect(exclusionsFor(preview, preview.candidates[0]!, PEERS)).toEqual([])
  })

  it('counts what each level keeps out', () => {
    expect(Object.fromEntries(exclusionCounts(preview, PEERS))).toEqual({ buyer: 1, gateway: 1, workspace: 1 })
  })
})
