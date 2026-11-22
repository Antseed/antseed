import assert from 'node:assert/strict'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { PassThrough, type Duplex } from 'node:stream'
import { createServer as tlsCreateServer } from 'node:tls'
import { RelayMux, SellerBlindRelay, type BlindRelayCharge, type KeyedRequestAdmission, type KeyedRequestDecision, type PeerInfo, type Provider, type SerializedHttpRequest, type SerializedHttpResponse } from '@antseed/node'
import { KeyedRelayProcess, resolveKeyedRelayBinary } from '@antseed/keyed-relay'
import { BlindRelayClient, BlindRelayError } from './blind-relay.js'
import { KeyedPlaintextSocket, keyedRequestBody, keyedRevealRanges } from './keyed-relay-client.js'

const peer = { peerId: 'a'.repeat(40) } as PeerInfo
const credential = {
  credentialId: 'cred-1',
  upstream: { host: 'api.example.com', port: 443, baseUrl: 'https://api.example.com/v1/openai', model: 'org/Open-Model', path: '/v1/openai/chat/completions' },
  request: { maxTokensField: 'max_tokens' },
  expiresAt: Date.now() + 600_000,
}

/** A client whose seller answers the credential route with `minted`. */
function clientWith(minted: unknown, openRelayStream: () => Promise<Duplex> = async () => { throw new Error('unreachable') }) {
  const asked: SerializedHttpRequest[] = []
  const client = new BlindRelayClient({
    sendRequest: async (_peer, request) => {
      asked.push(request)
      return { requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(minted)) }
    },
    openRelayStream,
    recordRelayedResponse: () => {},
    keyedRelayBinary: null,
  })
  const send = (path = '/v1/chat/completions') => client.send(peer, 'open-model', {
    requestId: 'r', method: 'POST', path, headers: {}, body: new TextEncoder().encode('{"model":"open-model","messages":[]}'),
  }, undefined)
  return { asked, send }
}

test('a credential naming an upstream other than its TLS host is refused', async () => {
  const { asked, send } = clientWith({ ...credential, upstream: { ...credential.upstream, baseUrl: 'https://evil.example.net/v1' } })
  await assert.rejects(send(), /upstream the relay does not reach/)
  assert.equal(asked[0]!.path, '/_antseed/blind/credential')
})

test('a credential without the request path or the terms the seller checks is refused', async () => {
  const { path: _path, ...noPath } = credential.upstream
  await assert.rejects(clientWith({ ...credential, upstream: noPath }).send(), /malformed credential/)
  const { request: _request, ...noTerms } = credential
  await assert.rejects(clientWith(noTerms).send(), /malformed credential/)
})

test('only chat completions are relayed, and nothing is sent without the sidecar', async () => {
  const opened: PassThrough[] = []
  const open = async () => { const stream = new PassThrough(); opened.push(stream); return stream }
  const { send } = clientWith(credential, open)
  await assert.rejects(send('/v1/embeddings'), (error: unknown) => error instanceof BlindRelayError && error.statusCode === 400 && /relays only \/v1\/chat\/completions/.test(error.message))
  await assert.rejects(send(), /no keyed-relay sidecar installed/)
  assert.equal(opened.length, 2)
  assert.ok(opened.every((stream) => stream.destroyed))
})

// ── The request and the reveal ──────────────────────────────────

test('the request head is the seller\'s, the buyer\'s headers follow it, and the end of the request is announced', () => {
  const written: Buffer[] = []
  const socket = new KeyedPlaintextSocket({ writeApp: (data: Uint8Array) => { written.push(Buffer.from(data)) }, on: () => {} } as never, 2)
  const ends: unknown[] = []
  socket.on('requestWritten', (end) => ends.push(end))
  socket.write('POST /v1/chat/completions HTTP/1.1\r\nhost: example\r\nContent-Type: application/json\r\nAuthorization: Bearer nope\r\nConnection: close\r\ncontent-length: 2\r\n\r\n{')
  assert.deepEqual(ends, [])
  socket.write('}')
  const headers = 'Content-Type: application/json\r\ncontent-length: 2\r\n\r\n'
  assert.equal(Buffer.concat(written).toString(), `${headers}{}`)
  assert.deepEqual(ends, [{ headerLength: headers.length, length: headers.length + 2 }])
})

