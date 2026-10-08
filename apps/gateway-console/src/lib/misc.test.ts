import { describe, expect, it } from 'vitest'
import type { ChainInfo, Peer, UsageReport } from '../api/types'
import { contractAddress, explorerTxUrl, isSetAddress, sameAddress, ZERO_ADDRESS } from './chain'
import { headersToText, textToHeaders } from './headers'
import { filterPeers, inputPrice, isFreePeer } from './peers'
import { isValidSlug, parseParams, slugify } from './presets'
import { parseLocation } from './router'
import { gatewayBaseUrl, keySnippets } from './snippets'
import { dailySeries } from './usage'

const chain: ChainInfo = {
  chainId: 8453, name: 'Base', rpcUrl: 'https://rpc.example', explorerUrl: 'https://scan.example/',
  contracts: { USDC: '0x0000000000000000000000000000000000000101', AntseedDeposits: '0x0000000000000000000000000000000000000102', usageRewards: 'not-an-address' },
}

describe('chain helpers', () => {
  it('finds contracts by alias, case-insensitively', () => {
    expect(contractAddress(chain, 'usdc')).toBe('0x0000000000000000000000000000000000000101')
    expect(contractAddress(chain, 'deposits')).toBe('0x0000000000000000000000000000000000000102')
    expect(contractAddress(chain, 'usageRewards')).toBeNull()
    expect(contractAddress(null, 'usdc')).toBeNull()
  })
  it('compares addresses and links transactions', () => {
    expect(sameAddress('0xAbC', '0xabc')).toBe(true)
    expect(isSetAddress(ZERO_ADDRESS)).toBe(false)
    expect(explorerTxUrl(chain, '0xhash')).toBe('https://scan.example/tx/0xhash')
  })
})

describe('headers field', () => {
  it('round-trips and validates', () => {
    expect(textToHeaders(headersToText({ Authorization: 'Bearer x', 'x-team': 'a:b' }))).toEqual({ Authorization: 'Bearer x', 'x-team': 'a:b' })
    expect(() => textToHeaders('no colon')).toThrow(/Line 1/)
    expect(textToHeaders('\n\n')).toEqual({})
  })
})

describe('presets', () => {
  it('slugifies and validates', () => {
    expect(slugify('  Code Review (v2)! ')).toBe('code-review-v2')
    expect(isValidSlug('code-review')).toBe(true)
    expect(isValidSlug('Code')).toBe(false)
  })
  it('parses params JSON objects only', () => {
    expect(parseParams('')).toEqual({})
    expect(parseParams('{"temperature":0.2}')).toEqual({ temperature: 0.2 })
    expect(() => parseParams('[1]')).toThrow(/object/)
    expect(() => parseParams('{')).toThrow(/valid JSON/)
  })
})

describe('peers', () => {
  const peer = (id: string, overrides: Partial<Peer>): Peer => ({
    peerId: id, displayName: null, services: [], trustScore: null, reputationScore: null, verified: false, tee: false, stakeAnts: null,
    usageShareBps: null, washFlagged: false, lastSeen: null, health: { failureStreak: 0, coolingDownUntil: null }, latencyMsP50: null, requests24h: 0, ...overrides,
  })
  const svc = (service: string, price: number) => ({ provider: 'p', service, inputUsdPerMillion: price, outputUsdPerMillion: price, cachedInputUsdPerMillion: null, categories: [] })
  const peers = [
    peer('0xfa1e01', { displayName: 'Alpha', tee: true, verified: true, services: [svc('m1', 2), svc('m2', 1)] }),
    peer('0xfa1e02', { displayName: 'Free', services: [svc('m1', 0)] }),
  ]
  it('computes prices per model', () => {
    expect(inputPrice(peers[0]!)).toBe(1)
    expect(inputPrice(peers[0]!, 'm1')).toBe(2)
    expect(isFreePeer(peers[1]!)).toBe(true)
  })
  it('filters', () => {
    const base = { search: '', model: '', tee: false, verified: false, free: false }
    expect(filterPeers(peers, { ...base, tee: true }).map((p) => p.displayName)).toEqual(['Alpha'])
    expect(filterPeers(peers, { ...base, free: true }).map((p) => p.displayName)).toEqual(['Free'])
    expect(filterPeers(peers, { ...base, model: 'm2' }).map((p) => p.displayName)).toEqual(['Alpha'])
    expect(filterPeers(peers, { ...base, search: 'fa1e02' }).map((p) => p.displayName)).toEqual(['Free'])
  })
})

describe('usage series', () => {
  it('zero-fills days', () => {
    const report = { from: 0, to: 0, totals: {} as never, groups: [{ group: '2026-10-02', label: '2026-10-02', requests: 3, failedRequests: 0, spent: '1.5', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }] } as UsageReport
    const points = dailySeries(report, Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 3, 12))
    expect(points.map((point) => point.value)).toEqual([0, 1.5, 0])
  })
})

describe('routing and snippets', () => {
  it('parses console locations', () => {
    expect(parseLocation('/console/keys', '?a=1', '#tok')).toMatchObject({ page: 'keys', rest: [], hash: 'tok' })
    expect(parseLocation('/console/').page).toBe('')
    expect(parseLocation('/console/setup').page).toBe('setup')
  })
  it('builds snippets against the gateway URL', () => {
    expect(gatewayBaseUrl('https://gw.example.com/', 'http://localhost')).toBe('https://gw.example.com')
    expect(gatewayBaseUrl(null, 'http://127.0.0.1:8379')).toBe('http://127.0.0.1:8379')
    const snippets = keySnippets('https://gw.example.com', 'as_secret')
    expect(snippets.map((s) => s.id)).toEqual(['curl', 'openai', 'anthropic'])
    expect(snippets[0]!.code).toContain('https://gw.example.com/v1/chat/completions')
    expect(snippets[1]!.code).toContain("baseURL: 'https://gw.example.com/v1'")
    expect(snippets[2]!.code).toContain("authToken: 'as_secret'")
  })
})
