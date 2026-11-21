import { describe, expect, it, vi } from 'vitest'
import { deepInfraBlindRelay, isDeepInfraBaseUrl } from './deepinfra-blind.js'
import plugin from './index.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('deepInfraBlindRelay', () => {
  it('mints a scoped token for the upstream model with the cap and lifetime, and reads its spend', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return String(url).includes('jwtoken=')
        ? json({ spending_current: 6.2e-7, spending_limit: 0.1 })
        : json({ token: 'jwt:scoped' })
    }) as unknown as typeof fetch
    const relay = deepInfraBlindRelay({
      baseUrl: 'https://api.deepinfra.com/v1/openai/',
      apiKey: 'seller-key',
      resolveUpstreamModel: (service) => (service === 'open-model' ? 'org/Open-Model' : service),
      spendLimitUsd: 0.1,
      ttlSeconds: 600,
      fetchImpl,
      now: () => 1_000_000,
    })
    const minted = await relay.mintBlindCredential('open-model')
    expect(minted).toEqual({
      handle: 'jwt:scoped',
      credential: 'jwt:scoped',
      upstream: { host: 'api.deepinfra.com', port: 443, baseUrl: 'https://api.deepinfra.com/v1/openai', model: 'org/Open-Model' },
      expiresAt: 1_000_000 + 600_000 - 5_000,
      spendLimitUsd: 0.1,
    })
    expect(calls[0]!.url).toBe('https://api.deepinfra.com/v1/scoped-jwt')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ models: ['org/Open-Model'], expires_delta: 600, spending_limit: 0.1 })
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer seller-key')

    expect(await relay.blindCredentialSpendUsd('jwt:scoped')).toBe(6.2e-7)
    expect(calls[1]!.url).toBe('https://api.deepinfra.com/v1/scoped-jwt?jwtoken=jwt%3Ascoped')
  })

  it('fails on an upstream error instead of minting nothing silently', async () => {
    const relay = deepInfraBlindRelay({
      baseUrl: 'https://api.deepinfra.com/v1/openai',
      apiKey: 'k',
      resolveUpstreamModel: (s) => s,
      spendLimitUsd: 0.1,
      ttlSeconds: 600,
      fetchImpl: (async () => json({ detail: 'nope' }, 401)) as unknown as typeof fetch,
    })
    await expect(relay.mintBlindCredential('m')).rejects.toThrow('HTTP 401')
  })

  it('is offered only for DeepInfra over https', () => {
    expect(isDeepInfraBaseUrl('https://api.deepinfra.com/v1/openai')).toBe(true)
    expect(isDeepInfraBaseUrl('http://api.deepinfra.com/v1/openai')).toBe(false)
    expect(isDeepInfraBaseUrl('https://api.example.com/v1')).toBe(false)
    const deepinfra = plugin.createProvider({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://api.deepinfra.com/v1/openai', ANTSEED_ALLOWED_SERVICES: 'm' })
    expect(typeof deepinfra.mintBlindCredential).toBe('function')
    expect(deepinfra.blindRelayPriceMultiplier).toBe(1)
    const other = plugin.createProvider({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://api.example.com/v1', ANTSEED_ALLOWED_SERVICES: 'm' })
    expect(other.mintBlindCredential).toBeUndefined()
  })
})
