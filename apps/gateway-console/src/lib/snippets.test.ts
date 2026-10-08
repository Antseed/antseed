import { describe, expect, it } from 'vitest'
import { connectTabs, curlSnippet as modelCurl, keySnippets, modelSnippets, pinnedModelId, serviceApiFormat } from './snippets'

const PEER = `0xFA1E${'0'.repeat(32)}0004`
const BASE = 'https://gw.example.test'

describe('pinnedModelId', () => {
  it('uses the full peer id without 0x, lowercased', () => {
    expect(pinnedModelId(PEER, 'kimi-k2')).toBe(`fa1e${'0'.repeat(32)}0004@kimi-k2`)
    expect(pinnedModelId('abc', ' m ')).toBe('abc@m')
  })
})

describe('serviceApiFormat', () => {
  it('prefers announced protocols, then the provider name', () => {
    expect(serviceApiFormat({ provider: 'anthropic', apiProtocols: ['openai-chat-completions'] })).toBe('openai-chat-completions')
    expect(serviceApiFormat({ provider: 'x', apiProtocols: ['openai-responses'] })).toBe('openai-responses')
    expect(serviceApiFormat({ provider: 'anthropic' })).toBe('anthropic-messages')
    expect(serviceApiFormat({ provider: 'claude-code' })).toBe('anthropic-messages')
    expect(serviceApiFormat({ provider: 'openai-responses' })).toBe('openai-responses')
    expect(serviceApiFormat({ provider: 'openai' })).toBe('openai-chat-completions')
    expect(serviceApiFormat({ provider: 'local-llm' })).toBe('openai-chat-completions')
  })
})

describe('modelCurl', () => {
  const id = pinnedModelId(PEER, 'm')
  it('chat completions', () => {
    const curl = modelCurl(BASE, id, 'openai-chat-completions')
    expect(curl).toContain(`curl ${BASE}/v1/chat/completions \\`)
    expect(curl).toContain('-H "Authorization: Bearer $ANTSEED_API_KEY"')
    expect(curl).toContain(`"model":"${id}","messages":[{"role":"user","content":"Hello"}]`)
  })
  it('responses', () => {
    const curl = modelCurl(BASE, id, 'openai-responses')
    expect(curl).toContain(`${BASE}/v1/responses`)
    expect(curl).toContain(`{"model":"${id}","input":"Hello"}`)
  })
  it('anthropic messages', () => {
    const curl = modelCurl(BASE, id, 'anthropic-messages')
    expect(curl).toContain(`${BASE}/v1/messages`)
    expect(curl).toContain('"max_tokens":1024')
  })
  it('escapes single quotes for the shell', () => {
    expect(modelCurl(BASE, 'p@o\'brien', 'openai-chat-completions')).toContain(`"model":"p@o'\\''brien"`)
  })
})

describe('modelSnippets', () => {
  it('offers model id, curl and the matching SDK', () => {
    const chat = modelSnippets(BASE, PEER, 'm', 'openai-chat-completions')
    expect(chat.map((entry) => entry.label)).toEqual(['Copy model id', 'Copy curl', 'Copy for OpenAI SDK'])
    expect(chat[2]!.code).toContain(`baseURL: '${BASE}/v1'`)
    expect(chat[2]!.code).toContain('chat.completions.create')
    expect(modelSnippets(BASE, PEER, 'm', 'openai-responses')[2]!.code).toContain('responses.create')
    const anthropic = modelSnippets(BASE, PEER, 'm', 'anthropic-messages')
    expect(anthropic[2]!.label).toBe('Copy for Anthropic SDK')
    expect(anthropic[2]!.code).toContain(`baseURL: '${BASE}'`)
    expect(chat.every((entry) => !entry.code.includes('0xfa1e'))).toBe(true)
  })
})

describe('connectTabs', () => {
  const tabs = (format: Parameters<typeof connectTabs>[3], codex: string | null = null) => connectTabs(BASE, PEER, 'kimi-k2', format, codex)
  const id = pinnedModelId(PEER, 'kimi-k2')
  const tab = (list: ReturnType<typeof tabs>, which: string) => list.find((entry) => entry.id === which)!

  it('lists the tabs, Anthropic SDK only for messages services', () => {
    expect(tabs('openai-chat-completions').map((entry) => entry.id)).toEqual(['curl', 'openai-python', 'openai-js', 'codex', 'claude-code', 'openai-compatible'])
    expect(tabs('anthropic-messages').map((entry) => entry.id)).toContain('anthropic')
    expect(tabs('openai-responses').map((entry) => entry.id)).not.toContain('anthropic')
  })
  it('curl', () => {
    expect(tab(tabs('openai-chat-completions'), 'curl').code).toContain(`${BASE}/v1/chat/completions`)
    expect(tab(tabs('anthropic-messages'), 'curl').code).toContain(`${BASE}/v1/messages`)
  })
  it('OpenAI SDK, Python and JS, read the key from the environment', () => {
    const python = tab(tabs('openai-chat-completions'), 'openai-python').code
    expect(python).toContain(`OpenAI(base_url="${BASE}/v1", api_key=os.environ["ANTSEED_API_KEY"])`)
    expect(python).toContain(`model="${id}"`)
    expect(tab(tabs('openai-responses'), 'openai-python').code).toContain('client.responses.create')
    const js = tab(tabs('openai-chat-completions'), 'openai-js').code
    expect(js).toContain('apiKey: process.env.ANTSEED_API_KEY')
    expect(js).toContain(`model: '${id}'`)
  })
  it('Anthropic SDK', () => {
    expect(tab(tabs('anthropic-messages'), 'anthropic').code).toContain(`baseURL: '${BASE}'`)
  })
  it('Codex uses a preset, never the raw model', () => {
    const codex = tab(tabs('openai-chat-completions', '@preset/kimi'), 'codex').code
    expect(codex).toContain('model = "@preset/kimi"')
    expect(codex).toContain(`base_url = "${BASE}/v1"`)
    expect(codex).toContain('env_key = "ANTSEED_API_KEY"')
    expect(codex).toContain('wire_api = "responses"')
    expect(codex).not.toContain(id)
    expect(tab(tabs('openai-responses'), 'codex').code).toContain('model = "@preset/<your-preset>"')
    expect(tab(tabs('openai-responses'), 'codex').code).toContain('wire_api = "responses"')
  })
  it('Claude Code and OpenAI-compatible tools', () => {
    const claude = tab(tabs('anthropic-messages'), 'claude-code').code
    expect(claude).toContain(`ANTHROPIC_BASE_URL="${BASE}"`)
    expect(claude).toContain('ANTHROPIC_AUTH_TOKEN="$ANTSEED_API_KEY"')
    expect(claude).toContain(`ANTHROPIC_MODEL="${id}"`)
    const generic = tab(tabs('openai-chat-completions'), 'openai-compatible').code
    expect(generic).toContain(`${BASE}/v1`)
    expect(generic).toContain(id)
  })
  it('the key dialog still embeds the new secret', () => {
    expect(keySnippets(BASE, 'as_secret')[0]!.code).toContain('Bearer as_secret')
    expect(keySnippets(BASE, 'as_secret')[1]!.code).toContain("apiKey: 'as_secret'")
  })
})
