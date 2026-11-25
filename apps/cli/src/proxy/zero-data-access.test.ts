import assert from 'node:assert/strict'
import test from 'node:test'
import { SigningKey, computeAddress, getBytes } from 'ethers'
import { decryptE2eeText, encryptE2eeText, type E2eeQuoteVerifier, type PeerInfo } from '@antseed/node'
import { ZeroDataAccess, createOrderedStreamDecryptor, createStreamDecryptor, decryptResponse, encryptRequest, isE2eeOffer } from './zero-data-access.js'

/** Stands in for the upstream TEE behind a seller. */
const model = new SigningKey(`0x${'22'.repeat(32)}`)
const peer = { peerId: 'a'.repeat(40) } as PeerInfo

/** A seller relaying an attestation for `model`; `tamper` lets a test make it lie. */
function seller(tamper: (attestation: Record<string, unknown>) => void = () => {}) {
  const calls: string[] = []
  let lastNonce = ''
  const fetchFromPeer = async (_peer: PeerInfo, path: string) => {
    calls.push(path)
    lastNonce = new URLSearchParams(path.split('?')[1]).get('nonce')!
    const attestation: Record<string, unknown> = {
      nonce: lastNonce,
      signing_key: model.publicKey.slice(2),
      signing_address: computeAddress(model.publicKey),
      intel_quote: Buffer.from('quote').toString('base64'),
    }
    tamper(attestation)
    return { statusCode: 200, body: new TextEncoder().encode(JSON.stringify(attestation)) }
  }
  // DCAP stub: a genuine quote whose report_data binds the model address and the nonce asked for.
  const verifier: E2eeQuoteVerifier = async () => {
    const reportData = new Uint8Array(64)
    reportData.set(getBytes(computeAddress(model.publicKey)), 0)
    reportData.set(getBytes(`0x${lastNonce}`), 32)
    return { status: 'UpToDate', acceptable: true, reportData, debug: false }
  }
  return { calls, deps: { fetchFromPeer, loadQuoteVerifier: async () => verifier } }
}

test('isE2eeOffer reads the e2ee service category', () => {
  assert.equal(isE2eeOffer({ categories: ['chat', 'E2EE'] }), true)
  assert.equal(isE2eeOffer({ categories: ['chat', 'tee'] }), false)
  assert.equal(isE2eeOffer(null), false)
})

test('attests once, reuses the verified key, and gives each request its own client key', async () => {
  const { calls, deps } = seller()
  const zda = new ZeroDataAccess(deps)
  const [a, b] = await Promise.all([zda.session(peer, 'private-qwen'), zda.session(peer, 'private-qwen')])
  await zda.session(peer, 'private-qwen')
  assert.equal(calls.length, 1)
  assert.match(calls[0]!, /^\/_antseed\/e2ee\/attestation\?service=private-qwen&nonce=[0-9a-f]{64}$/)
  assert.equal(a.modelPublicKey, model.publicKey.slice(2))
  assert.notEqual(a.clientKey.publicKey, b.clientKey.publicKey)
})

test('a seller that swaps in its own key is refused and the failure is remembered', async () => {
  const sellerKey = new SigningKey(`0x${'44'.repeat(32)}`)
  const { deps } = seller((attestation) => {
    attestation['signing_key'] = sellerKey.publicKey.slice(2)
    attestation['signing_address'] = computeAddress(sellerKey.publicKey)
  })
  const zda = new ZeroDataAccess(deps)
  await assert.rejects(zda.session(peer, 'private-qwen'), /does not bind the model key and our nonce/)
  assert.match(zda.failure(peer.peerId, 'private-qwen') ?? '', /does not bind/)
})

test('a replayed attestation (another nonce) is refused', async () => {
  const { deps } = seller((attestation) => { attestation['nonce'] = 'cd'.repeat(32) })
  await assert.rejects(new ZeroDataAccess(deps).session(peer, 'private-qwen'), /does not echo our nonce/)
})

