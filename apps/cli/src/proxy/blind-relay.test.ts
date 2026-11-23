import assert from 'node:assert/strict'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough, type Duplex } from 'node:stream'
import { createServer as tlsCreateServer } from 'node:tls'
import { RelayMux, SellerBlindRelay, type BlindRelayCharge, type InterruptedRelayedResponse, type KeyedRequestAdmission, type KeyedRequestDecision, type PeerInfo, type Provider, type RelayedResponse, type SerializedHttpRequest, type SerializedHttpResponse, type SerializedHttpResponseChunk } from '@antseed/node'
import { KeyedRelayProcess, resolveKeyedRelayBinary } from '@antseed/keyed-relay'
import { BlindRelayClient, BlindRelayError, type BlindRelayCallbacks, type BlindRelayDeps } from './blind-relay.js'
import { KeyedPlaintextSocket, keyedRequestBody, keyedRevealRanges } from './keyed-relay-client.js'

const peer = { peerId: 'a'.repeat(40) } as PeerInfo
const credential = {
  credentialId: 'cred-1',
  upstream: { host: 'api.example.com', port: 443, baseUrl: 'https://api.example.com/v1/openai', model: 'org/Open-Model', path: '/v1/openai/chat/completions' },
  request: { maxTokensField: 'max_tokens' },
  expiresAt: Date.now() + 600_000,
}

/** A client whose seller answers the credential route with `minted`. */
function clientWith(minted: unknown, openRelayStream: () => Promise<Duplex> = async () => { throw new Error('unreachable') }, keyedRelayBinary: string | null = '/never-spawned') {
  const asked: SerializedHttpRequest[] = []
  const client = new BlindRelayClient({
    sendRequest: async (_peer, request) => {
      asked.push(request)
      return { requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(minted)) }
    },
    openRelayStream,
    recordRelayedResponse: () => {},
    recordInterruptedRelayedResponse: () => {},
    keyedRelayBinary,
  })
  const send = (path = '/v1/chat/completions', body = '{"model":"open-model","messages":[]}') => client.send(peer, 'open-model', {
    requestId: 'r', method: 'POST', path, headers: {}, body: new TextEncoder().encode(body),
  }, undefined)
  return { asked, client, send }
}

/** An error that says the buyer itself could not send the request: the seller is not counted as failing. */
const buyerFault = (message: RegExp, code?: string) => (error: unknown): boolean => {
  const fault = error as { attribution?: string; code?: string; message: string }
  return fault.attribution === 'buyer' && (code === undefined || fault.code === code) && message.test(fault.message)
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

test('a request the relay cannot carry fails as the buyer\'s own, before anything is asked of the seller', async () => {
  const opened: PassThrough[] = []
  const open = async () => { const stream = new PassThrough(); opened.push(stream); return stream }
  const { asked, client, send } = clientWith(credential, open, null)
  await assert.rejects(send('/v1/embeddings'), buyerFault(/carries only \/v1\/chat\/completions/, 'invalid-request'))
  await assert.rejects(send(undefined, '{"model":"open-model","messages":[],"n":2}'), buyerFault(/one choice per request/, 'invalid-request'))
  await assert.rejects(send(undefined, 'not json'), buyerFault(/JSON request body/, 'invalid-request'))
  // Without the sidecar this buyer can use no seller-blind service: no seller is asked, none is blamed.
  await assert.rejects(send(), buyerFault(/no keyed-relay sidecar installed/))
  assert.match(client.unavailable() ?? '', /no keyed-relay sidecar installed/)
  assert.equal(asked.length, 0)
  assert.equal(opened.length, 0)
})

test('credentials that stay busy are the buyer\'s own stream limit', async () => {
  let now = 0
  const client = new BlindRelayClient({
    sendRequest: async (_peer, request) => ({ requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ ...credential, credentialId: `cred-${now}`, expiresAt: 600_000 })) }),
    openRelayStream: async () => { throw new Error('credential busy') },
    recordRelayedResponse: () => {},
    recordInterruptedRelayedResponse: () => {},
    keyedRelayBinary: '/sidecar',
    now: () => now,
    sleep: async (ms) => { now += ms },
  })
  await assert.rejects(client.send(peer, 'open-model', {
    requestId: 'r', method: 'POST', path: '/v1/chat/completions', headers: {}, body: new TextEncoder().encode('{"model":"open-model","messages":[]}'),
  }, undefined), buyerFault(/every relay credential stayed busy/, 'buyer-stream-limit'))
})

const chat = (requestId = 'r'): SerializedHttpRequest => ({
  requestId, method: 'POST', path: '/v1/chat/completions', headers: {}, body: new TextEncoder().encode('{"model":"open-model","messages":[]}'),
})
const minted = (request: SerializedHttpRequest, fields: object = {}): SerializedHttpResponse => ({
  requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ ...credential, ...fields })),
})
/** `work`'s rejection, or a failure when it has not settled within `ms`. */
const settlesWithin = <T>(work: Promise<T>, ms: number): Promise<T> => Promise.race([
  work,
  new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms)),
])

