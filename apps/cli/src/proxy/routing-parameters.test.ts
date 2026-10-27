import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo } from '@antseed/node'
import {
  findMissingRequiredParameters,
  findMissingVideoInputs,
  findUnannouncedRequestParameters,
  parseRequiredParametersHeader,
  requiredVideoInputs,
} from './routing.js'

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

function makePeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    peerId: 'a'.repeat(40),
    lastSeen: 0,
    providers: ['openai'],
    ...overrides,
  } as PeerInfo
}

function makeRequest(body: unknown): { requestId: string; method: string; path: string; headers: Record<string, string>; body: Uint8Array } {
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/images/generations',
    headers: { 'content-type': 'application/json' },
    body: encode(body),
  }
}

const imagePeer = makePeer({
  providerServiceCapabilities: {
    openai: {
      services: {
        'gpt-image-1': {
          outputs: ['image'],
          supportedParameters: ['background', 'output_format', 'quality', 'size'],
        },
      },
    },
  },
})

test('parses normalized required-parameter constraints and rejects malformed values', () => {
  assert.deepEqual(parseRequiredParametersHeader(undefined), [])
  assert.deepEqual(parseRequiredParametersHeader(' Moderation,moderation,output_format '), ['moderation', 'output_format'])
  assert.equal(parseRequiredParametersHeader('moderation,not valid'), null)
  assert.equal(parseRequiredParametersHeader(Array.from({ length: 17 }, (_, index) => `p${index}`).join(',')), null)
})

test('strict required parameters reject absent metadata and accept announced support', () => {
  assert.deepEqual(
    findMissingRequiredParameters(imagePeer, 'openai', 'gpt-image-1', ['quality', 'moderation']),
    ['moderation'],
  )
  assert.deepEqual(
    findMissingRequiredParameters(imagePeer, 'OpenAI', 'GPT Image 1', ['OUTPUT_FORMAT']),
    [],
  )
  assert.deepEqual(
    findMissingRequiredParameters(makePeer(), 'openai', 'gpt-image-1', ['moderation']),
    ['moderation'],
  )
})

test('flags parameters outside the announced list plus protocol baseline', () => {
  const unannounced = findUnannouncedRequestParameters(
    imagePeer,
    'openai',
    'gpt-image-1',
    'openai-images',
    makeRequest({ model: 'gpt-image-1', prompt: 'an ant', n: 2, size: '1024x1024', seed: 42, style: 'vivid' }),
  )
  assert.deepEqual(unannounced.sort(), ['seed', 'style'])
})

test('accepts requests that stay within the announced list', () => {
  const unannounced = findUnannouncedRequestParameters(
    imagePeer,
    'openai',
    'gpt-image-1',
    'openai-images',
    makeRequest({ model: 'gpt-image-1', prompt: 'an ant', background: 'transparent', output_format: 'webp' }),
  )
  assert.deepEqual(unannounced, [])
})

test('flags fal-video fields outside the endpoint input names, except the model', () => {
  const falPeer = makePeer({
    providers: ['fal-video'],
    providerServiceCapabilities: {
      'fal-video': { services: { 'fal-ai/kling-video/v3/pro/image-to-video': { outputs: ['video'], supportedParameters: ['end_image_url', 'prompt', 'start_image_url'] } } },
    },
  })
  const unannounced = findUnannouncedRequestParameters(
    falPeer,
    'fal-video',
    'fal-ai/kling-video/v3/pro/image-to-video',
    'fal-video',
    makeRequest({ model: 'fal-ai/kling-video/v3/pro/image-to-video', prompt: 'an ant', image_url: 'data:' }),
  )
  assert.deepEqual(unannounced, ['image_url'])
})

test('never flags when the peer announces no supportedParameters', () => {
  const silentPeer = makePeer({
    providerServiceCapabilities: {
      openai: { services: { 'gpt-image-1': { outputs: ['image'] } } },
    },
  })
  const request = makeRequest({ model: 'gpt-image-1', prompt: 'an ant', seed: 42 })
  assert.deepEqual(findUnannouncedRequestParameters(silentPeer, 'openai', 'gpt-image-1', 'openai-images', request), [])
  assert.deepEqual(findUnannouncedRequestParameters(makePeer(), 'openai', 'gpt-image-1', 'openai-images', request), [])
})

