import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import { createResponseAuthPayload, encodeHttpRequest, encodeHttpResponse, type StoredResponseAuth } from '@antseed/node'
import type { TokenizerRound } from '@antseed/node/payments'
import { createResponseAuthReader } from './response-auth-reader.js'
import { INCONCLUSIVE_RECHECK_MS, runTokenizerProver, type TokenizerAuditsReader, type TokenizerPeer } from './tokenizer-prover.js'

const CHAT = { shapeId: `0x${'ab'.repeat(32)}`, path: '/v1/chat/completions', head: '{"model":"', mid: '","messages":[{"role":"user","content":"', tail: '"}],"max_tokens":64}', active: true }
const MESSAGES = { shapeId: `0x${'cd'.repeat(32)}`, path: '/v1/messages', head: '{"model":"', mid: '","max_tokens":64,"messages":[{"role":"user","content":"', tail: '"}]}', active: true }
const MODEL = `0x${'01'.repeat(32)}`
const buyer = new Wallet(`0x${'22'.repeat(32)}`)

interface FakeSeller {
  name: string
  wallet: Wallet
  /** Tokens the seller reports for B: its tokenizer's count (or a misreport). */
  bTokens: number
  liveSame: boolean
  status?: number
  /** The API protocols the seller speaks for its service. */
  protocols: string[]
}

function seller(name: string, bTokens: number, liveSame: boolean, status?: number, protocols = ['openai-chat-completions']): FakeSeller {
  return { name, wallet: new Wallet(Wallet.createRandom().privateKey), bTokens, liveSame, protocols, ...(status ? { status } : {}) }
}

function peer(s: FakeSeller, service = 'example-model'): TokenizerPeer {
  return {
    peerId: s.wallet.address.slice(2).toLowerCase(),
    displayName: s.name,
    providerPricing: { upstream: { services: { [service]: {} } } },
    providerServiceApiProtocols: { upstream: { services: { [service]: s.protocols } } },
  }
}

/** A buyer proxy whose sellers sign real receipts into an in-memory store. */
function fakeNetwork(sellers: FakeSeller[]) {
  const store = new Map<string, StoredResponseAuth>()
  let requests = 0
  const paths: string[] = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    requests++
    const path = new URL(url).pathname
    paths.push(path)
    const headers = init.headers as Record<string, string>
    const s = sellers.find((x) => x.wallet.address.slice(2).toLowerCase() === headers['x-antseed-pin-peer'])!
    if (s.status && s.status !== 200) return new Response('busy', { status: s.status })
    const requestId = headers['x-antseed-request-id']!
    const body = new TextEncoder().encode(String(init.body))
    const parsed = JSON.parse(String(init.body)) as { model: string; messages: Array<{ content: string }> }
    const promptTokens = 20 + (parsed.messages[0]!.content.includes(' B-') ? s.bTokens : 0)
    const request = { requestId, method: 'POST', path, headers: { 'content-type': 'application/json' }, body }
    const usage = path === MESSAGES.path
      ? { input_tokens: promptTokens - 5, cache_read_input_tokens: 5, output_tokens: 2 }
      : { prompt_tokens: promptTokens, completion_tokens: 2 }
    const responseBody = JSON.stringify({ model: parsed.model, usage })
    const response = { requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(responseBody) }
    const payload = createResponseAuthPayload({
      request, response, buyerPeerId: buyer.address, sellerPeerId: s.wallet.address,
      advertisedService: parsed.model, provider: 'openai', responseStartedAt: Date.now(), responseCompletedAt: Date.now() + 1,
    }, s.wallet)
    store.set(requestId, {
      ...payload, receivedAt: Date.now(), verified: true, verificationError: null,
      requestPreimage: encodeHttpRequest(request), responsePreimage: encodeHttpResponse(response),
    })
    return new Response(responseBody, { status: 200 })
  }) as unknown as typeof fetch
  const reader = createResponseAuthReader({ getResponseAuth: (id) => store.get(id) ?? null }, 1_000)
  return { fetchFn, reader, requests: () => requests, paths }
}