test('a request bound to an attested connection gets its credential and its stream on that connection only', async () => {
  const mints: Array<string | undefined> = []
  const opens: Array<string | undefined> = []
  const changed = Object.assign(new Error('not the connection its TEE attestation covered'), { attribution: 'buyer', code: 'buyer-tee-connection-changed' })
  const client = new BlindRelayClient({
    sendRequest: async (_peer, request, _identity, channelBinding) => { mints.push(channelBinding); return minted(request, { credentialId: `cred-${mints.length}` }) },
    openRelayStream: async (_peer, _streamId, _credentialId, _identity, channelBinding) => {
      opens.push(channelBinding)
      throw channelBinding === 'session-1' ? changed : new Error('the seller is restarting')
    },
    recordRelayedResponse: () => {},
    recordInterruptedRelayedResponse: () => {},
    keyedRelayBinary: '/never-spawned',
  })
  // A request that needs no attestation leaves a credential behind.
  await assert.rejects(client.send(peer, 'open-model', chat(), undefined), /the seller is restarting/)
  assert.deepEqual([mints, opens], [[undefined], [undefined]])
  // The bound request does not use it: its credential comes over the attested connection, and so does its stream.
  await assert.rejects(client.send(peer, 'open-model', chat(), undefined, {}, { channelBinding: 'session-1' }), (error: unknown) => error === changed)
  assert.deepEqual(mints, [undefined, 'session-1'])
  assert.deepEqual(opens, [undefined, 'session-1'])
})

test('a seller whose credentials cannot be used is given up on, not asked without end', async () => {
  const endless = (count: number): void => { if (count > 50) throw new Error('asked without end') }
  // Every credential is about to expire.
  let asked = 0
  const expiring = new BlindRelayClient({
    sendRequest: async (_peer, request) => { endless(++asked); return minted(request, { expiresAt: 10_000 }) },
    openRelayStream: async () => { throw new Error('unreachable') },
    recordRelayedResponse: () => {},
    recordInterruptedRelayedResponse: () => {},
    keyedRelayBinary: '/never-spawned',
    now: () => 0,
  })
  await assert.rejects(expiring.send(peer, 'open-model', chat(), undefined), (error: unknown) => error instanceof BlindRelayError && /about to expire/.test(error.message))
  assert.equal(asked, 1)

  // The seller forgets every credential it mints.
  asked = 0
  const forgetful = new BlindRelayClient({
    sendRequest: async (_peer, request) => { endless(++asked); return minted(request, { credentialId: `cred-${asked}` }) },
    openRelayStream: async () => { throw new Error('unknown credential') },
    recordRelayedResponse: () => {},
    recordInterruptedRelayedResponse: () => {},
    keyedRelayBinary: '/never-spawned',
  })
  await assert.rejects(forgetful.send(peer, 'open-model', chat(), undefined), (error: unknown) => error instanceof BlindRelayError && /no credential a stream opens on/.test(error.message))
  assert.ok(asked <= 3, `asked for ${asked} credentials`)

  // A seller that refused this buyer is not asked again.
  asked = 0
  const refused = new BlindRelayClient({
    sendRequest: async (_peer, request) => { endless(++asked); return minted(request) },
    openRelayStream: async () => { throw new Error('this seller no longer relays requests for this buyer') },
    recordRelayedResponse: () => {},
    recordInterruptedRelayedResponse: () => {},
    keyedRelayBinary: '/never-spawned',
  })
  await assert.rejects(refused.send(peer, 'open-model', chat(), undefined), (error: unknown) => error instanceof BlindRelayError && /no longer relays requests/.test(error.message))
  assert.equal(asked, 1)
})