test('the seller sees only ciphertext, and the buyer reads the answer', async () => {
  const { deps } = seller()
  const session = await new ZeroDataAccess(deps).session(peer, 'private-qwen')
  const request = await encryptRequest({
    requestId: 'r1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'content-length': '10' },
    body: new TextEncoder().encode(JSON.stringify({ model: 'private-qwen', stream: true, messages: [{ role: 'user', content: 'codeword OSPREY-4410' }] })),
  }, session)
  const sent = new TextDecoder().decode(request.body)
  assert.doesNotMatch(sent, /OSPREY/)
  assert.equal(request.headers['content-length'], undefined)
  assert.equal(request.headers['x-venice-tee-model-pub-key'], model.publicKey.slice(2))
  const content = (JSON.parse(sent) as { messages: Array<{ content: string }> }).messages[0]!.content
  assert.equal(await decryptE2eeText(content, model), 'codeword OSPREY-4410')

  // The TEE seals each chunk to the client key named in the request headers.
  const clientKey = `04${request.headers['x-venice-tee-client-pub-key']!.replace(/^04/, '')}`
  const sealed = async (text: string) => encryptE2eeText(text, clientKey)
  const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: await sealed('OSPREY') } }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ delta: { content: await sealed('-4410') } }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`
  const stream = createStreamDecryptor(session)
  const bytes = new TextEncoder().encode(sse)
  let out = ''
  for (let i = 0; i < bytes.length; i += 50) out += new TextDecoder().decode(await stream.push(bytes.slice(i, i + 50)))
  out += new TextDecoder().decode(await stream.flush())
  assert.match(out, /"content":"OSPREY"/)
  assert.match(out, /"content":"-4410"/)
  assert.match(out, /"usage":\{"prompt_tokens":9,"completion_tokens":2\}/)
  assert.match(out, /data: \[DONE\]\n\n$/)

  const buffered = await decryptResponse({
    requestId: 'r1',
    statusCode: 200,
    headers: {},
    body: new TextEncoder().encode(JSON.stringify({ choices: [{ message: { role: 'assistant', content: await sealed('hello') } }] })),
  }, session)
  assert.match(new TextDecoder().decode(buffered.body), /"content":"hello"/)
})

test('a streamed answer is written in the order it came, and stops at the first chunk that does not decrypt', async () => {
  const { deps } = seller()
  const session = await new ZeroDataAccess(deps).session(peer, 'private-qwen')
  const request = await encryptRequest({
    requestId: 'r1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model: 'private-qwen', stream: true, messages: [{ role: 'user', content: 'hello' }] })),
  }, session)
  const clientKey = `04${request.headers['x-venice-tee-client-pub-key']!.replace(/^04/, '')}`
  const event = async (text: string, key = clientKey) =>
    new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: await encryptE2eeText(text, key) } }] })}\n\n`)
  const collect = () => {
    const written: string[] = []
    const errors: unknown[] = []
    let stopped = false
    const stream = createOrderedStreamDecryptor(session, {
      write: (chunk) => written.push(new TextDecoder().decode(chunk.data)),
      stopped: () => stopped,
      onError: (error) => errors.push(error),
    })
    return { written, errors, stream, stop: () => { stopped = true } }
  }

  const whole = collect()
  // Pushed without waiting, as frames arrive: the longer first chunk must not be overtaken.
  whole.stream.push({ requestId: 'r1', data: await event('first '.repeat(200)), done: false })
  whole.stream.push({ requestId: 'r1', data: await event('second'), done: false })
  whole.stream.push({ requestId: 'r1', data: new TextEncoder().encode('data: [DONE]'), done: true })
  await whole.stream.drain()
  assert.equal(whole.written.length, 3)
  assert.match(whole.written[0]!, /"content":"first first /)
  assert.match(whole.written[1]!, /"content":"second"/)
  // The last chunk's unfinished line is flushed with it.
  assert.equal(whole.written[2], 'data: [DONE]')
  assert.deepEqual(whole.errors, [])

  // Sealed to another key: the chunk does not decrypt.
  const other = new SigningKey(`0x${'33'.repeat(32)}`).publicKey.slice(2)
  const broken = collect()
  broken.stream.push({ requestId: 'r1', data: await event('readable'), done: false })
  broken.stream.push({ requestId: 'r1', data: await event('unreadable', other), done: false })
  broken.stream.push({ requestId: 'r1', data: await event('after'), done: true })
  await assert.rejects(broken.stream.drain())
  assert.equal(broken.written.length, 1)
  assert.match(broken.written[0]!, /"content":"readable"/)
  assert.equal(broken.errors.length, 1)

  // A client that left: nothing more is decrypted or written.
  const gone = collect()
  gone.stop()
  gone.stream.push({ requestId: 'r1', data: await event('unread'), done: true })
  await gone.stream.drain()
  assert.deepEqual([gone.written, gone.errors], [[], []])
})

test('a request with tool definitions is refused rather than sent in plaintext', async () => {
  const { deps } = seller()
  const session = await new ZeroDataAccess(deps).session(peer, 'private-qwen')
  await assert.rejects(encryptRequest({
    requestId: 'r2',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {},
    body: new TextEncoder().encode(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function' }] })),
  }, session), /does not cover `tools`/)
})