function fakeContract(sellers: FakeSeller[]) {
  const submitted: Array<{ modelHash: string; rounds: TokenizerRound[] }> = []
  const contract: TokenizerAuditsReader = {
    activeShapes: async () => [CHAT, MESSAGES],
    parameters: async () => ({ minRounds: 3, minReferences: 3, tolerance: 2, maxRoundSpreadSeconds: 3600 }),
    resolveServices: async (entries) => entries.map((e) => {
      const index = sellers.findIndex((s) => s.wallet.address.slice(2).toLowerCase() === e.seller.replace(/^0x/, '').toLowerCase())
      return { agentId: BigInt(index + 1), modelHash: MODEL, liveSame: sellers[index]!.liveSame }
    }),
    checkProof: async (_from, _model, rounds) => rounds.length >= 3 && rounds.every((r) => r.references.length >= 3) ? null : 'InvalidRounds()',
    proveTokenizerMismatch: async (_signer, modelHash, rounds) => {
      submitted.push({ modelHash, rounds: [...rounds] })
      return `0x${'99'.repeat(32)}`
    },
  }
  return { contract, submitted }
}

let generated = 0
const generator = async () => ({ a: `Question ${++generated}?`, b: ` B-${generated} with "quotes" and\nnewlines` })

async function run(sellers: FakeSeller[], extra: Partial<Parameters<typeof runTokenizerProver>[0]> = {}) {
  const network = fakeNetwork(sellers)
  const { contract, submitted } = fakeContract(sellers)
  const evidenceDir = await mkdtemp(join(tmpdir(), 'tokenizer-prover-'))
  const summary = await runTokenizerProver({
    proxyBaseUrl: 'http://proxy.test',
    peers: sellers.map((s) => peer(s)),
    reader: network.reader,
    contract,
    generator,
    signer: { wallet: Wallet.createRandom(), address: '0x000000000000000000000000000000000000bEEF' },
    simulateFrom: '0x000000000000000000000000000000000000dEaD',
    concurrency: 4,
    evidenceDir,
    fetchFn: network.fetchFn,
    ...extra,
  })
  return { summary, submitted, network, evidenceDir }
}