test('a request given up while the relay is set up stops there', async () => {
  let asked = 0
  let opened = 0
  const destroyed: string[] = []
  let answerMint: (() => void) | null = null
  let answerOpen: ((stream: Duplex) => void) | null = null
  const client = new BlindRelayClient({
    sendRequest: (_peer, request) => { asked += 1; return new Promise((resolve) => { answerMint = () => resolve(minted(request)) }) },
    openRelayStream: () => { opened += 1; return new Promise((resolve) => { answerOpen = resolve }) },
    recordRelayedResponse: () => {},
    recordInterruptedRelayedResponse: () => {},
    keyedRelayBinary: '/never-spawned',
  })
  const givenUp = (error: unknown): boolean => error instanceof BlindRelayError && /given up/.test(error.message)

  // Already given up: the seller is asked for nothing.
  await assert.rejects(settlesWithin(client.send(peer, 'open-model', chat(), undefined, {}, { signal: AbortSignal.abort() }), 500), givenUp)
  assert.equal(asked, 0)

  // Given up while the seller mints: the request ends, and the credential is kept for the next one.
  const minting = new AbortController()
  const first = client.send(peer, 'open-model', chat('r1'), undefined, {}, { signal: minting.signal })
  await new Promise((resolve) => setTimeout(resolve, 10))
  minting.abort()
  await assert.rejects(settlesWithin(first, 500), givenUp)
  answerMint!()
  await new Promise((resolve) => setTimeout(resolve, 10))

  // Given up while the stream opens: a stream that opens afterwards is closed.
  const opening = new AbortController()
  const second = client.send(peer, 'open-model', chat('r2'), undefined, {}, { signal: opening.signal })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual([asked, opened], [1, 1])
  opening.abort()
  await assert.rejects(settlesWithin(second, 500), givenUp)
  const late = new PassThrough()
  late.on('close', () => destroyed.push('late'))
  answerOpen!(late)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(destroyed, ['late'])
})

