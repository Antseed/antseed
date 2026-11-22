import { describe, expect, it } from 'vitest'
import { openAiKeyedRelayTarget } from './keyed-relay.js'
import plugin from './index.js'

describe('openAiKeyedRelayTarget', () => {
  it('targets the chat completions URL the relay would call, with the seller key and extra headers', () => {
    const target = openAiKeyedRelayTarget({
      baseUrl: 'https://openrouter.ai/api',
      apiKey: 'seller-key',
      resolveUpstreamModel: (service) => (service === 'open-model' ? 'org/open-model' : service),
      extraHeaders: { 'HTTP-Referer': 'https://example.com', Authorization: 'ignored' },
    })!
    expect(target('open-model')).toEqual({
      host: 'openrouter.ai',
      port: 443,
      baseUrl: 'https://openrouter.ai/api',
      path: '/api/v1/chat/completions',
      model: 'org/open-model',
      headers: [['Authorization', 'Bearer seller-key'], ['HTTP-Referer', 'https://example.com']],
      request: { maxTokensField: 'max_tokens' },
    })
  })

  it('sets the request terms: OpenAI\'s limit field and standard tier, a cap, and the seller\'s pins', () => {
    const openAi = openAiKeyedRelayTarget({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', resolveUpstreamModel: (s) => s, maxTokens: 4096 })!
    expect(openAi('gpt-x').request).toEqual({ maxTokensField: 'max_completion_tokens', maxTokens: 4096, pinned: { service_tier: 'default' } })
    const pinned = openAiKeyedRelayTarget({ baseUrl: 'https://api.example.com', apiKey: 'k', resolveUpstreamModel: (s) => s, pinned: { reasoning_effort: 'low' } })!
    expect(pinned('m').request).toEqual({ maxTokensField: 'max_tokens', pinned: { reasoning_effort: 'low' } })
    expect(() => openAiKeyedRelayTarget({ baseUrl: 'https://api.example.com', apiKey: 'k', resolveUpstreamModel: (s) => s, pinned: { model: 'x' } })).toThrow('malformed')
    expect(() => openAiKeyedRelayTarget({ baseUrl: 'https://api.example.com', apiKey: 'k', resolveUpstreamModel: (s) => s, maxTokens: 0 })).toThrow('malformed')
  })

  it('follows a path rewrite and a port, and is off for plain http', () => {
    const rewritten = openAiKeyedRelayTarget({
      baseUrl: 'https://api.example.com:8443/',
      apiKey: 'k',
      resolveUpstreamModel: (service) => service,
      pathRewrite: { '/v1/chat/completions': '/v4/chat/completions' },
    })!
    expect(rewritten('m')).toMatchObject({ host: 'api.example.com', port: 8443, path: '/v4/chat/completions' })
    expect(openAiKeyedRelayTarget({ baseUrl: 'http://localhost:11434', apiKey: 'k', resolveUpstreamModel: (s) => s })).toBeNull()
  })

  it('is on for every https upstream, and is off when the seller injects body fields', () => {
    const keyed = plugin.createProvider({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://api.example.com', ANTSEED_ALLOWED_SERVICES: 'm' })
    expect(typeof keyed.keyedRelayTarget).toBe('function')
    const injecting = plugin.createProvider({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://api.example.com', ANTSEED_ALLOWED_SERVICES: 'm', OPENAI_BODY_INJECT_JSON: '{"provider":{"only":["x"]}}' })
    expect(injecting.keyedRelayTarget).toBeUndefined()
    const capped = plugin.createProvider({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://api.example.com', ANTSEED_ALLOWED_SERVICES: 'm', OPENAI_KEYED_RELAY_MAX_TOKENS: '2048', OPENAI_KEYED_RELAY_PINNED_JSON: '{"service_tier":"default"}' })
    expect(capped.keyedRelayTarget!('m')!.request).toEqual({ maxTokensField: 'max_tokens', maxTokens: 2048, pinned: { service_tier: 'default' } })
    expect(() => plugin.createProvider({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://api.example.com', ANTSEED_ALLOWED_SERVICES: 'm', OPENAI_KEYED_RELAY_MAX_TOKENS: '1.5' })).toThrow('OPENAI_KEYED_RELAY_MAX_TOKENS')
  })

  it('stays on for a Venice upstream, whose provider is wrapped', () => {
    const venice = plugin.createProvider({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://api.venice.ai/api', OPENAI_PROVIDER_FLAVOR: 'venice', ANTSEED_ALLOWED_SERVICES: 'm' })
    expect(venice.keyedRelayTarget?.('m')).toMatchObject({ host: 'api.venice.ai', path: '/api/v1/chat/completions', model: 'm' })
    const injecting = plugin.createProvider({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://api.venice.ai/api', OPENAI_PROVIDER_FLAVOR: 'venice', ANTSEED_ALLOWED_SERVICES: 'm', OPENAI_BODY_INJECT_JSON: '{"venice_parameters":{"include_venice_system_prompt":false}}' })
    expect(injecting.keyedRelayTarget).toBeUndefined()
  })
})
