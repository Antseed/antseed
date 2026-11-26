import assert from 'node:assert/strict'
import test from 'node:test'
import type { VerifierCLIConfig } from '../config/types.js'
import { setAuditedModelsForTesting } from './audited-models.js'
import { referenceFixture } from './model-audit-fixtures.test-support.js'
import { createReferenceRequestLimiter, type ReferenceRequestLimiter } from './model-reference.js'
import { bankRouteOracle } from './reference-oracle.js'

setAuditedModelsForTesting({ 'model-a': { upstreamModel: 'upstream-model-a', contrastModels: [] } })

// The bank of `referenceFixture` was enrolled on the source `trusted`: the reference endpoint below.
const config: VerifierCLIConfig = {
  referenceRetryBaseDelayMs: 1,
  models: { 'model-a': { pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, contrastModels: ['contrast-a'] } },
  referenceEndpoint: { baseUrl: 'https://reference.test/v1', sourceId: 'trusted', trust: 'trusted' },
}
const bank = referenceFixture('model-a')

type Sent = Record<string, unknown> & { messages: Array<{ role: string; content: string }> }

/** The reference endpoint as `fetch`: every body sent, answered by `reply`. */
async function withEndpoint<Result>(reply: (body: Sent) => Response, run: (sent: Sent[]) => Promise<Result>): Promise<Result> {
  const sent: Sent[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    assert.equal(url, 'https://reference.test/v1/chat/completions')
    const body = JSON.parse(String(init?.body)) as Sent
    sent.push(body)
    return reply(body)
  }) as typeof fetch
  try {
    return await run(sent)
  } finally {
    globalThis.fetch = real
  }
}

const answer = (content: string, usage: Record<string, unknown> | null = { prompt_tokens: 7 + content.length, completion_tokens: 2 }): Response => Response.json({
  provider: 'Provider-A', choices: [{ message: { content }, finish_reason: 'stop' }], ...(usage ? { usage } : {}),
})

/** A limiter that counts what waits in it. */
function countingLimiter(): ReferenceRequestLimiter & { ran: string[] } {
  const inner = createReferenceRequestLimiter(config)
  const ran: string[] = []
  return {
    ran,
    run: (model, execute, signal) => {
      ran.push(model)
      return inner.run(model, execute, signal)
    },
    recordSuccess: (model) => inner.recordSuccess(model),
  }
}

function oracle(overrides: Partial<Parameters<typeof bankRouteOracle>[0]> = {}) {
  const catalogLoads: number[] = []
  const made = bankRouteOracle({
    model: 'model-a', config,
    catalog: async () => {
      catalogLoads.push(catalogLoads.length)
      return null
    },
    ...overrides,
  })
  return { oracle: made, catalogLoads }
}

test('the bank route oracle counts input tokens on the bank\'s route, each text as the only user message, through the limiter it is given', async () => {
  const limiter = countingLimiter()
  const { oracle: reference, catalogLoads } = oracle()
  await withEndpoint((body) => answer('Sure.', { prompt_tokens: 7 + body.messages[0]!.content.length, completion_tokens: 2 }), async (sent) => {
    const asked = await reference.inputTokens(bank, ['short', 'a longer text'], { maxTokens: 64, limiter })
    assert.deepEqual(asked.results.map((result) => [result.inputTokens, result.provider, result.failure]), [[12, 'Provider-A', null], [20, 'Provider-A', null]])
    assert.deepEqual(sent.map((body) => body.messages), [[{ role: 'user', content: 'short' }], [{ role: 'user', content: 'a longer text' }]])
    assert.deepEqual(sent.map((body) => [body.model, body.max_tokens, body.stream]), [['upstream-model-a', 64, false], ['upstream-model-a', 64, false]])
    assert.equal(asked.upstream.baseUrl, 'https://reference.test/v1')
    // A direct endpoint is no router: its settings say one provider.
    assert.equal(asked.oneProvider, true)
  })
  assert.deepEqual(limiter.ran, ['upstream-model-a', 'upstream-model-a'], 'every request waits in the limiter of the ask')
  assert.equal(catalogLoads.length, 1, 'the catalog is read once for the ask')
})

test('the bank route oracle reads the catalog again for every ask', async () => {
  const limiter = countingLimiter()
  const { oracle: reference, catalogLoads } = oracle()
  await withEndpoint(() => answer('Sure.'), async () => {
    await reference.inputTokens(bank, ['one'], { maxTokens: 64, limiter })
    await reference.replies(bank, { contents: ['two'], maxTokens: 64 }, { limiter })
    await reference.replies(bank, { bodies: [{ messages: [{ role: 'user', content: 'three' }] }] }, { limiter })
  })
  assert.equal(catalogLoads.length, 3)
})

