import { describe, expect, it } from 'vitest'
import { apiCallTabs, connectTabs, curlSnippet as modelCurl, gatewayApiUrl, gatewayBaseUrl, keySnippets, localBuyerExample, modelCallFormat, modelSnippets, pinnedModelId, serviceApiFormat } from './snippets'

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

describe('gateway endpoint', () => {
  it('is the public URL, else the console origin, plus /v1', () => {
    expect(gatewayApiUrl(gatewayBaseUrl('https://gw.example.test/', 'http://localhost:8479'))).toBe('https://gw.example.test/v1')
    expect(gatewayApiUrl(gatewayBaseUrl(null, 'http://localhost:8479'))).toBe('http://localhost:8479/v1')
  })
})

describe('model API calls', () => {
  const offer = (protocols: string[], provider = 'openai') => ({ provider, protocols })
  it('picks the API by model type and the pinned seller', () => {
    expect(modelCallFormat('text')).toBe('openai-chat-completions')
    expect(modelCallFormat('text', offer(['anthropic-messages'], 'x'))).toBe('anthropic-messages')
    expect(modelCallFormat('text', offer(['openai-responses']))).toBe('openai-responses')
    expect(modelCallFormat('image')).toBe('openai-images')
    expect(modelCallFormat('image', offer(['openai-chat-completions']))).toBe('openai-images')
    expect(modelCallFormat('video')).toBeNull()
    expect(modelCallFormat('decision', offer(['typesafe-systemone']))).toBeNull()
  })
  it('recognizes image sellers', () => {
    expect(serviceApiFormat({ provider: 'fal', apiProtocols: ['openai-images'] })).toBe('openai-images')
  })
  it('curl, Python and JavaScript for a text model, with the key from the environment', () => {
    const tabs = apiCallTabs(BASE, 'open-model-a', 'openai-chat-completions')
    expect(tabs.map((tab) => tab.id)).toEqual(['curl', 'openai-python', 'openai-js'])
    expect(tabs[0]!.code).toContain(`curl ${BASE}/v1/chat/completions`)
    expect(tabs[0]!.code).toContain('"model":"open-model-a"')
    expect(tabs.every((tab) => tab.code.includes('ANTSEED_API_KEY'))).toBe(true)
    expect(apiCallTabs(BASE, 'm', 'anthropic-messages').map((tab) => tab.id)).toContain('anthropic')
  })
  it('the images API for image models', () => {
    const tabs = apiCallTabs(BASE, 'flux-schnell', 'openai-images')
    expect(tabs[0]!.code).toContain(`${BASE}/v1/images/generations`)
    expect(tabs[0]!.code).toContain('"model":"flux-schnell","prompt":')
    expect(tabs[1]!.code).toContain('client.images.generate(model="flux-schnell"')
    expect(tabs[2]!.code).toContain('client.images.generate({')
  })
  it('a pinned image model gets no coding-tool tabs', () => {
    expect(connectTabs(BASE, PEER, 'flux-schnell', 'openai-images', null).map((tab) => tab.id)).toEqual(['curl', 'openai-python', 'openai-js'])
  })
})

describe('localBuyerExample', () => {
  const peer = 'fa1e' + '0'.repeat(36)
  const image = { provider: 'openai', service: 'qwen-image', kind: 'image' as const, apiProtocols: ['openai-images'] }
  const video = { provider: 'fal', service: 'wan-video', kind: 'video' as const, apiProtocols: ['fal-video'] }
  const chat = { provider: 'anthropic', service: 'claude-x', kind: 'text' as const, apiProtocols: ['anthropic-messages'] }

  it('prefers a text model, on the API it speaks, with no key for the local buyer', () => {
    const example = localBuyerExample(peer, [image, chat])!
    expect(example.service).toBe('claude-x')
    expect(example.code).toContain('curl http://localhost:8377/v1/messages \\')
    expect(example.code).toContain(`"model":"${peer}@claude-x"`)
    expect(example.code).not.toContain('Authorization')
  })

  it('an image-only seller gets the images API; a video-only seller no request', () => {
    expect(localBuyerExample(peer, [video, image])!.code).toContain('/v1/images/generations')
    expect(localBuyerExample(peer, [video])).toEqual({ service: 'wan-video', code: null })
    expect(localBuyerExample(peer, [])).toBeNull()
  })
})