test('the body ends with the fields the seller checks, and only there', () => {
  const terms = { maxTokensField: 'max_tokens' as const, maxTokens: 1000, pinned: { service_tier: 'default' } }
  const prepared = keyedRequestBody(new TextEncoder().encode(JSON.stringify({
    model: 'mine', max_completion_tokens: 4000, stream: true, stream_options: { include_obfuscation: false }, service_tier: 'priority', n: 1,
    messages: [{ role: 'user', content: 'hi' }],
  })), 'org/open-model', terms)
  const text = new TextDecoder().decode(prepared.body)
  const tail = ',"model":"org/open-model","max_tokens":1000,"n":1,"stream":true,"stream_options":{"include_usage":true},"service_tier":"default"}'
  assert.equal(text, `{"messages":[{"role":"user","content":"hi"}]${tail}`)
  assert.equal(prepared.tailLength, Buffer.byteLength(tail))
  assert.equal(prepared.stream, true)

  // No other fields, no limit asked and no cap: the whole body is the checked fields.
  const bare = keyedRequestBody(new TextEncoder().encode('{"max_tokens":50}'), 'm', { maxTokensField: 'max_completion_tokens' })
  assert.equal(new TextDecoder().decode(bare.body), '{"model":"m","max_completion_tokens":50,"n":1,"stream":false}')
  assert.equal(bare.tailLength, bare.body.length)
  const noLimit = keyedRequestBody(new TextEncoder().encode('{"messages":[]}'), 'm', { maxTokensField: 'max_tokens' })
  assert.equal(new TextDecoder().decode(noLimit.body), '{"messages":[],"model":"m","n":1,"stream":false}')

  assert.throws(() => keyedRequestBody(new TextEncoder().encode('{"n":2}'), 'm', terms), /one choice/)
  assert.throws(() => keyedRequestBody(new TextEncoder().encode('{"max_tokens":-1}'), 'm', terms), /positive integer/)
  assert.throws(() => keyedRequestBody(new TextEncoder().encode('[1]'), 'm', terms), /JSON object/)
})