test('matches provider and service names case-insensitively', () => {
  const unannounced = findUnannouncedRequestParameters(
    imagePeer,
    'OpenAI',
    'GPT-Image-1',
    'openai-images',
    makeRequest({ model: 'gpt-image-1', prompt: 'an ant', seed: 42 }),
  )
  assert.deepEqual(unannounced, ['seed'])
})

test('checks multipart text fields and ignores file parts', () => {
  const boundary = 'test-boundary'
  const multipart = [
    `--${boundary}`,
    'content-disposition: form-data; name="model"',
    '',
    'gpt-image-1',
    `--${boundary}`,
    'content-disposition: form-data; name="seed"',
    '',
    '42',
    `--${boundary}`,
    'content-disposition: form-data; name="image"; filename="in.png"',
    'content-type: image/png',
    '',
    'binary-bytes',
    `--${boundary}--`,
    '',
  ].join('\r\n')
  const unannounced = findUnannouncedRequestParameters(
    imagePeer,
    'openai',
    'gpt-image-1',
    'openai-images',
    {
      requestId: 'req-2',
      method: 'POST',
      path: '/v1/images/edits',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: new TextEncoder().encode(multipart),
    },
  )
  assert.deepEqual(unannounced, ['seed'])
})

test('skips unparseable bodies and requests without a resolved service or protocol', () => {
  const rawRequest = {
    requestId: 'req-3',
    method: 'POST',
    path: '/v1/images/generations',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode('not-json'),
  }
  assert.deepEqual(findUnannouncedRequestParameters(imagePeer, 'openai', 'gpt-image-1', 'openai-images', rawRequest), [])
  const request = makeRequest({ model: 'gpt-image-1', prompt: 'an ant', seed: 42 })
  assert.deepEqual(findUnannouncedRequestParameters(imagePeer, 'openai', null, 'openai-images', request), [])
  assert.deepEqual(findUnannouncedRequestParameters(imagePeer, 'openai', 'gpt-image-1', null, request), [])
})

test('names the video inputs a request carries', () => {
  assert.deepEqual(requiredVideoInputs(makeRequest({ prompt: 'x' })), [])
  assert.deepEqual(requiredVideoInputs(makeRequest({ video_url: 'https://a/b.mp4' })), ['video'])
  assert.deepEqual(requiredVideoInputs(makeRequest({ video_url: '' })), [])
  assert.deepEqual(requiredVideoInputs(makeRequest({ reference_video_urls: ['https://a/b.mp4'] })), ['reference_video'])
  assert.deepEqual(requiredVideoInputs(makeRequest({ reference_video_urls: [] })), [])
})

test('a seller takes a video input when it announces it or lists its field', () => {
  const peer = makePeer({
    providers: ['venice-video'],
    providerServiceCapabilities: {
      'venice-video': {
        services: {
          'minimax-h3-max-recast': { video: { inputs: ['text', 'video'] } },
          'kling-edit': { supportedParameters: ['prompt', 'video_url'] },
          'text-only': { video: { inputs: ['text'] }, supportedParameters: ['prompt'] },
        },
      },
    },
  } as unknown as Partial<PeerInfo>)
  assert.deepEqual(findMissingVideoInputs(peer, 'Venice-Video', 'minimax-h3-max-recast', ['video']), [])
  assert.deepEqual(findMissingVideoInputs(peer, 'venice-video', 'kling-edit', ['video']), [])
  assert.deepEqual(findMissingVideoInputs(peer, 'venice-video', 'text-only', ['video']), ['video'])
  assert.deepEqual(findMissingVideoInputs(peer, 'venice-video', 'unknown', ['video']), ['video'])
  assert.deepEqual(findMissingVideoInputs(peer, 'venice-video', null, ['video']), ['video'])
  assert.deepEqual(findMissingVideoInputs(peer, 'venice-video', 'text-only', []), [])
})
