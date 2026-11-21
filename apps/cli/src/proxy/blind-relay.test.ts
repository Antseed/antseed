import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { RelayMux, type PeerInfo, type SerializedHttpRequest, type SerializedHttpResponse } from '@antseed/node'
import { BlindRelayClient, upstreamPath, upstreamRequest } from './blind-relay.js'

const peer = { peerId: 'a'.repeat(40) } as PeerInfo
const credential = {
  credentialId: 'cred-1',
  credential: 'scoped-token',
  upstream: { host: 'api.example.com', port: 443, baseUrl: 'https://api.example.com/v1/openai', model: 'org/Open-Model' },
  expiresAt: Date.now() + 600_000,
  spendLimitUsd: 0.1,
}

test('upstream paths keep the base URL path and drop the buyer /v1', () => {
  assert.equal(upstreamPath('https://api.example.com/v1/openai', '/v1/chat/completions'), '/v1/openai/chat/completions')
  assert.equal(upstreamPath('https://api.example.com/', '/v1/chat/completions?x=1'), '/chat/completions?x=1')
  assert.throws(() => upstreamPath('https://api.example.com/v1', '/_antseed/anything'), /only \/v1\//)
})

test('the upstream gets its model, the scoped credential, usage in a stream, and no Antseed headers', () => {
  const sent = upstreamRequest({
    requestId: 'r',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { authorization: 'Bearer buyer-key', 'x-antseed-service': 'open-model', 'content-type': 'application/json', 'user-agent': 'tool' },
    body: new TextEncoder().encode(JSON.stringify({ model: 'open-model', stream: true, messages: [] })),
  }, credential)
  assert.equal(sent.headers['authorization'], 'Bearer scoped-token')
  assert.equal(sent.headers['host'], 'api.example.com')
  assert.equal(sent.headers['user-agent'], 'tool')
  assert.equal(sent.headers['x-antseed-service'], undefined)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(sent.body)), {
    model: 'org/Open-Model', stream: true, messages: [], stream_options: { include_usage: true },
  })
})

/** A buyer and a seller RelayMux back to back, the seller relaying to `port` on this machine. */
function relayPair(port: number) {
  const ends: Array<{ mux?: RelayMux }> = [{}, {}]
  // Each send is one whole frame: a 9-byte header (type, message id, length), then the payload.
  const conn = (to: number) => ({
    send: (data: Uint8Array) => {
      void ends[to]!.mux!.handleFrame({ type: data[0]!, messageId: 0, payload: data.subarray(9) })
    },
  })
  const closed: string[] = []
  ends[0]!.mux = new RelayMux(conn(1) as never)
  ends[1]!.mux = new RelayMux(conn(0) as never, {
    authorize: async (streamId, credentialId) => {
      if (credentialId !== 'cred-1') throw new Error('unknown credential')
      return { host: '127.0.0.1', port, onClose: () => closed.push(streamId) }
    },
  })
  return { buyer: ends[0]!.mux!, closed }
}

test('a request goes to the upstream through the relay and is priced from its own answer', async () => {
  const seen: Array<{ path: string; headers: IncomingMessage['headers']; body: string }> = []
  const upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      res.end('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const { buyer, closed } = relayPair((upstream.address() as AddressInfo).port)
  const minted: SerializedHttpRequest[] = []
  const recorded: Array<{ requestId: string; service: string; response: SerializedHttpResponse }> = []
  const client = new BlindRelayClient({
    sendRequest: async (_peer, request) => {
      minted.push(request)
      return { requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(credential)) }
    },
    openRelayStream: (_peer, streamId, credentialId) => buyer.openStream(streamId, credentialId),
    recordRelayedResponse: (_peer, relayed) => { recorded.push(relayed) },
    secureConnect: (stream) => stream,
  })
  try {
    const chunks: string[] = []
    const response = await client.send(peer, 'open-model', {
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'open-model', stream: true, messages: [{ role: 'user', content: 'hello' }] })),
    }, undefined, { onResponseChunk: (chunk) => { if (chunk.data.length) chunks.push(new TextDecoder().decode(chunk.data)) } })

    assert.equal(minted.length, 1)
    assert.equal(minted[0]!.path, '/_antseed/blind/credential')
    assert.equal(seen[0]!.path, '/v1/openai/chat/completions')
    assert.equal(seen[0]!.headers['authorization'], 'Bearer scoped-token')
    assert.match(seen[0]!.body, /"model":"org\/Open-Model"/)
    assert.equal(response.statusCode, 200)
    assert.match(chunks.join(''), /"content":"hi"/)
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]!.requestId, 'req-1')
    assert.equal(recorded[0]!.service, 'open-model')
    assert.match(new TextDecoder().decode(recorded[0]!.response.body), /"prompt_tokens":5/)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(closed, ['req-1'])
  } finally {
    upstream.close()
  }
})

test('a credential naming an upstream other than its TLS host is refused', async () => {
  const client = new BlindRelayClient({
    sendRequest: async (_peer, request) => ({
      requestId: request.requestId,
      statusCode: 200,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ ...credential, upstream: { ...credential.upstream, baseUrl: 'https://evil.example.net/v1' } })),
    }),
    openRelayStream: async () => { throw new Error('unreachable') },
    recordRelayedResponse: () => {},
  })
  await assert.rejects(client.send(peer, 'open-model', {
    requestId: 'r', method: 'POST', path: '/v1/chat/completions', headers: {}, body: new Uint8Array(),
  }, undefined), /upstream the relay does not reach/)
})