test('the bank route oracle gives each reply\'s bytes with the request sent, under the reply limit asked for', async () => {
  const { oracle: reference } = oracle()
  await withEndpoint((body) => answer(`echo of ${body.messages[0]!.content}`), async (sent) => {
    const asked = await reference.replies(bank, { contents: ['first', 'second'], maxTokens: 48 }, { limiter: countingLimiter() })
    assert.deepEqual(sent.map((body) => [body.messages[0]!.content, body.max_tokens]), [['first', 48], ['second', 48]])
    assert.deepEqual(asked.results.map((result) => [result.failure, result.tries, result.rateLimited, result.provider]), [[null, 1, 0, 'Provider-A'], [null, 1, 0, 'Provider-A']])
    const replies = asked.results.map((result) => (JSON.parse(new TextDecoder().decode(result.response!.body)) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content)
    assert.deepEqual(replies, ['echo of first', 'echo of second'])
    assert.deepEqual(asked.results.map((result) => (JSON.parse(new TextDecoder().decode(result.requestBody)) as Sent).messages[0]!.content), ['first', 'second'])
    // Set to one provider, but not proven: a direct endpoint may itself be a router.
    assert.deepEqual([asked.oneProvider, asked.provenOneProvider], [true, false])
  })
})

test('the bank route oracle sends whole bodies as they are, and reads an answer without usage', async () => {
  const { oracle: reference } = oracle()
  const body = { messages: [{ role: 'user', content: 'pick' }], max_tokens: 220, temperature: 1 }
  await withEndpoint(() => answer('heads tails', null), async (sent) => {
    const asked = await reference.replies(bank, { bodies: [body] }, { limiter: countingLimiter() })
    assert.equal(sent.length, 1, 'an answer without usage is an answer on this route: it is not asked again')
    assert.deepEqual([sent[0]!.max_tokens, sent[0]!.temperature, sent[0]!.messages], [220, 1, body.messages])
    assert.equal(asked.results[0]!.failure, null)
    assert.match(new TextDecoder().decode(asked.results[0]!.response!.body), /heads tails/)
  })
  // The same answer to a text of the test's own is no answer: its count is what such a test reads.
  await withEndpoint(() => answer('heads tails', null), async (sent) => {
    const asked = await reference.replies(bank, { contents: ['pick'], maxTokens: 220 }, { limiter: countingLimiter() })
    assert.equal(sent.length, 3)
    assert.equal(asked.results[0]!.response, null)
  })
})

test('the bank route oracle never rejects for one request: a failed request is a result with its failure', async () => {
  const { oracle: reference } = oracle()
  await withEndpoint((body) => (body.messages[0]!.content === 'down' ? new Response('upstream unavailable', { status: 503 }) : answer('Sure.')), async () => {
    const counted = await reference.inputTokens(bank, ['up', 'down'], { maxTokens: 64, limiter: countingLimiter() })
    assert.deepEqual(counted.results.map((result) => result.inputTokens === null), [false, true])
    assert.match(counted.results[1]!.failure!, /upstream unavailable/)
    const replied = await reference.replies(bank, { contents: ['down', 'up'], maxTokens: 64 }, { limiter: countingLimiter() })
    assert.deepEqual(replied.results.map((result) => [result.response === null, result.tries]), [[true, 3], [false, 1]])
    assert.match(replied.results[0]!.failure!, /upstream unavailable/)
  })
})

test('the bank route oracle refuses a bank enrolled on another source, before any request', async () => {
  const { oracle: reference } = oracle()
  const elsewhere = { ...bank, provenance: { ...bank.provenance!, sourceId: 'another-source' } }
  await withEndpoint(() => answer('Sure.'), async (sent) => {
    const limiter = countingLimiter()
    await assert.rejects(reference.inputTokens(elsewhere, ['A'], { maxTokens: 64, limiter }), /but this bank was enrolled on another-source/)
    await assert.rejects(reference.replies(elsewhere, { contents: ['A'], maxTokens: 64 }, { limiter }), /but this bank was enrolled on another-source/)
    await assert.rejects(reference.replies(elsewhere, { bodies: [{ messages: [{ role: 'user', content: 'A' }] }] }, { limiter }), /but this bank was enrolled on another-source/)
    assert.equal(sent.length, 0)
    assert.deepEqual(limiter.ran, [])
  })
})

test('the bank route oracle sends nothing once its signal is aborted, and asks nothing again after it', async () => {
  const { oracle: reference } = oracle()
  const stopped = new AbortController()
  stopped.abort()
  await withEndpoint(() => answer('Sure.'), async (sent) => {
    const counted = await reference.inputTokens(bank, ['A'], { maxTokens: 64, limiter: countingLimiter(), signal: stopped.signal })
    assert.equal(sent.length, 0)
    assert.equal(counted.results[0]!.inputTokens, null)
    assert.match(counted.results[0]!.failure!, /time for the reference is up/)
  })
  // A reply still out when the signal aborts ends as a failed result, and is not asked a second time.
  const stop = new AbortController()
  const sent: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    sent.push(String(init?.body))
    setTimeout(() => stop.abort(), 5)
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  }) as typeof fetch
  try {
    const replied = await reference.replies(bank, { contents: ['A'], maxTokens: 64 }, { limiter: countingLimiter(), signal: stop.signal })
    assert.deepEqual([replied.results.length, replied.results[0]!.response, replied.results[0]!.tries], [1, null, 1])
    assert.equal(sent.length, 1)
  } finally {
    globalThis.fetch = real
  }
})
