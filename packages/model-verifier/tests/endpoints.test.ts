import { describe, expect, it } from 'vitest'
import { AnthropicMessagesEndpoint } from '../src/endpoints/anthropic-messages.js'
import { OpenAIChatEndpoint } from '../src/endpoints/openai-chat.js'

const request = { model: 'm', system: 's', user: 'u', temperature: 0, topP: 1, maxTokens: 160 }

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init: RequestInit }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as typeof fetch
}

describe('OpenAIChatEndpoint', () => {
  it('posts a chat completion and returns text, usage and raw bytes', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const endpoint = new OpenAIChatEndpoint({
      baseUrl: 'https://example.test/v1/',
      apiKey: 'secret',
      fetchImpl: fakeFetch(200, {
        choices: [{ message: { content: '(1) 42' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }, seen),
    })
    const result = await endpoint.call(request)
    expect(seen[0]!.url).toBe('https://example.test/v1/chat/completions')
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer secret')
    const body = JSON.parse(new TextDecoder().decode(seen[0]!.init.body as Uint8Array)) as Record<string, unknown>
    expect(body).toMatchObject({ model: 'm', temperature: 0, top_p: 1, max_tokens: 160 })
    expect(result).toMatchObject({ ok: true, text: '(1) 42', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 3 } })
  })

  it('marks rate limits retryable and client errors terminal', async () => {
    const limited = await new OpenAIChatEndpoint({ baseUrl: 'https://x/v1', fetchImpl: fakeFetch(429, 'slow down', []) }).call(request)
    expect(limited).toMatchObject({ ok: false, status: 429, retryable: true })
    const rejected = await new OpenAIChatEndpoint({ baseUrl: 'https://x/v1', fetchImpl: fakeFetch(400, 'bad', []) }).call(request)
    expect(rejected).toMatchObject({ ok: false, status: 400, retryable: false })
  })
})

describe('AnthropicMessagesEndpoint', () => {
  it('posts a messages request with the system prompt split out', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const endpoint = new AnthropicMessagesEndpoint({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'secret',
      fetchImpl: fakeFetch(200, {
        content: [{ type: 'text', text: '(1) 7' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }, seen),
    })
    const result = await endpoint.call(request)
    expect(seen[0]!.url).toBe('https://api.example.test/v1/messages')
    expect((seen[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('secret')
    const body = JSON.parse(new TextDecoder().decode(seen[0]!.init.body as Uint8Array)) as Record<string, unknown>
    expect(body).toMatchObject({ system: 's', messages: [{ role: 'user', content: 'u' }] })
    expect(result).toMatchObject({ ok: true, text: '(1) 7', finishReason: 'end_turn' })
  })
})
