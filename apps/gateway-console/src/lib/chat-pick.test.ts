import { describe, expect, it } from 'vitest'
import type { ChatModel, ChatModelPeer, RoutePreview } from '../api/types'
import { autoPick, pickModels, pickPeers, verdictsFrom } from './chat-pick'

const peer = (peerId: string, input: number, output: number, reputation: number, extra: Partial<ChatModelPeer> = {}): ChatModelPeer => ({
  peerId, name: peerId, toolUse: true, reasoning: false, vision: false, tee: false, inputUsdPerMillion: input, outputUsdPerMillion: output, cachedInputUsdPerMillion: null, reputation, freeTier: null, ...extra,
})
const model = (id: string, offers: number, input: number | null, extra: Partial<ChatModel> = {}): ChatModel => ({
  id, name: id.toUpperCase(), toolUse: true, reasoning: false, vision: false, free: false, freeForStakers: false, tee: false, offers, inputUsdPerMillion: input, outputUsdPerMillion: input, peers: [], ...extra,
})

describe('chat pickers', () => {
  it('filters models by every chosen capability and sorts them', () => {
    const models = [model('a', 3, 1), model('b', 9, 0, { free: true }), model('c', 1, 0.5, { reasoning: true, free: true })]
    expect(pickModels(models, new Set(), 'popular').map((m) => m.id)).toEqual(['b', 'a', 'c'])
    expect(pickModels(models, new Set(['free']), 'price').map((m) => m.id)).toEqual(['b', 'c'])
    expect(pickModels(models, new Set(['free', 'reasoning']), 'name').map((m) => m.id)).toEqual(['c'])
  })

  it('orders sellers like automatic routing, skipped ones last, and finds the auto pick', () => {
    const peers = [peer('aa', 0.06, 0.19, 74), peer('bb', 0, 0, 58, { toolUse: false }), peer('cc', 0.05, 0.1, 70)]
    const preview: RoutePreview = {
      model: 'm', policy: {}, sources: [], modelAllowed: true,
      candidates: [
        { peerId: 'AA', displayName: null, rank: 2, eligible: true, reasons: [], inputUsdPerMillion: 0.06, outputUsdPerMillion: 0.19, trustScore: 74, selection: null },
        { peerId: 'bb', displayName: null, rank: null, eligible: false, reasons: ['buyer config: trust 58 below 60'], inputUsdPerMillion: 0, outputUsdPerMillion: 0, trustScore: 58, selection: null },
        { peerId: 'cc', displayName: null, rank: 1, eligible: true, reasons: [], inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.1, trustScore: 70, selection: null },
      ],
    }
    const verdicts = verdictsFrom(preview)
    expect(pickPeers(peers, new Set(), 'auto', verdicts).map((p) => p.peerId)).toEqual(['cc', 'aa', 'bb'])
    expect(pickPeers(peers, new Set(['free']), 'auto', verdicts).map((p) => p.peerId)).toEqual(['bb'])
    expect(pickPeers(peers, new Set(), 'price', verdicts).map((p) => p.peerId)).toEqual(['bb', 'cc', 'aa'])
    expect(autoPick(preview)?.peerId).toBe('cc')
    expect(autoPick({ ...preview, modelAllowed: false })).toBeNull()
  })
})
