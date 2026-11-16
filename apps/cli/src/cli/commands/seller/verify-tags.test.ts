import assert from 'node:assert/strict'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import type { SellerProviderConfig } from '../../../config/types.js'
import {
  PROBE_PROMPT,
  classifyReply,
  isFailingResult,
  listClaimedServices,
  probeService,
  resolveUpstreamTarget,
  type ClaimedService,
} from './verify-tags.js'
import { TOKEN_ALPHABET, crc32, randomToken, renderTokenBitmap, renderTokenPng } from './token-image.js'

const TOKEN = 'K7WR'

function openAiProvider(services: SellerProviderConfig['services']): SellerProviderConfig {
  return { plugin: 'openai', baseUrl: 'https://upstream.example.com/', apiKeyEnv: 'EXAMPLE_KEY', services }
}

interface Captured { url: string; init: RequestInit }

function mockFetch(reply: unknown, status = 200): { fetchImpl: (url: string, init: RequestInit) => Promise<Response>; calls: Captured[] } {
  const calls: Captured[] = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status })
    },
  }
}

function chatReply(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content } }] }
}

function claimed(provider: SellerProviderConfig, service: string): ClaimedService {
  return { provider: 'inference', service, config: provider.services[service]!, providerConfig: provider }
}

const env = { EXAMPLE_KEY: 'sk-example' }

test('only enabled text services with the multimodal tag or image input are probed', () => {
  const provider = openAiProvider({
    'vision-model': { categories: ['chat', 'multimodal'] },
    'image-input-model': { capabilities: { inputs: ['text', 'image'] } },
    'text-model': { categories: ['chat'], capabilities: { inputs: ['text'] } },
    'untagged-model': {},
    'disabled-vision-model': { categories: ['multimodal'], enabled: false },
    'image-editor': { capabilities: { inputs: ['text', 'image'], outputs: ['image'] } },
  })
  const services = listClaimedServices({ providers: { inference: provider } }).map((entry) => entry.service)
  assert.deepEqual(services, ['vision-model', 'image-input-model'])
  assert.deepEqual(
    listClaimedServices({ providers: { inference: provider } }, { services: ['image-input-model'] }).map((entry) => entry.service),
    ['image-input-model'],
  )
  assert.deepEqual(listClaimedServices({ providers: { inference: provider } }, { providers: ['other'] }), [])
})

test('a reply with the token passes, and the request carries the image and key', async () => {
  const provider = openAiProvider({ 'vision-model': { upstreamModel: 'example-org/vision-model', categories: ['multimodal'] } })
  const { fetchImpl, calls } = mockFetch(chatReply(` ${TOKEN.toLowerCase()} `))
  const result = await probeService(claimed(provider, 'vision-model'), { fetchImpl, env, makeToken: () => TOKEN })

  assert.equal(result.status, 'pass')
  assert.equal(isFailingResult(result), false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, 'https://upstream.example.com/v1/chat/completions')
  assert.equal((calls[0]!.init.headers as Record<string, string>)['authorization'], 'Bearer sk-example')
  const body = JSON.parse(String(calls[0]!.init.body))
  assert.equal(body.model, 'example-org/vision-model')
  const [text, image] = body.messages[0].content
  assert.equal(text.text, PROBE_PROMPT)
  const png = Buffer.from(image.image_url.url.replace('data:image/png;base64,', ''), 'base64')
  assert.deepEqual(png, renderTokenPng(TOKEN))
})

test('NO_IMAGE and refusals fail', async () => {
  const provider = openAiProvider({ 'vision-model': { categories: ['multimodal'] } })
  for (const reply of ['NO_IMAGE', "I'm sorry, but I can't see images. I am a text-only model."]) {
    const { fetchImpl } = mockFetch(chatReply(reply))
    const result = await probeService(claimed(provider, 'vision-model'), { fetchImpl, env, makeToken: () => TOKEN })
    assert.equal(result.status, 'fail', reply)
    assert.equal(isFailingResult(result), true)
  }
})

test('a wrong answer fails and a plausible 4-character guess is suspicious', async () => {
  assert.equal(classifyReply(TOKEN, 'The image shows a bright cyan divider on a white background.').status, 'fail')
  assert.equal(classifyReply(TOKEN, '').status, 'fail')
  const provider = openAiProvider({ 'vision-model': { categories: ['multimodal'] } })
  const { fetchImpl } = mockFetch(chatReply('X7WR'))
  const result = await probeService(claimed(provider, 'vision-model'), { fetchImpl, env, makeToken: () => TOKEN })
  assert.equal(result.status, 'suspicious')
  assert.equal(isFailingResult(result), true)
})

test('an upstream error is reported and counts as unproven', async () => {
  const provider = openAiProvider({ 'vision-model': { categories: ['multimodal'] } })
  const { fetchImpl } = mockFetch('{"error":{"message":"model does not accept images"}}', 400)
  const result = await probeService(claimed(provider, 'vision-model'), { fetchImpl, env, makeToken: () => TOKEN })
  assert.equal(result.status, 'error')
  assert.match(result.detail, /HTTP 400/)
  assert.equal(isFailingResult(result), true)
})

test('anthropic services are probed through the Messages API', async () => {
  const provider: SellerProviderConfig = { plugin: 'anthropic', services: { 'example-claude': { capabilities: { inputs: ['image'] } } } }
  const { fetchImpl, calls } = mockFetch({ content: [{ type: 'text', text: TOKEN }] })
  const result = await probeService(claimed(provider, 'example-claude'), {
    fetchImpl, env: { ANTHROPIC_API_KEY: 'sk-ant-example' }, makeToken: () => TOKEN,
  })
  assert.equal(result.status, 'pass')
  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages')
  assert.equal((calls[0]!.init.headers as Record<string, string>)['x-api-key'], 'sk-ant-example')
})

test('plugins without a chat upstream are skipped, not failed', async () => {
  const provider: SellerProviderConfig = { plugin: 'claude-code', services: { 'example-claude': { categories: ['multimodal'] } } }
  const { fetchImpl, calls } = mockFetch(chatReply(TOKEN))
  const result = await probeService(claimed(provider, 'example-claude'), { fetchImpl, env })
  assert.equal(result.status, 'unsupported')
  assert.equal(isFailingResult(result), false)
  assert.equal(calls.length, 0)
})

test('upstream target honours pathRewrite and the plugin default key', () => {
  const target = resolveUpstreamTarget(
    { plugin: 'openai', baseUrl: 'https://upstream.example.com/api', pathRewrite: { '/v1/chat/completions': '/v4/chat/completions' }, services: {} },
    { OPENAI_API_KEY: 'sk-default' },
  )
  assert.deepEqual(target, { api: 'openai-chat', url: 'https://upstream.example.com/api/v4/chat/completions', apiKey: 'sk-default' })
})

test('tokens are drawn from the unambiguous alphabet and render as a valid PNG', () => {
  const token = randomToken()
  assert.match(token, new RegExp(`^[${TOKEN_ALPHABET}]{4}$`))

  const png = renderTokenPng(TOKEN)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const { width, height, pixels } = renderTokenBitmap(TOKEN)
  assert.equal(png.readUInt32BE(16), width)
  assert.equal(png.readUInt32BE(20), height)
  // IHDR CRC covers the chunk type and data.
  assert.equal(png.readUInt32BE(29), crc32(png.subarray(12, 29)))
  const idatLength = png.readUInt32BE(33)
  const raw = inflateSync(png.subarray(41, 41 + idatLength))
  assert.equal(raw.length, (width + 1) * height)
  assert.ok(pixels.includes(0) && pixels.includes(255))
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})