test('a request given up while its sidecar sets up the session ends at once: the sidecar is killed and the stream closed', { skip: process.platform === 'win32' && 'the stand-in sidecar is a script' }, async () => {
  const givenUp = (error: unknown): boolean => error instanceof BlindRelayError && /given up/.test(error.message)
  const spawned: KeyedRelayProcess[] = []
  const spawn = KeyedRelayProcess.spawn
  KeyedRelayProcess.spawn = (...args: Parameters<typeof spawn>) => {
    const relay = spawn.apply(KeyedRelayProcess, args)
    spawned.push(relay)
    return relay
  }
  try {
    // The sidecar takes its start and never says `ready`: a handshake that hangs.
    const hanging = (openRelayStream: BlindRelayDeps['openRelayStream']) => new BlindRelayClient({
      sendRequest: async (_peer, request) => minted(request),
      openRelayStream,
      recordRelayedResponse: () => {},
      recordInterruptedRelayedResponse: () => {},
      keyedRelayBinary: fixtureUrl('silent-sidecar.mjs').pathname,
    })

    const stream = new PassThrough()
    const waiting = new AbortController()
    const first = hanging(async () => stream).send(peer, 'open-model', chat('r1'), undefined, {}, { signal: waiting.signal })
    for (let waited = 0; spawned.length === 0 && waited < 1000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(spawned.length, 1, 'the sidecar was not started')
    const sidecar = spawned[0]!
    assert.equal(sidecar.exited, null)
    const exited = new Promise<{ code: number | null }>((resolve) => sidecar.once('exit', resolve))
    waiting.abort()
    // Not after the 30 s the session may take to set up.
    await assert.rejects(settlesWithin(first, 1000), givenUp)
    assert.ok(stream.destroyed, 'the relay stream stayed open')
    // Killed, not left to notice that its peer is gone.
    assert.equal((await settlesWithin(exited, 1000)).code, null)

    // Given up just as the stream opened: no sidecar is started for it.
    const late = new PassThrough()
    const opening = new AbortController()
    const second = hanging(() => {
      const opened = Promise.resolve(late)
      void opened.then(() => {}).then(() => opening.abort())
      return opened
    }).send(peer, 'open-model', chat('r2'), undefined, {}, { signal: opening.signal })
    await assert.rejects(settlesWithin(second, 1000), givenUp)
    assert.equal(spawned.length, 1, 'a sidecar was started for a request already given up')
    assert.ok(late.destroyed, 'the relay stream stayed open')
  } finally {
    KeyedRelayProcess.spawn = spawn
    for (const relay of spawned) relay.kill()
  }
})

test('a sidecar that ends before the answer does fails the request', async () => {
  const ended = (events: Array<[string, unknown?]>) => new Promise<Error | null>((resolve) => {
    const sidecar = Object.assign(new EventEmitter(), { writeApp: () => {} })
    const socket = new KeyedPlaintextSocket(sidecar as never, 0)
    socket.on('error', resolve)
    socket.on('end', () => resolve(null))
    socket.resume()
    for (const [name, value] of events) sidecar.emit(name, value)
    setTimeout(() => resolve(new Error('the socket neither ended nor failed')), 200)
  })
  const failed = await ended([['app', Buffer.from('HTTP/1.1 200 OK\r\n')], ['exit', { code: 1, stderr: 'the relay stream closed' }]])
  assert.match(failed?.message ?? 'ended', /the relay ended before the answer did \(the relay stream closed\)/)
  // After the answer's end, the sidecar's exit is how every request finishes.
  assert.equal(await ended([['app', Buffer.from('HTTP/1.1 200 OK\r\n')], ['appEnd'], ['exit', { code: 0, stderr: '' }]]), null)
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
  assert.deepEqual(keyedRevealRanges(sse, 200, true), [[0, 15], [usageEvent, sse.length - usageEvent]])
  const json = Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":5}}')
  const at = json.toString().indexOf('"usage":')
  assert.deepEqual(keyedRevealRanges(json, 200, false), [[0, 15], [at, json.length - at]])
  assert.deepEqual(keyedRevealRanges(Buffer.from('HTTP/1.1 401 Unauthorized\r\n\r\n{"usage":{}}'), 401, false), [[0, 25]])
  // A stream without usage shows only its end marker.
  const bare = Buffer.from('HTTP/1.1 200 OK\r\n\r\ndata: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
  const done = bare.toString().lastIndexOf('data: [DONE]')
  assert.deepEqual(keyedRevealRanges(bare, 200, true), [[0, 15], [done, bare.length - done]])
})

const head = (extra = '') => `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n${extra}\r\n`
/** The revealed tail of `raw`, or null when only the status line is revealed. */
function revealedTail(raw: string, stream: boolean): string | null {
  const ranges = keyedRevealRanges(Buffer.from(raw), 200, stream)
  assert.deepEqual(ranges[0], [0, 15])
  assert.ok(ranges.length <= 2)
  if (ranges.length === 1) return null
  assert.equal(ranges[1]![0] + ranges[1]![1], Buffer.byteLength(raw))
  return raw.slice(ranges[1]![0])
}

test('an answer that says "data:" is not revealed with the usage', () => {
  // One body: the reveal starts at the usage key, never at text inside the answer.
  const json = `${head()}{"choices":[{"message":{"content":"the metadata: field is secret"}}],"usage":{"prompt_tokens":5}}`
  assert.equal(revealedTail(json, false), '"usage":{"prompt_tokens":5}}')
  // A stream: the reveal starts at the line the usage event starts on.
  const sse = `${head()}data: {"choices":[{"delta":{"content":"secret"}}]}\n\ndata: {"id":"data: 7","choices":[],"usage":{"prompt_tokens":5}}\n\ndata: [DONE]\n\n`
  assert.equal(revealedTail(sse, true), 'data: {"id":"data: 7","choices":[],"usage":{"prompt_tokens":5}}\n\ndata: [DONE]\n\n')
})

test('the reveal follows the body through chunk framing', () => {
  const chunk = (data: string): string => `${Buffer.byteLength(data).toString(16)}\r\n${data}\r\n`
  // A chunk boundary inside the answer puts its next words at the start of a line of the raw response.
  const split = `${head('transfer-encoding: chunked\r\n')}`
    + chunk('data: {"choices":[{"delta":{"content":"the secret ')
    + chunk('data: {\\"usage\\": 1} ends here"}}]}\n\ndata: [DO')
    + chunk('NE]\n\n')
    + '0\r\n\r\n'
  assert.equal(revealedTail(split, true), `data: [DO\r\n${chunk('NE]\n\n')}0\r\n\r\n`)
  // The usage event starts its own chunk: the reveal starts after the chunk's size line.
  const usage = 'data: {"choices":[],"usage":{"prompt_tokens":5}}\n\ndata: [DONE]\n\n'
  const framed = `${head('Transfer-Encoding: chunked\r\n')}${chunk('data: {"choices":[{"delta":{"content":"secret"}}]}\n\n')}${chunk(usage)}0\r\n\r\n`
  assert.equal(revealedTail(framed, true), `${usage}\r\n0\r\n\r\n`)
  // A body that stopped before its last chunk: what follows the usage is not known to be framing.
  assert.equal(revealedTail(framed.slice(0, -5), true), null)
  assert.equal(revealedTail(`${framed.slice(0, -2)}x-trailer: secret\r\n\r\n`, true), null)
})

test('an answer in another form than asked, or with the answer after the usage, reveals the status line only', () => {
  const json = `${head()}{"choices":[{"message":{"content":"secret"}}],"usage":{"prompt_tokens":5}}`
  assert.equal(revealedTail(json, true), null)
  assert.equal(revealedTail(`${head()}{"usage":{"prompt_tokens":5},"choices":[{"message":{"content":"secret"}}]}`, false), null)
  // A stream that never reports usage carries `"usage":null` on every event: none of them is revealed.
  const noUsage = `${head()}data: {"choices":[{"delta":{"content":"secret"}}],"usage":null}\n\ndata: [DONE]\n\n`
  assert.equal(revealedTail(noUsage, true), 'data: [DONE]\n\n')
  assert.equal(revealedTail(`${head()}{"choices":[{"message":{"content":"secret"}}],"usage":null}`, false), null)
})

test('a usage event that carries part of the answer, or has more of it after, reveals the status line only', () => {
  const usage = '"usage":{"prompt_tokens":5,"completion_tokens":2}'
  // The upstream put the usage on the event with the answer's last words.
  assert.equal(revealedTail(`${head()}data: {"choices":[{"delta":{"content":"secret"}}],${usage}}\n\ndata: [DONE]\n\n`, true), null)
  assert.equal(revealedTail(`${head()}data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"secret"}}]}}],${usage}}\n\ndata: [DONE]\n\n`, true), null)
  // More of the answer follows the last usage figure.
  assert.equal(revealedTail(`${head()}data: {"choices":[],${usage}}\n\ndata: {"choices":[{"delta":{"content":"secret"}}]}\n\ndata: [DONE]\n\n`, true), null)
  assert.equal(revealedTail(`${head()}data: {"choices":[],${usage}}\n\n: secret\n\ndata: [DONE]\n\n`, true), null)
  assert.equal(revealedTail(`${head()}data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"secret"}}]}\n\n`, true), null)
  // Text where only figures and the response's own labels belong.
  assert.equal(revealedTail(`${head()}data: {"choices":[],"usage":{"prompt_tokens":5,"note":"secret"}}\n\ndata: [DONE]\n\n`, true), null)
  assert.equal(revealedTail(`${head()}data: {"choices":[],"output_text":"secret",${usage}}\n\ndata: [DONE]\n\n`, true), null)

  // One body: the answer after the usage, however the upstream spells the key.
  assert.equal(revealedTail(`${head()}{${usage},"choices" : [{"message":{"content":"secret"}}]}`, false), null)
  assert.equal(revealedTail(`${head()}{${usage},"output_text":"secret"}`, false), null)
  assert.equal(revealedTail(`${head()}{"choices":[{"message":{"content":"hi"},${usage}}]}`, false), null)
})

test('a last event that says only how the answer ended is revealed with its usage', () => {
  const usage = '"usage":{"prompt_tokens":5,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":0},"cost":0.01}'
  const last = `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"org/open-model","system_fingerprint":null,"choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":"stop"}],${usage}}\n\ndata: [DONE]\n\n`
  assert.equal(revealedTail(`${head()}data: {"choices":[{"delta":{"content":"secret"}}]}\n\n${last}`, true), last)
  const body = `${usage},"system_fingerprint":"fp_1","service_tier":"default"}`
  assert.equal(revealedTail(`${head()}{"choices":[{"message":{"content":"secret"}}],${body}`, false), body)
})

const keyedBinary = resolveKeyedRelayBinary()
const fixtureUrl = (name: string) => new URL(`../../../../packages/keyed-relay/test/fixtures/${name}`, import.meta.url)

/** A seller-blind relay with real sidecars, a relay mux pair and a local TLS 1.2 upstream. */
async function keyedStack(
  admit: (request: KeyedRequestAdmission) => KeyedRequestDecision,
  closeAfterMs = 20,
  /** `silent`: the upstream takes the request and answers nothing. `stalls`: it starts the answer and stops. `usageWithAnswer`: the usage is on the event with the answer's last words. */
  options: { upstream?: 'silent' | 'stalls' | 'usageWithAnswer'; deadlines?: Pick<BlindRelayDeps, 'responseTimeoutMs' | 'streamIdleTimeoutMs' | 'maxStreamDurationMs'> } = {},
) {
  const ca = readFileSync(fixtureUrl('ca.pem'), 'utf8')
  /** Every byte each upstream connection received, and the complete requests among them. */
  const received: string[] = []
  const requests: string[] = []
  /** Upstream connections that closed. */
  let closed = 0
  let mints = 0
  const waits: number[] = []
  const upstream = tlsCreateServer({ key: readFileSync(fixtureUrl('localhost.key')), cert: readFileSync(fixtureUrl('localhost.pem')), maxVersion: 'TLSv1.2' }, (socket) => {
    const index = received.push('') - 1
    socket.on('close', () => { closed += 1 })
    socket.on('error', () => {})
    socket.on('data', (data) => {
      received[index] += data.toString()
      const raw = received[index]!
      const end = raw.indexOf('\r\n\r\n')
      const length = Number(/content-length: (\d+)/i.exec(raw)?.[1] ?? -1)
      if (end < 0 || length < 0 || raw.length < end + 4 + length) return
      requests.push(raw)
      if (options.upstream === 'silent') return
      // Chunked, with the end of the body in a TLS record of its own, as upstreams send it.
      const events = options.upstream === 'usageWithAnswer'
        ? 'data: {"model":"org/open-model","choices":[{"delta":{"content":"giraffe"}}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
        : 'data: {"model":"org/open-model","choices":[{"delta":{"content":"giraffe"}}]}\n\n'
          + 'data: {"model":"org/open-model","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
      const account = 'set-cookie: session=upstream-account\r\nx-ratelimit-remaining-tokens: 999\r\nopenai-organization: seller-org\r\n'
      socket.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n${account}transfer-encoding: chunked\r\nconnection: close\r\n\r\n${events.length.toString(16)}\r\n${events}\r\n`, () => {
        if (options.upstream === 'stalls') return
        setTimeout(() => socket.write('0\r\n\r\n', () => setTimeout(() => socket.end(), closeAfterMs)), 20)
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
  /** Each answer as the buyer handed it over for pricing. */
  const relayed: RelayedResponse[] = []
  /** Each record the buyer kept of a request it sent: at the send, and again if its answer did not end. */
  const interrupted: InterruptedRelayedResponse[] = []
  const client = new BlindRelayClient({
    sendRequest: async (_peer, request) => {
      mints += 1
      const minted = seller.mint(peer.peerId, 'open-model', provider)
      return { requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(minted)) }
    },
    openRelayStream: (_peer, streamId, credentialId) => ends[0]!.mux!.openStream(streamId, credentialId),
    recordRelayedResponse: (_peer, answer) => { recorded.push(answer.response); relayed.push(answer) },
    recordInterruptedRelayedResponse: (_peer, record) => { interrupted.push(record) },
    keyedRelayBinary: keyedBinary,
    keyedRelayExtraRootsPem: ca,
    // A real, short wait: the seller's handle is busy until its sidecar has exited.
    sleep: (ms) => { waits.push(ms); return new Promise((resolve) => setTimeout(resolve, 20)) },
    ...options.deadlines,
  })
  const send = (body: unknown, callbacks: BlindRelayCallbacks = {}, signal?: AbortSignal) => client.send(peer, 'open-model', {
    requestId: 'keyed-1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: 'Bearer buyer-must-not-send', 'x-cost-header': 'priority' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  }, undefined, callbacks, { signal })
  return { upstream, received, requests, charges, recorded, relayed, interrupted, send, waits, mints: () => mints, closed: () => closed }
}

test('the seller checks the request, adds its key to the buyer\'s TLS session and bills the revealed usage', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  const admissions: KeyedRequestAdmission[] = []
  const stack = await keyedStack((request) => { admissions.push(request); return { admitted: true } })
  try {
    const response = await stack.send({ model: 'open-model', stream: true, max_tokens: 5000, messages: [{ role: 'user', content: 'zebra' }] })
    assert.equal(response.statusCode, 200)
    assert.match(new TextDecoder().decode(response.body), /giraffe/)
    assert.equal(stack.recorded.length, 1)
    // The buyer kept a record of the request from the send, and the answer that ended was priced whole.
    assert.deepEqual(stack.interrupted.map((record) => [record.requestId, record.receivedLength]), [['keyed-1', 0]])
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
    assert.deepEqual(stack.charges, [{ buyerPeerId: peer.peerId, requestId: 'keyed-1', service: 'open-model', costUsdc: 420n, usage: { inputTokens: 12, freshInputTokens: 12, cachedInputTokens: 0, outputTokens: 3 } }])
  } finally {
    stack.upstream.close()
  }
})

test('an answer whose usage the buyer cannot reveal is billed by the three figures the buyer prices it by', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  const stack = await keyedStack(() => ({ admitted: true }), 20, { upstream: 'usageWithAnswer' })
  try {
    const response = await stack.send({ model: 'open-model', stream: true, max_tokens: 5000, messages: [{ role: 'user', content: 'zebra' }] })
    assert.match(new TextDecoder().decode(response.body), /giraffe/)
    for (let i = 0; i < 50 && stack.charges.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    // The usage shares its event with the answer, so the buyer shows the status line only.
    const [answer] = stack.relayed
    assert.deepEqual(answer!.revealed.ranges.map((range) => range.offset), [0])
    assert.match(Buffer.from(answer!.revealed.ranges[0]!.data, 'base64').toString(), /^HTTP\/1\.1 200 OK$/)
    assert.equal(answer!.maxOutputTokens, 1000)
    // The seller bills the request's length and the answer's, within the output limit: the figures the buyer handed over.
    const inputTokens = Math.ceil(answer!.requestBody.length / 4)
    const outputTokens = Math.min(Math.ceil(answer!.revealed.length / 4), 1000)
    assert.ok(outputTokens > 3 && outputTokens < 1000, `output ${outputTokens}`)
    assert.deepEqual(stack.charges.map((charge) => charge.usage), [{ inputTokens, freshInputTokens: inputTokens, cachedInputTokens: 0, outputTokens }])
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

const zebra = { model: 'open-model', stream: true, messages: [{ role: 'user', content: 'zebra' }] }

test('a request refused for an exhausted channel is sent once more, on a credential minted for the new channel', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  let asked = 0
  const stack = await keyedStack(() => (++asked === 1 ? { admitted: false, reason: 'channel_exhausted: the payment channel is exhausted' } : { admitted: true }))
  try {
    const response = await stack.send(zebra)
    assert.equal(response.statusCode, 200)
    assert.match(new TextDecoder().decode(response.body), /giraffe/)
    // The mint is where the seller answers 402 and the node opens the new channel: the held credential is not reused.
    assert.deepEqual([asked, stack.mints(), stack.requests.length], [2, 2, 1])
  } finally {
    stack.upstream.close()
  }
})

test('a request refused while a top-up is mining is sent once more after a short wait, on the credential it has', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  let asked = 0
  const stack = await keyedStack(() => (++asked === 1 ? { admitted: false, reason: 'top_up_pending: the payment channel is being extended on-chain; retry shortly' } : { admitted: true }))
  try {
    const response = await stack.send(zebra)
    assert.equal(response.statusCode, 200)
    assert.deepEqual([asked, stack.mints(), stack.requests.length], [2, 1, 1])
    assert.ok(stack.waits.includes(2_000), `waited ${stack.waits.join(', ')}`)
  } finally {
    stack.upstream.close()
  }
})

test('a request refused again after its one retry fails, and nothing of it reached the upstream', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  let asked = 0
  const stack = await keyedStack(() => { asked += 1; return { admitted: false, reason: 'channel_exhausted: the payment channel is exhausted' } })
  try {
    await assert.rejects(stack.send(zebra), (error: unknown) => error instanceof BlindRelayError && /channel_exhausted/.test(error.message))
    assert.deepEqual([asked, stack.requests.length], [2, 0])
  } finally {
    stack.upstream.close()
  }
})

test('an admitted request the upstream never answers ends at the response deadline, and the relay is closed', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  const stack = await keyedStack(() => ({ admitted: true }), 20, { upstream: 'silent', deadlines: { responseTimeoutMs: 400 } })
  try {
    // The request may have reached the upstream: not an error another seller is tried on as if nothing was sent.
    await assert.rejects(settlesWithin(stack.send(zebra), 5_000), (error: unknown) => !(error instanceof BlindRelayError) && /no answer came within 400 ms/.test((error as Error).message))
    assert.equal(stack.requests.length, 1)
    for (let i = 0; i < 100 && stack.closed() === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(stack.closed(), 1)
    // No byte of an answer: the buyer's record prices nothing, and the seller bills nothing.
    assert.deepEqual(stack.interrupted.map((record) => record.receivedLength), [0, 0])
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(stack.charges, [])
  } finally {
    stack.upstream.close()
  }
})

/** The seller's charge for the one request of `stack`, once its sidecar has ended. */
async function chargeOf(stack: Awaited<ReturnType<typeof keyedStack>>): Promise<BlindRelayCharge> {
  for (let i = 0; i < 250 && stack.charges.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stack.charges.length, 1, 'the seller billed the answer it relayed')
  return stack.charges[0]!
}

/** Checks the buyer's last record of the request prices what the seller billed: the same body, limit and answer length. */
function assertPricedAsBilled(stack: Awaited<ReturnType<typeof keyedStack>>, charge: BlindRelayCharge): void {
  const record = stack.interrupted.at(-1)
  assert.ok(record, 'the buyer kept no record of the answer that did not end')
  assert.equal(record.requestId, charge.requestId)
  assert.equal(record.service, 'open-model')
  assert.ok(record.receivedLength > 0, 'the buyer recorded none of the answer that reached it')
  // The seller bills what it relayed with no usage shown: the body's length in, the answer's length out.
  assert.deepEqual(charge.usage, {
    inputTokens: Math.ceil(record.requestBody.length / 4),
    freshInputTokens: Math.ceil(record.requestBody.length / 4),
    cachedInputTokens: 0,
    outputTokens: Math.min(Math.ceil(record.receivedLength / 4), record.maxOutputTokens!),
  })
}

test('an answer that stalls is priced by the buyer as the seller bills it: by what arrived', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  const stack = await keyedStack(() => ({ admitted: true }), 20, { upstream: 'stalls', deadlines: { streamIdleTimeoutMs: 400 } })
  try {
    await assert.rejects(settlesWithin(stack.send(zebra), 5_000), /no more of it came within 400 ms/)
    // Recorded before the request failed for its caller: the seller's charge arrives after the stream closes.
    assert.deepEqual(stack.interrupted.map((record) => record.receivedLength > 0), [false, true])
    assertPricedAsBilled(stack, await chargeOf(stack))
    assert.equal(stack.relayed.length, 0)
  } finally {
    stack.upstream.close()
  }
})

test('an answer its client gives up on is priced by the buyer as the seller bills it: by what arrived', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  const stack = await keyedStack(() => ({ admitted: true }), 20, { upstream: 'stalls' })
  try {
    const client = new AbortController()
    // The client leaves once the answer's first words have reached it.
    await assert.rejects(settlesWithin(stack.send(zebra, { onResponseChunk: () => client.abort() }, client.signal), 5_000))
    assert.deepEqual(stack.interrupted.map((record) => record.receivedLength > 0), [false, true])
    assertPricedAsBilled(stack, await chargeOf(stack))
  } finally {
    stack.upstream.close()
  }
})

test('a request the seller refuses leaves a record that prices nothing', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  const stack = await keyedStack(() => ({ admitted: false, reason: 'the locked reserve has 0 left' }))
  try {
    await assert.rejects(stack.send(zebra))
    assert.ok(stack.interrupted.length > 0 && stack.interrupted.every((record) => record.receivedLength === 0), JSON.stringify(stack.interrupted.map((record) => record.receivedLength)))
    assert.deepEqual(stack.charges, [])
  } finally {
    stack.upstream.close()
  }
})

test('an answer that stalls after it started ends at the idle deadline, and one that never ends at the stream deadline', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  const stalled = await keyedStack(() => ({ admitted: true }), 20, { upstream: 'stalls', deadlines: { streamIdleTimeoutMs: 400 } })
  try {
    let started = false
    await assert.rejects(settlesWithin(stalled.send(zebra, { onResponseStart: () => { started = true } }), 5_000), /no more of it came within 400 ms/)
    assert.equal(started, true)
    for (let i = 0; i < 100 && stalled.closed() === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(stalled.closed(), 1)
  } finally {
    stalled.upstream.close()
  }
  const endless = await keyedStack(() => ({ admitted: true }), 20, { upstream: 'stalls', deadlines: { maxStreamDurationMs: 400 } })
  try {
    await assert.rejects(settlesWithin(endless.send(zebra), 5_000), /did not end within 400 ms/)
  } finally {
    endless.upstream.close()
  }
})

test('a payment failure the buyer\'s own node answers the mint with reaches the caller as it is', async () => {
  const body = new TextEncoder().encode(JSON.stringify({ error: { type: 'payment_error', code: 'payments_inactive', message: 'Payments are turned off on this buyer.' } }))
  const answers = (statusCode: number, headers: Record<string, string>) => new BlindRelayClient({
    sendRequest: async (_peer, request) => ({ requestId: request.requestId, statusCode, headers, body }),
    openRelayStream: async () => { throw new Error('unreachable') },
    recordRelayedResponse: () => {},
    recordInterruptedRelayedResponse: () => {},
    keyedRelayBinary: '/never-spawned',
  }).send(peer, 'open-model', chat('mine'), undefined)

  const own = await answers(503, { 'content-type': 'application/json', 'x-antseed-fault-attribution': 'buyer' })
  assert.deepEqual([own.requestId, own.statusCode, own.headers['x-antseed-fault-attribution']], ['mine', 503, 'buyer'])
  assert.deepEqual(own.body, body)
  // A payment the buyer could not make: the 402 and what it says to do.
  const unpaid = await answers(402, { 'content-type': 'application/json' })
  assert.deepEqual([unpaid.statusCode, unpaid.body], [402, body])
  // The seller's own failure stays an error another seller is tried on.
  await assert.rejects(answers(503, { 'content-type': 'application/json' }), (error: unknown) => error instanceof BlindRelayError && /minted no credential \(HTTP 503/.test(error.message))
})

test('the client gets the answer when it ends, with only the headers a seller exposes', { skip: !keyedBinary && 'keyed-relay sidecar not built' }, async () => {
  // The upstream keeps the connection open for a while after the answer's last byte.
  const stack = await keyedStack(() => ({ admitted: true }), 600)
  try {
    let started: SerializedHttpResponse | null = null
    let endedAt = 0
    const response = await stack.send({ model: 'open-model', stream: true, messages: [{ role: 'user', content: 'zebra' }] }, {
      onResponseStart: (start) => { started = start },
      onResponseChunk: (chunk: SerializedHttpResponseChunk) => { if (chunk.done) endedAt = Date.now() },
    })
    const late = Date.now() - endedAt
    assert.ok(endedAt > 0 && late < 300, `the answer was handed over ${late} ms after it ended`)
    // What the upstream says of the seller's account stays out of the buyer's client.
    assert.deepEqual(response.headers, { 'content-type': 'text/event-stream' })
    assert.deepEqual(started!.headers, { 'content-type': 'text/event-stream' })
    // The usage is still revealed and billed once the upstream closes.
    for (let i = 0; i < 150 && stack.charges.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(stack.charges, [{ buyerPeerId: peer.peerId, requestId: 'keyed-1', service: 'open-model', costUsdc: 420n, usage: { inputTokens: 12, freshInputTokens: 12, cachedInputTokens: 0, outputTokens: 3 } }])
  } finally {
    stack.upstream.close()
  }
})