test('the buyer reveals the status line and the usage to the end, nothing else', () => {
  const sse = Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\ndata: {"choices":[{"delta":{"content":"secret \\"usage\\": 1"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5}}\n\ndata: [DONE]\n\n')
  const text = sse.toString()
  const usageEvent = text.lastIndexOf('data: {"choices":[],')
  assert.deepEqual(keyedRevealRanges(sse, 200), [[0, 15], [usageEvent, sse.length - usageEvent]])
  const json = Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":5}}')
  const at = json.toString().indexOf('"usage":')
  assert.deepEqual(keyedRevealRanges(json, 200), [[0, 15], [at, json.length - at]])
  assert.deepEqual(keyedRevealRanges(Buffer.from('HTTP/1.1 401 Unauthorized\r\n\r\n{"usage":{}}'), 401), [[0, 25]])
  // A stream without usage shows only its end marker.
  const bare = Buffer.from('HTTP/1.1 200 OK\r\n\r\ndata: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
  const done = bare.toString().lastIndexOf('data: [DONE]')
  assert.deepEqual(keyedRevealRanges(bare, 200), [[0, 15], [done, bare.length - done]])
})

const keyedBinary = resolveKeyedRelayBinary()
const fixtureUrl = (name: string) => new URL(`../../../../packages/keyed-relay/test/fixtures/${name}`, import.meta.url)

/** A seller-blind relay with real sidecars, a relay mux pair and a local TLS 1.2 upstream. */
async function keyedStack(admit: (request: KeyedRequestAdmission) => KeyedRequestDecision) {
  const ca = readFileSync(fixtureUrl('ca.pem'), 'utf8')
  /** Every byte each upstream connection received, and the complete requests among them. */
  const received: string[] = []
  const requests: string[] = []
  const upstream = tlsCreateServer({ key: readFileSync(fixtureUrl('localhost.key')), cert: readFileSync(fixtureUrl('localhost.pem')), maxVersion: 'TLSv1.2' }, (socket) => {
    const index = received.push('') - 1
    socket.on('data', (data) => {
      received[index] += data.toString()
      const raw = received[index]!
      const end = raw.indexOf('\r\n\r\n')
      const length = Number(/content-length: (\d+)/i.exec(raw)?.[1] ?? -1)
      if (end < 0 || length < 0 || raw.length < end + 4 + length) return
      requests.push(raw)
      // Chunked, with the end of the body in a TLS record of its own, as upstreams send it.
      const events = 'data: {"model":"org/open-model","choices":[{"delta":{"content":"giraffe"}}]}\n\n'
        + 'data: {"model":"org/open-model","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
      socket.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n${events.length.toString(16)}\r\n${events}\r\n`, () => {
        setTimeout(() => socket.end('0\r\n\r\n'), 20)
      })
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, 'localhost', resolve))
  const port = (upstream.address() as AddressInfo).port
  const charges: BlindRelayCharge[] = []
  const provider = {
    keyedRelayTarget: () => ({
      host: 'localhost', port, baseUrl: `https://localhost:${port}/v1`, path: '/v1/chat/completions', model: 'org/open-model',
      headers: [['Authorization', 'Bearer sk-seller-secret']] as Array<[string, string]>,
      request: { maxTokensField: 'max_tokens' as const, maxTokens: 1000 },
    }),
  } as unknown as Provider
  const seller = new SellerBlindRelay({
    charge: (charge) => { charges.push(charge) },
    spawnKeyedRelay: () => {
      const sidecar = KeyedRelayProcess.spawn('seller', keyedBinary!)
      const start = sidecar.startSeller.bind(sidecar)
      sidecar.startSeller = (config) => start({ ...config, extraRootsPem: ca })
      return sidecar
    },
    usageCostUsdc: (_provider, _service, usage) => BigInt(usage.inputTokens * 10 + usage.outputTokens * 100),
    admitKeyedRequest: admit,
  })
  const ends: Array<{ mux?: RelayMux }> = [{}, {}]
  const conn = (to: number) => ({ send: (data: Uint8Array) => { void ends[to]!.mux!.handleFrame({ type: data[0]!, messageId: 0, payload: data.subarray(9) }) } })
  ends[0]!.mux = new RelayMux(conn(1) as never)
  ends[1]!.mux = new RelayMux(conn(0) as never, { authorize: (streamId, credentialId) => seller.authorize(peer.peerId, streamId, credentialId) })

  const recorded: SerializedHttpResponse[] = []
  const client = new BlindRelayClient({
    sendRequest: async (_peer, request) => {
      const minted = seller.mint(peer.peerId, 'open-model', provider)
      return { requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(minted)) }
    },
    openRelayStream: (_peer, streamId, credentialId) => ends[0]!.mux!.openStream(streamId, credentialId),
    recordRelayedResponse: (_peer, relayed) => { recorded.push(relayed.response) },
    keyedRelayBinary: keyedBinary,
    keyedRelayExtraRootsPem: ca,
  })
  const send = (body: unknown) => client.send(peer, 'open-model', {
    requestId: 'keyed-1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: 'Bearer buyer-must-not-send', 'x-cost-header': 'priority' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  }, undefined)
  return { upstream, received, requests, charges, recorded, send }
}

test('the seller checks the request, adds its key to the buyer\'s TLS session and bills the revealed usage', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  const admissions: KeyedRequestAdmission[] = []
  const stack = await keyedStack((request) => { admissions.push(request); return { admitted: true } })
  try {
    const response = await stack.send({ model: 'open-model', stream: true, max_tokens: 5000, messages: [{ role: 'user', content: 'zebra' }] })
    assert.equal(response.statusCode, 200)
    assert.match(new TextDecoder().decode(response.body), /giraffe/)
    assert.equal(stack.recorded.length, 1)
    // One request: the seller's head with its key, then only the headers the seller relays, and the checked fields last.
    assert.equal(stack.requests.length, 1)
    const sent = stack.requests[0]!
    assert.match(sent, /^POST \/v1\/chat\/completions HTTP\/1\.1\r\nHost: localhost:\d+\r\nAuthorization: Bearer sk-seller-secret\r\nConnection: close\r\n/)
    assert.ok(!sent.includes('buyer-must-not-send') && !sent.includes('x-cost-header'))
    assert.ok(sent.endsWith(',"model":"org/open-model","max_tokens":1000,"n":1,"stream":true,"stream_options":{"include_usage":true}}'), sent)
    // The payment checks saw the capped limit and an estimate from the body's length.
    assert.equal(admissions.length, 1)
    assert.equal(admissions[0]!.maxOutputTokens, 1000)
    assert.ok(admissions[0]!.inputTokens > 0)
    // Billed from the usage the buyer revealed: 12 in, 3 out.
    for (let i = 0; i < 50 && stack.charges.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(stack.charges, [{ buyerPeerId: peer.peerId, requestId: 'keyed-1', service: 'open-model', costUsdc: 420n }])
  } finally {
    stack.upstream.close()
  }
})

test('a refused request never reaches the upstream and is not charged', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  const stack = await keyedStack(() => ({ admitted: false, reason: 'the locked reserve has 0 left' }))
  try {
    await assert.rejects(
      stack.send({ model: 'open-model', stream: true, messages: [{ role: 'user', content: 'zebra' }] }),
      (error: unknown) => error instanceof BlindRelayError && /the locked reserve has 0 left/.test(error.message),
    )
    assert.equal(stack.requests.length, 0)
    // The upstream saw the TLS session, and nothing of the request's body.
    for (const raw of stack.received) assert.ok(!raw.includes('zebra'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(stack.charges, [])
  } finally {
    stack.upstream.close()
  }
})