test('proves a swapped seller against agreeing live-SAME references and leaves honest ones alone', async () => {
  // Four references, so each can itself be judged against three others.
  const refs = [seller('Ref 1', 139, true), seller('Ref 2', 139, true), seller('Ref 3', 139, true), seller('Ref 4', 139, true)]
  const swapped = seller('Swapped', 129, false)
  const honest = seller('Honest', 139, false)
  const { summary, submitted, evidenceDir } = await run([...refs, swapped, honest])
  try {
    const byName = (name: string) => summary.results.find((r) => r.sellerName === name)!
    assert.equal(byName('Swapped').outcome, 'mismatch')
    assert.deepEqual(byName('Swapped').deltas, [129, 129, 129])
    assert.deepEqual(byName('Swapped').referenceDeltas, [139, 139, 139])
    assert.equal(byName('Swapped').liveSame, false)
    assert.equal(byName('Honest').outcome, 'match')
    for (const ref of refs) assert.equal(byName(ref.name).outcome, 'match', 'a reference is judged against the other references')
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.rounds.length, 3)
    for (const round of submitted[0]!.rounds) {
      assert.equal(round.references.length, 3)
      assert.doesNotMatch(round.a + round.b, /["\n\\]/, 'generated text is made JSON-string-safe')
    }
    const evidence = JSON.parse(await readFile(summary.evidencePath, 'utf8')) as { rounds: unknown[] }
    assert.equal(evidence.rounds.length, 3)
  } finally {
    await rm(evidenceDir, { recursive: true, force: true })
  }
})

test('a live-SAME seller that misreports usage is a usage flag, proved against the other references', async () => {
  const sellers = [seller('Ref 1', 139, true), seller('Ref 2', 139, true), seller('Ref 3', 139, true), seller('Misreports', 152, true)]
  const { summary, submitted, evidenceDir } = await run(sellers)
  try {
    const misreports = summary.results.find((r) => r.sellerName === 'Misreports')!
    assert.equal(misreports.outcome, 'mismatch')
    assert.equal(misreports.liveSame, true)
    assert.equal(submitted.length, 1)
    const suspect = submitted[0]!.rounds[0]!.suspect.base.payload.sellerPeerId.toLowerCase()
    for (const ref of submitted[0]!.rounds[0]!.references) {
      assert.notEqual(ref.base.payload.sellerPeerId.toLowerCase(), suspect)
    }
  } finally {
    await rm(evidenceDir, { recursive: true, force: true })
  }
})

test('without enough references nothing is probed, and a failing seller is inconclusive', async () => {
  const few = await run([seller('Ref 1', 139, true), seller('Ref 2', 139, true), seller('Swapped', 129, false)])
  assert.equal(few.summary.models, 0)
  assert.equal(few.network.requests(), 0)
  await rm(few.evidenceDir, { recursive: true, force: true })

  const down = await run([seller('Ref 1', 139, true), seller('Ref 2', 139, true), seller('Ref 3', 139, true), seller('Down', 139, false, 502)], { signer: null })
  try {
    const result = down.summary.results.find((r) => r.sellerName === 'Down')!
    assert.equal(result.outcome, 'inconclusive')
    assert.match(result.reason ?? '', /HTTP 502/)
    assert.equal(down.submitted.length, 0)
  } finally {
    await rm(down.evidenceDir, { recursive: true, force: true })
  }
})

test('skips suspects with a recent conclusive result', async () => {
  const sellers = [seller('Ref 1', 139, true), seller('Ref 2', 139, true), seller('Ref 3', 139, true), seller('Ref 4', 139, true), seller('Honest', 139, false)]
  const evidenceDir = await mkdtemp(join(tmpdir(), 'tokenizer-prover-'))
  try {
    const statePath = join(evidenceDir, 'state.json')
    const first = await run(sellers, { evidenceDir, statePath, recheckAfterMs: 60_000, signer: null })
    assert.equal(first.summary.suspects, 5)
    const again = await run(sellers, { evidenceDir, statePath, recheckAfterMs: 60_000, signer: null })
    assert.equal(again.summary.suspects, 0)
    assert.equal(again.summary.skipped, 5)
  } finally {
    await rm(evidenceDir, { recursive: true, force: true })
  }
})

test('probes each seller in the API it speaks and proves across APIs', async () => {
  const anthropicOnly = ['anthropic-messages']
  const sellers = [
    seller('Ref 1', 139, true), seller('Ref 2', 139, true, undefined, anthropicOnly), seller('Ref 3', 139, true),
    seller('Swapped', 129, false, undefined, anthropicOnly),
    seller('Images only', 139, false, undefined, ['openai-images']),
  ]
  const { summary, submitted, network, evidenceDir } = await run(sellers)
  try {
    assert.equal(summary.results.find((r) => r.sellerName === 'Swapped')!.outcome, 'mismatch')
    assert.equal(summary.results.find((r) => r.sellerName === 'Images only'), undefined, 'a service with no chat API is not probed')
    assert.ok(network.paths.includes('/v1/messages'))
    const round = submitted[0]!.rounds[0]!
    assert.equal(round.suspect.shapeId, MESSAGES.shapeId)
    assert.deepEqual(new Set(round.references.map((r) => r.shapeId)), new Set([CHAT.shapeId, MESSAGES.shapeId]))
  } finally {
    await rm(evidenceDir, { recursive: true, force: true })
  }
})

test('retries an inconclusive suspect sooner than a conclusive one', async () => {
  const sellers = [seller('Ref 1', 139, true), seller('Ref 2', 139, true), seller('Ref 3', 139, true), seller('Ref 4', 139, true), seller('Down', 139, false, 502)]
  const evidenceDir = await mkdtemp(join(tmpdir(), 'tokenizer-prover-'))
  try {
    const statePath = join(evidenceDir, 'state.json')
    let clock = 1_000_000
    const options = { evidenceDir, statePath, recheckAfterMs: 24 * 3_600_000, signer: null, now: () => clock }
    await run(sellers, options)
    clock += INCONCLUSIVE_RECHECK_MS + 1
    const later = await run(sellers, options)
    assert.deepEqual(later.summary.results.map((r) => r.sellerName), ['Down'])
  } finally {
    await rm(evidenceDir, { recursive: true, force: true })
  }
})
