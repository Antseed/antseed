// One seller's audit from its first request to its evidence file, held against stored copies
// (`fixtures/audit-golden/<scenario>.json`): everything it asked and in which order, every checkpoint it wrote, the
// evidence file and the summary it returned. The audit is the real `verifyModelTarget` over the four real screens;
// only the sellers and the reference behind them are mocks. It is here to show that a change to how an audit runs its
// tests changed nothing an audit does.
//
// A golden file is rewritten only on purpose: run this file with ANTSEED_UPDATE_AUDIT_GOLDEN=1 and read the diff before
// keeping it. Without that, a difference fails the test and prints the first fields that differ.
// ANTSEED_AUDIT_GOLDEN_DUMP=<folder> also writes what each scenario observed there, with every text and list in full:
// a golden file holds a long text or list by its hash (`shortened`), so to see what changed inside one, write the
// folder on the build before the change and on the build after it, and compare the two.
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import crypto, { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { THINKING_DISCOVERY_PROBES, canonicalHashBytes32, type KbfReferenceV1 } from '@antseed/fingerprints'
import {
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1, decodeHttpRequest, decodeHttpResponse, encodeHttpRequest, encodeHttpResponse,
  type PeerId, type PeerInfo,
} from '@antseed/node'
import { ConcurrencyLimiter } from './audit-concurrency.js'
import { decidedRecords, type ConfirmationIdentity, type StoredCheckRecords } from './audit-checks.js'
import { flaggingChecks, passedChecks } from './flagging-checks.js'
import { createFlipsScreen, flipsSeed } from './flips.js'
import type { FlipsPair } from './flips-score.js'
import { validateAuditMatchesSummary } from './model-audit.js'
import { referenceFixture } from './model-audit-fixtures.test-support.js'
import {
  verifyModelTarget,
  type ModelAuditCheckpointV1, type ModelVerificationResumeInput, type ModelVerificationSkip, type ModelVerificationTargetResult,
  type ProxyVerificationContext,
} from './model-run.js'
import { createOutputCapScreen, numberWords } from './output-cap.js'
import { createOutputEchoScreen, outputEchoPrompt } from './output-echo.js'
import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import type { ResponseAuthReader } from './response-auth-reader.js'
import { createTokenizerPrecheckScreen, measureTokenizerReference } from './tokenizer-precheck.js'

// A model FLIPS counts for (`flipsCounts`), so a FLIPS flag can decide and a FLIPS reference that is not whole can stop
// an audit. Every other name here is made up.
const MODEL = 'deepseek-v4-pro'
const SERVICE = MODEL
const SELLER = 'a1'.repeat(20)
/** The model's other sellers: the crowd of the pre-check and of the echo check. They are honest. */
const CROWD = ['b2', 'c3', 'd4'].map((pair) => pair.repeat(20))
const AUDITOR = `0x${'e5'.repeat(20)}`
const EPOCH = '7'
const RUN_ID = 'run-1'
const PROXY = 'http://127.0.0.1:8390'
/** The time every clock reading gives while an audit runs (`Date` is fixed, timers are not). */
const NOW = Date.parse('2026-10-07T00:00:00.000Z')
/** Thirty questions: three batches, so a checkpoint can hold some of them. */
const REFERENCE = referenceFixture(MODEL, 30)

// The audit draws from `crypto.randomInt` with no way to pass a seed: the prompt variant of each question batch, the
// cap check's prompt and limit, the texts the cap and echo checks write. Here each part of an audit draws from its own
// fixed stream, named by the part (`inPart`), so two parts that run at the same time cannot change each other's
// draws. Outside an audit the real function is used.

const part = new AsyncLocalStorage<{ name: string; streams: Map<string, () => number> }>()
const realRandomInt = crypto.randomInt as (...args: unknown[]) => unknown

function streamOf(name: string): () => number {
  // mulberry32, seeded from the part's name.
  let state = createHash('sha256').update(name).digest().readUInt32BE(0)
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

crypto.randomInt = ((...args: unknown[]) => {
  const drawing = part.getStore()
  if (!drawing || typeof args.at(-1) === 'function') return realRandomInt(...args)
  const [min, max] = typeof args[1] === 'number' ? [args[0] as number, args[1]] : [0, args[0] as number]
  let next = drawing.streams.get(drawing.name)
  if (!next) drawing.streams.set(drawing.name, next = streamOf(drawing.name))
  return min + Math.floor(next() * (max - min))
}) as typeof crypto.randomInt
// The compiled modules import `randomInt` by name: this makes their binding the function above.
syncBuiltinESMExports()

/** Runs `run` as a named part of the audit under way: its draws come from that part's stream. */
function inPart<Result>(name: string, run: () => Result): Result {
  const audit = part.getStore()
  return audit ? part.run({ name, streams: audit.streams }, run) : run()
}

// The model, as the mocks serve it.

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const text = (value: Uint8Array): string => new TextDecoder().decode(value)
/** Input tokens of a text, as the model's tokenizer counts them. */
const inputTokens = (content: string): number => Math.ceil(content.length / 4)
/** Output tokens of a text the model writes. */
const outputTokens = (written: string): number => Math.ceil(written.length / 3)
/** `count` words whose text, measured after a space, is `count` tokens of the model's (four characters each). */
const keptAnswer = (count: number): string => Array.from({ length: count }, () => 'one').join(' ')
/** An answer that ignores any reply limit: a long count in words. */
const LONG_ANSWER = Array.from({ length: 120 }, (_value, index) => numberWords(301 + index)).join(', ')

/** 64 symbols of a pair that pass for random: a fixed sequence for each `seed`. */
function randomSequence(pair: FlipsPair, seed: string): string {
  const next = streamOf(seed)
  return Array.from({ length: 64 }, () => pair[next() < 0.5 ? 0 : 1]).join(' ')
}
/** A reply that is no random source: nearly every symbol the pair's first word. Flagged at either stage's bar. */
const stuckSequence = (pair: FlipsPair, slot: number): string => (
  Array.from({ length: 64 }, (_value, index) => pair[index === slot || index === 63 - slot * 2 ? 1 : 0]).join(' ')
)

/** What one seller does. The defaults are an honest seller of the model. */
interface Seller {
  /** The input tokens it signs for a request's text, beside its own fixed wrapper. */
  inputTokens: (content: string) => number
  /** The output tokens it signs for a text it echoed. */
  echoTokens: (echoed: string) => number
  /** Its answer to a request with a reply limit, and what it bills for it. */
  capped: (cap: number) => { answer: string; billed: number }
  /** Its reply in a FLIPS slot: the `slot`th request of a pair. */
  sequence: (pair: FlipsPair, slot: number) => string
  /** Its question batches: answered right, refused because its upstream key is gone, or failing. */
  questions: 'answered' | 'key-deleted' | 'unavailable'
  /** A request with a reply limit is never answered: it ends when the audit stops. */
  cappedHangs: boolean
}

const HONEST: Seller = {
  inputTokens,
  echoTokens: outputTokens,
  capped: (cap) => ({ answer: keptAnswer(cap), billed: cap }),
  sequence: (pair, slot) => randomSequence(pair, `seller ${pair.join('/')} ${slot}`),
  questions: 'answered',
  cappedHangs: false,
}

/** What each request costs, by kind: unlike amounts, so a sum shows which were added and in which order. */
const COSTS = {
  'pre-check': { input: 100, output: 10, usd: 0.00012 },
  discovery: { input: 310, output: 40, usd: 0.00037 },
  question: { input: 420, output: 55, usd: 0.00053 },
  cap: { input: 30, output: 48, usd: 0.00009 },
  echo: { input: 260, output: 240, usd: 0.00071 },
  flips: { input: 60, output: 130, usd: 0.00019 },
} as const
type Kind = keyof typeof COSTS

/**
 * The sellers of the model behind one buyer proxy and the model's reference, with everything asked of either written
 * down in the order it was sent (`asked`) and every request id given a name made from what the request asked.
 */
class Network {
  /** Each thing asked. `lane` is null for what has a fixed place: the audited seller's own requests and the checkpoints. */
  private events: Array<{ lane: { together: string; name: string } | null; line: string }> = []
  private readonly signed = new Map<string, { request: Uint8Array; response: Uint8Array }>()
  private readonly counts = new Map<string, number>()
  /** The texts of the run's pre-check and echo check, each by what it is: a request with one is named by it. */
  private readonly precheckTexts = new Map<string, string>()
  private readonly echoTexts = new Map<string, string>()
  /** The name of each request id (`goldenCopy`). */
  readonly names = new Map<string, string>()
  /** Set while a scenario's earlier audit runs, so its requests are told from the later audit's. */
  phase = ''

  constructor(private readonly seller: Seller, private readonly options: { flipsReference?: 'whole' | 'holes' } = {}) {}

  private nth(key: string): number {
    const count = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, count)
    return count
  }

  private note(lane: { together: string; name: string } | null, line: string): void {
    this.events.push({ lane, line })
  }

  /** A checkpoint write, at its place among the requests. */
  checkpoint(line: string): void {
    this.note(null, line)
  }

  /**
   * What was asked since the last call, in the order sent. The audited seller's pre-check, discovery, question, cap and
   * echo requests are sent one after another, and so are the checkpoint writes and each lane's own requests: that order
   * is kept exactly. Lanes that are out at the same time have no order between them that the audit decides: the cap
   * and the echo reference (prepared together), the crowd sellers of one check, and the FLIPS slots of the two pairs
   * (two slots at once). Requests of such lanes that follow one another are therefore grouped by lane, the lanes in
   * name order, each lane keeping its own order. Nothing is left out.
   */
  asked(): string[] {
    const lines: string[] = []
    let together: string | null = null
    let run: Array<{ name: string; line: string }> = []
    const flush = (): void => {
      for (const name of [...new Set(run.map((event) => event.name))].sort()) lines.push(...run.filter((event) => event.name === name).map((event) => event.line))
      run = []
    }
    for (const event of this.events) {
      if (event.lane?.together !== together) flush()
      together = event.lane?.together ?? null
      if (event.lane) run.push({ name: event.lane.name, line: event.line })
      else lines.push(event.line)
    }
    flush()
    this.events = []
    return lines
  }

  /** The pre-check's probes, once its reference is measured: a seller's pre-check request is named by round and text. */
  precheckReady(probes: ReadonlyArray<{ a: string; b: string }>): void {
    for (const [index, probe] of probes.entries()) {
      this.precheckTexts.set(probe.a, `round ${index + 1} A`)
      this.precheckTexts.set(probe.a + probe.b, `round ${index + 1} A+B`)
    }
  }

  /** The echo check's texts, once its reference is measured: a seller's echo request is named by round and length. */
  echoReady(rounds: ReadonlyArray<{ short: { text: string }; long: { text: string } }>): void {
    for (const [index, round] of rounds.entries()) {
      this.echoTexts.set(round.short.text, `round ${index + 1} short`)
      this.echoTexts.set(round.long.text, `round ${index + 1} long`)
    }
  }

  readonly fetchFn: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers)
    const requestId = headers.get('x-antseed-request-id')!
    const peer = headers.get('x-antseed-pin-peer')!
    const raw = init!.body as Uint8Array
    const body = JSON.parse(text(raw)) as { messages: Array<{ role: string; content: string }>; max_tokens: number } & Record<string, unknown>
    const content = body.messages.find((message) => message.role === 'user')!.content
    const audited = peer === SELLER
    const who = audited ? 'seller' : `crowd seller ${CROWD.indexOf(peer) + 1}`
    const seller = audited ? this.seller : HONEST
    const asked = this.describe(content)
    const key = `${this.phase}${who}: ${asked.what}`
    const name = `${key} #${this.nth(key)}`
    this.names.set(requestId, name)
    // Beside its name, what the request was sent with: its reply limit and every setting in its body (the thinking
    // setting among them), and whether an assistant turn was appended.
    const { model: _model, messages, max_tokens: limit, stream: _stream, ...settings } = body
    const sent = `limit ${limit}${Object.keys(settings).length > 0 ? `, ${JSON.stringify(settings)}` : ''}${messages.at(-1)!.role === 'assistant' ? ', with a prefill' : ''}`
    // The FLIPS slots of the audited seller are out two at a time; a crowd seller's asks run beside the others'.
    this.note(!audited ? { together: `crowd ${asked.kind}`, name: peer }
      : asked.kind === 'flips' ? { together: 'FLIPS slots', name: asked.what } : null, `${name} (${sent})`)
    const cost = COSTS[asked.kind]
    const answered = (reply: unknown, status = 200): Response => {
      this.signed.set(requestId, {
        request: encodeHttpRequest({ requestId, method: 'POST', path: '/v1/chat/completions', headers: {}, body: raw }),
        response: encodeHttpResponse({ requestId, statusCode: status, headers: {}, body: bytes(reply) }),
      })
      return Response.json(reply, {
        status,
        headers: status === 200 ? {
          'x-antseed-request-id': requestId,
          'x-antseed-input-tokens': String(cost.input),
          'x-antseed-output-tokens': String(cost.output),
          'x-antseed-total-tokens': String(cost.input + cost.output),
          'x-antseed-input-usd-per-million': '1',
          'x-antseed-output-usd-per-million': '2',
          'x-antseed-estimated-cost-usd': String(cost.usd),
        } : {},
      })
    }
    const chat = (written: string, finish: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      ...extra, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: written }, finish_reason: finish }], usage,
    })
    switch (asked.kind) {
      case 'question': {
        if (seller.questions === 'key-deleted') return answered({ error: { message: 'The API key was deleted' } }, 401)
        if (seller.questions === 'unavailable') return answered({ error: { message: 'upstream unavailable' } }, 503)
        const values = [...content.matchAll(/test value (\d+) is ___/g)].map((match) => Number(match[1]))
        return answered(chat(values.map((value, index) => `(${index + 1}) ${value}`).join('\n'), 'stop', { prompt_tokens: 420, completion_tokens: 55 }))
      }
      case 'discovery': {
        // The seller ignores the first setting (it still reasons) and keeps the second.
        const reasoning = (body['reasoning'] as { effort?: string } | undefined)?.effort === 'none' ? 12 : 0
        const facts = THINKING_DISCOVERY_PROBES.map((probe, index) => `(${index + 1}) ${probe.consensus}`).join('\n')
        return answered(chat(facts, 'stop', { prompt_tokens: 310, completion_tokens: 40 + reasoning, completion_tokens_details: { reasoning_tokens: reasoning } }))
      }
      case 'pre-check':
        return answered(chat('ok', 'stop', { prompt_tokens: 40 + seller.inputTokens(content), completion_tokens: 3 }))
      case 'cap': {
        if (seller.cappedHangs) {
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error), { once: true })
          })
        }
        const { answer, billed } = seller.capped(body.max_tokens)
        return answered(chat(answer, 'length', { prompt_tokens: 30, completion_tokens: billed }))
      }
      case 'echo': {
        const echoed = content.split('\n\n').slice(1).join('\n\n')
        return answered(chat(echoed, 'stop', { prompt_tokens: 260, completion_tokens: seller.echoTokens(echoed) }))
      }
      case 'flips': {
        const slot = this.nth(`${this.phase}${who} flips ${asked.pair!.join('/')}`) - 1
        return answered(chat(seller.sequence(asked.pair!, slot), 'stop', { prompt_tokens: 60, completion_tokens: 130 }, { id: `reply-${asked.pair!.join('-')}-${slot}` }))
      }
    }
  }

  /** What a request to a seller asks, read from its text alone. */
  private describe(content: string): { kind: Kind; what: string; pair?: FlipsPair } {
    const batch = /test value (\d+) is ___/.exec(content)
    if (batch) return { kind: 'question', what: `question batch ${Math.floor((Number(batch[1]) - 1) / 10)}` }
    if (content.includes(THINKING_DISCOVERY_PROBES[0]!.template)) return { kind: 'discovery', what: 'thinking discovery' }
    const pair = /^Give a sequence of \d+ symbols drawn uniformly at random from the set \{(\w+), (\w+)\}/.exec(content)
    if (pair) return { kind: 'flips', what: `FLIPS slot ${pair[1]}/${pair[2]}`, pair: [pair[1]!, pair[2]!] }
    if (content.startsWith('Repeat the text below exactly')) {
      const echoed = content.split('\n\n').slice(1).join('\n\n')
      return { kind: 'echo', what: `echo ${this.echoTexts.get(echoed) ?? 'of an unknown text'}` }
    }
    const probe = this.precheckTexts.get(content)
    if (probe) return { kind: 'pre-check', what: `pre-check ${probe}` }
    return { kind: 'cap', what: 'cap ask' }
  }

  readonly responseAuthReader: ResponseAuthReader = {
    waitForVerified: async (input) => {
      const exchange = this.signed.get(input.requestId)!
      return {
        requestId: input.requestId,
        status: 'verified',
        // What a seller signs: who, for which request, for which service.
        responseAuth: { requestId: input.requestId, sellerPeerId: input.sellerPeerId, advertisedService: input.advertisedService } as never,
        signedPreimages: {
          encoding: 'antseed-http-codec-v1',
          signatureEncoding: 'antseed-response-auth-signing-v1',
          requestBase64: Buffer.from(exchange.request).toString('base64'),
          responseBase64: Buffer.from(exchange.response).toString('base64'),
          responseAuthSigningBase64: 'AA==',
          requestHash: `0x${'44'.repeat(32)}`,
          responseHash: `0x${'55'.repeat(32)}`,
        },
        failureReason: null,
      }
    },
    close() {},
  }

  // The reference: the model itself, asked by the auditor. Each ask is written down under the test it is for.

  private reference(check: string, line: string): void {
    // The cap and the echo reference are prepared together; every other reference is asked on its own.
    this.note({ together: check === 'cap' || check === 'echo' ? 'reference cap and echo' : `reference ${check}`, name: check }, `reference (${check}): ${line}`)
  }

  /** The reference's input tokens for each text: the model's tokenizer beside the endpoint's own fixed wrapper. */
  inputTokens(check: string) {
    return async (contents: readonly string[]) => {
      this.reference(check, `input tokens of ${contents.length} texts`)
      return {
        upstream: { kind: 'test' },
        results: contents.map((content) => ({ inputTokens: 7 + inputTokens(content), cachedInput: false, provider: 'maker', failure: null })),
      }
    }
  }

  /** The model's own host keeps a reply limit: it answers `cap` tokens and bills them. */
  readonly cappedReply = async (prompt: string, cap: number) => {
    this.reference('cap', `its own answer to a request with a limit of ${cap}`)
    return {
      requestBody: bytes({ messages: [{ role: 'user', content: prompt }], max_tokens: cap }),
      response: { statusCode: 200, body: bytes({ choices: [{ message: { content: keptAnswer(cap) }, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: cap } }) },
      provider: 'maker',
      oneProvider: true,
    }
  }

  /** The reference echoes every text exactly and bills what the model writes for it. */
  readonly echoes = async (texts: readonly string[]) => {
    // The check writes a short text, then a long one, round after round.
    const written = this.nth(`${this.phase}reference echo`)
    this.reference('echo', `echo of text ${written} (${written % 2 === 1 ? 'short' : 'long'}), ${texts.length} asks`)
    return {
      upstream: { kind: 'test' },
      results: texts.map((echoed) => ({
        requestBody: bytes({ messages: [{ role: 'user', content: outputEchoPrompt(echoed) }], max_tokens: 1024 }),
        response: {
          statusCode: 200,
          body: bytes({
            object: 'chat.completion', provider: 'maker',
            choices: [{ index: 0, message: { role: 'assistant', content: echoed }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 40, completion_tokens: outputTokens(echoed) },
          }),
        },
        provider: 'maker',
        failure: null,
      })),
    }
  }

  /** The reference's FLIPS replies: a random-looking sequence for each body, or no reply for some of them. */
  readonly sequences = async (bodies: readonly Record<string, unknown>[]) => {
    const ask = this.nth(`${this.phase}reference flips`)
    this.reference('FLIPS', `${bodies.length} replies${ask > 1 ? ' asked again' : ''}`)
    return {
      upstream: { kind: 'test' },
      oneProvider: true,
      results: bodies.map((body, index) => {
        const prompt = (body['messages'] as Array<{ content: string }>)[0]!.content
        const pair = /\{(\w+), (\w+)\}/.exec(prompt)!
        if (this.options.flipsReference === 'holes' && index % 7 === 3) {
          return { requestBody: bytes(body), response: null, provider: null, failure: 'the reference answered HTTP 502' }
        }
        const reply = {
          object: 'chat.completion', provider: 'maker',
          choices: [{ index: 0, message: { role: 'assistant', content: randomSequence([pair[1]!, pair[2]!], `reference ${pair[1]}/${pair[2]} ${ask} ${index}`) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 60, completion_tokens: 130 },
        }
        return { requestBody: bytes(body), response: { statusCode: 200, body: bytes(reply) }, provider: 'maker', failure: null }
      }),
    }
  }
}

interface AuditInput {
  auditId: string
  confirming?: ConfirmationIdentity
  carried?: StoredCheckRecords
  resume?: ModelVerificationResumeInput
  extension?: true
  lastAuditorAttempt?: true
  /** The seller's idle limit; short in the scenario whose audit runs out of time. */
  auditTimeoutMs?: number
}

interface Observed {
  /** Everything asked and every checkpoint write, in order (`Network.asked`). */
  asked: string[]
  /** What `verifyModelTarget` returned, or the error it failed with. */
  returned: ModelVerificationTargetResult | ModelVerificationSkip | { failed: string }
  /** The evidence file the result names: an audit's, or a skip's. */
  evidence: ProxyAuditEvidenceV1 | Record<string, unknown> | null
  /**
   * The evidence file as submit reads it: the tests that flagged and passed, and whether submit's check of the summary
   * against it accepts the pair (`validateAuditMatchesSummary`), or why not.
   */
  read: { flaggedBy: string[]; passedBy: string[]; submit: string } | null
  /** Every file the audit wrote under its evidence folder. */
  files: string[]
  /** The last checkpoint written, without its exchanges and records (the evidence holds them). */
  lastCheckpoint: Record<string, unknown> | null
  /** Every checkpoint as written, for a scenario that resumes from one. */
  checkpoints: ModelAuditCheckpointV1[]
}

/**
 * The run's context for one model: the four real screens over the network, wired as `verifier run` wires them. This
 * is the one place that knows how a screen is handed to the audit.
 */
function contextFor(network: Network, evidenceDir: string, input: AuditInput, checkpoints: ModelAuditCheckpointV1[]): ProxyVerificationContext {
  const sellers = [SELLER, ...CROWD].map((peerId) => ({ peerId, service: SERVICE }))
  const limiter = new ConcurrencyLimiter(4)
  const proxy = { proxyBaseUrl: PROXY, responseAuthReader: network.responseAuthReader, fetchFn: network.fetchFn }
  const tokenizerPrecheck = createTokenizerPrecheckScreen<KbfReferenceV1>({
    ...proxy, sellers, limiter,
    // As the run does: the probes are written here, and measured on the reference once.
    reference: async () => {
      const measured = await measureTokenizerReference({ ask: network.inputTokens('pre-check') })
      network.precheckReady(measured.probes)
      return measured
    },
  })
  const outputCap = createOutputCapScreen<KbfReferenceV1>({
    ...proxy, limiter, ask: () => network.inputTokens('cap'), askReply: () => network.cappedReply,
  })
  const outputEcho = createOutputEchoScreen<KbfReferenceV1>({
    ...proxy, sellers, limiter, ask: () => network.echoes, onReady: (reference) => network.echoReady(reference.rounds),
  })
  const flips = createFlipsScreen<KbfReferenceV1>({
    ...proxy, model: MODEL, auditor: AUDITOR, epoch: EPOCH, limiter: new ConcurrencyLimiter(4),
    seedFor: (stage) => flipsSeed('a made-up master of the epoch', { model: MODEL, epoch: EPOCH, runId: RUN_ID, stage }),
    ask: () => network.sequences,
  })
  return {
    proxy: { baseUrl: PROXY, statePath: join(evidenceDir, 'buyer.state.json'), pid: 4242, peers: [] },
    evidenceDir,
    requestTimeoutMs: 10_000,
    auditTimeoutMs: input.auditTimeoutMs ?? 10_000,
    responseAuthReader: network.responseAuthReader,
    // One batch at a time: the order of the question batches is then the set's, and every checkpoint has its place.
    batchConcurrency: 1,
    batchConcurrencyPromotionLatencyMs: 30_000,
    batchLimiter: limiter,
    fetchFn: network.fetchFn,
    sleepFn: async () => undefined,
    randomFn: () => 0.5,
    writeCheckpoint: async (path, checkpoint) => {
      assert.equal(relative(evidenceDir, path), join('.checkpoints', `${input.auditId}.json`))
      checkpoints.push(structuredClone(checkpoint))
      const slots = Object.keys(checkpoint.records)
      network.checkpoint(`checkpoint ${checkpoints.length}: tests [${slots.join(', ')}], question batches [${checkpoint.exchanges.map((exchange) => `${exchange.batchIndex} ${exchange.status}`).join(', ')}]`)
    },
    sellerThinking: new Map(),
    // Each screen's work draws from its own stream (`inPart`).
    tokenizerPrecheck: {
      ready: (settings) => inPart('pre-check reference', () => tokenizerPrecheck.ready(settings)),
      check: (...args) => inPart('pre-check', () => tokenizerPrecheck.check(...args)),
    },
    outputCap: {
      ready: (settings) => inPart('cap reference', () => outputCap.ready(settings)),
      check: (...args) => inPart('cap check', () => outputCap.check(...args)),
    },
    outputEcho: {
      ready: (settings) => inPart('echo reference', () => outputEcho.ready(settings)),
      check: (...args) => inPart('echo check', () => outputEcho.check(...args)),
    },
    flips: {
      probing: flips.probing, probeSettings: flips.probeSettings, ruleId: flips.ruleId,
      warm: (...args) => inPart('FLIPS reference', () => flips.warm(...args)),
      referenceDecision: (...args) => inPart('FLIPS reference', () => flips.referenceDecision!(...args)),
      check: (...args) => inPart('FLIPS', () => flips.check(...args)),
    },
  }
}

function auditedPeer(): PeerInfo {
  return {
    peerId: SELLER as PeerId,
    displayName: 'Example Seller',
    lastSeen: NOW,
    providers: ['test'],
    capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1],
    onChainAgentId: 7,
    providerPricing: { test: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } },
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(directory, join(entry.parentPath, entry.name))).sort()
}

/** Runs one audit of the seller over the network and gathers what it asked, wrote and returned. */
async function audit(t: TestContext, network: Network, input: AuditInput): Promise<Observed> {
  // Every clock reading is one fixed time, so no time in the evidence needs a mask; timers still run.
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const evidenceDir = await mkdtemp(join(tmpdir(), 'antseed-audit-golden-'))
  const checkpoints: ModelAuditCheckpointV1[] = []
  try {
    const returned = await part.run({ name: 'audit', streams: new Map() }, () => verifyModelTarget({
      context: contextFor(network, evidenceDir, input, checkpoints),
      target: auditedPeer(),
      service: SERVICE,
      reference: REFERENCE,
      auditId: input.auditId,
      checkpointIdentity: { runId: RUN_ID, epoch: EPOCH, model: MODEL },
      ...(input.confirming ? { confirming: input.confirming } : {}),
      ...(input.carried ? { carried: input.carried } : {}),
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.extension ? { extension: true } : {}),
      ...(input.lastAuditorAttempt ? { lastAuditorAttempt: true } : {}),
    })).catch((error: Error) => ({ failed: error.message }))
    const asked = network.asked()
    const files = await filesUnder(evidenceDir)
    const last = checkpoints.at(-1)
    const lastCheckpoint = last ? (({ exchanges: _exchanges, records: _records, ...head }) => head)(last) : null
    if ('failed' in returned || returned.evidencePath === null) return { asked, returned, evidence: null, read: null, files, lastCheckpoint, checkpoints }
    const stored = JSON.parse(await readFile(returned.evidencePath, 'utf8')) as ProxyAuditEvidenceV1
    // The two derived values a mask stands for are checked here, on the file as written (`goldenCopy`).
    assert.equal(returned.evidenceHash, canonicalHashBytes32(stored), 'the summary names the hash of its evidence file')
    assert.equal(relative(evidenceDir, returned.evidencePath).startsWith('..'), false, 'the evidence file is under the evidence folder')
    const masked = { ...returned, evidencePath: relative(evidenceDir, returned.evidencePath), evidenceHash: HASH_OF_FILE }
    if (returned.status === 'SKIPPED') return { asked, returned: masked, evidence: stored, read: null, files, lastCheckpoint, checkpoints }
    for (const exchange of stored.exchanges) {
      if (!exchange.response) continue
      const { hash, ...hashed } = exchange.response
      assert.equal(hash, canonicalHashBytes32(hashed), 'a stored response names the hash of its status, headers and body')
    }
    const submit = ((): string => {
      try {
        validateAuditMatchesSummary(stored, returned)
        return 'accepted'
      } catch (error) {
        return `refused: ${(error as Error).message}`
      }
    })()
    const read = { flaggedBy: flaggingChecks(stored, returned.questionsStatus!), passedBy: passedChecks(stored, returned.questionsStatus!), submit }
    return { asked, returned: masked, evidence: stored, read, files, lastCheckpoint, checkpoints }
  } finally {
    t.mock.timers.reset()
    await rm(evidenceDir, { recursive: true, force: true })
  }
}

const HASH_OF_FILE = '<the hash of the evidence file>'
const HASH_OF_RESPONSE = '<the hash of this response>'

/**
 * Every field a golden file does not hold as the audit wrote it, and why. This is the whole list. Nothing else is
 * masked: times are one fixed time (`NOW`), random draws come from fixed streams (`inPart`), and the audit id and the
 * proxy's pid are given.
 *
 * - A request id, wherever it is stored (`requestIds`, `requestId`, the `x-antseed-request-id` header, a reason's
 *   text). It is random (`randomUUID`) and nothing can fix it. Stored: a name made from what the request asked
 *   (`Network.names`), so the golden file still says which request each stored id is.
 * - `signedPreimages.requestBase64` and `responseBase64`. The signed bytes hold the request id. Stored: the bytes
 *   decoded (the id by its name, the method and path or the status, the headers, the body as text).
 * - `exchanges[].response.hash`. A hash over the response's headers, which hold the request id. Checked against the
 *   stored response (`audit`), then stored as a mark.
 * - `evidenceHash` of the returned summary. A hash over the whole file, request ids included. Checked against the file
 *   as written (`audit`), then stored as a mark.
 * - `evidencePath` of the returned summary. Under a temporary folder. Stored from the evidence folder on.
 *
 * Not a mask: `bodyBase64` of a question batch's request and response is stored as the text it encodes, so a
 * difference in it can be read.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** The copy of an observed value a golden file holds: the masks above applied. */
function goldenCopy(value: unknown, names: ReadonlyMap<string, string>, key = '', parent = ''): unknown {
  if (typeof value === 'string') {
    if (parent === 'signedPreimages' && key === 'requestBase64') {
      const { requestId, body, ...head } = decodeHttpRequest(Buffer.from(value, 'base64'))
      return { requestId: goldenCopy(requestId, names), ...head, body: text(body) }
    }
    if (parent === 'signedPreimages' && key === 'responseBase64') {
      const { requestId, body, ...head } = decodeHttpResponse(Buffer.from(value, 'base64'))
      return { requestId: goldenCopy(requestId, names), ...head, body: text(body) }
    }
    if (parent === 'response' && key === 'hash') return HASH_OF_RESPONSE
    if (key === 'bodyBase64') return text(Buffer.from(value, 'base64'))
    return value.replace(UUID, (id) => `<${names.get(id) ?? 'a request id nothing was asked with'}>`)
  }
  if (Array.isArray(value)) return value.map((entry) => goldenCopy(entry, names, key, parent))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, goldenCopy(entry, names, name, key)]))
  }
  return value
}

/**
 * A value as a golden file holds it, small enough to review: a text over 120 characters as its start, its length and
 * its hash, and a list of more than eight records as its size, the hash of all of it, its first record and its last
 * (the 40 reference replies of a FLIPS pair, its seller slots, the question set). A change anywhere still changes the
 * file. `asked` is never cut.
 */
function shortened(value: unknown, key = ''): unknown {
  const sha = (of: string): string => createHash('sha256').update(of).digest('hex').slice(0, 16)
  if (typeof value === 'string' && value.length > 120 && key !== 'asked') return `${value.slice(0, 72)}… (${value.length} characters, sha256 ${sha(value)})`
  if (Array.isArray(value)) {
    if (value.length > 8 && value.every((entry) => entry !== null && typeof entry === 'object')) {
      return { list: `${value.length} records: the first and the last are shown`, sha256: sha(JSON.stringify(value)), first: shortened(value[0]), last: shortened(value.at(-1)) }
    }
    return value.map((entry) => shortened(entry, key))
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, shortened(entry, name)]))
  return value
}

/** JSON with every member that fits written on one line, so a golden file reads like a record and diffs line by line. */
function written(value: unknown, indent = ''): string {
  const inline = JSON.stringify(value)
  if (inline === undefined || inline.length + indent.length <= 160 || value === null || typeof value !== 'object') return inline
  const inner = `${indent} `
  if (Array.isArray(value)) return `[\n${value.map((entry) => `${inner}${written(entry, inner)}`).join(',\n')}\n${indent}]`
  return `{\n${Object.entries(value).map(([name, entry]) => `${inner}${JSON.stringify(name)}: ${written(entry, inner)}`).join(',\n')}\n${indent}}`
}

/** Every leaf of a value by its path, in the value's own order. */
function leaves(value: unknown, path = '', out = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value) && value.length > 0) value.forEach((entry, index) => leaves(entry, `${path}[${index}]`, out))
  else if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
    for (const [name, entry] of Object.entries(value)) leaves(entry, path ? `${path}.${name}` : name, out)
  } else out.set(path, JSON.stringify(value))
  return out
}

const here = dirname(fileURLToPath(import.meta.url))
// The compiled test runs from `dist`; the golden files stay in `src`, like the FLIPS fixtures.
const goldenDir = [join(here, 'fixtures', 'audit-golden'), join(here, '..', '..', 'src', 'verifier', 'fixtures', 'audit-golden')].find((path) => existsSync(path))
  ?? join(here, '..', '..', 'src', 'verifier', 'fixtures', 'audit-golden')
const recordsDir = join(goldenDir, 'records')
const updating = process.env['ANTSEED_UPDATE_AUDIT_GOLDEN'] === '1'

/**
 * The parts of an evidence file that many scenarios store alike (an honest pre-check, an answered batch, the question
 * set): each is kept once, in `records/<part>-<hash of its text>.json`, and a scenario's file names it.
 */
const RECORDS = ['reference', 'sellerThinking', 'tokenizerPrecheck', 'outputCap', 'outputEcho', 'flips', 'exchange'] as const

/** A scenario's copy with its evidence's records taken out: what its own file holds, and the record files it names. */
function recordsApart(copy: { evidence?: Record<string, unknown> | null }): { scenario: unknown; records: Map<string, string> } {
  const records = new Map<string, string>()
  const named = (part: string, record: unknown): unknown => {
    if (record === null || typeof record !== 'object') return record
    const stored = `${written(record)}\n`
    const name = `${part}-${createHash('sha256').update(stored).digest('hex').slice(0, 16)}`
    records.set(name, stored)
    return { record: name }
  }
  if (!copy.evidence) return { scenario: copy, records }
  const evidence = Object.fromEntries(Object.entries(copy.evidence).map(([name, entry]) => [
    name,
    name === 'exchanges' && Array.isArray(entry) ? entry.map((exchange) => named('exchange', exchange))
      : (RECORDS as readonly string[]).includes(name) ? named(name, entry) : entry,
  ]))
  return { scenario: { ...copy, evidence }, records }
}

/** A scenario's golden file with every record it names read back in. */
function goldenOf(path: string): unknown {
  const read = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))
  const whole = (entry: unknown): unknown => {
    const name = entry && typeof entry === 'object' ? (entry as { record?: unknown }).record : undefined
    return typeof name === 'string' ? read(join(recordsDir, `${name}.json`)) : entry
  }
  const scenario = read(path) as { evidence?: Record<string, unknown> | null }
  if (!scenario.evidence) return scenario
  const evidence = Object.fromEntries(Object.entries(scenario.evidence).map(([name, entry]) => [name, Array.isArray(entry) ? entry.map(whole) : whole(entry)]))
  return { ...scenario, evidence }
}

/** Holds what a scenario observed against its golden file, field by field. */
async function expectGolden(name: string, about: string, network: Network, observed: Observed): Promise<void> {
  const { checkpoints: _checkpoints, ...kept } = observed
  const full = { scenario: name, about, ...goldenCopy(kept, network.names) as object }
  // Through JSON, so that what is compared is what a file holds (a member that is undefined is not in it).
  const copy = JSON.parse(JSON.stringify(shortened(full))) as { evidence?: Record<string, unknown> | null }
  const dump = process.env['ANTSEED_AUDIT_GOLDEN_DUMP']
  if (dump) {
    await mkdir(dump, { recursive: true })
    await writeFile(join(dump, `${name}.json`), `${JSON.stringify(full, null, 1)}\n`)
  }
  const path = join(goldenDir, `${name}.json`)
  if (updating) {
    const { scenario, records } = recordsApart(copy)
    await mkdir(recordsDir, { recursive: true })
    await writeFile(path, `${written(scenario)}\n`)
    for (const [record, stored] of records) await writeFile(join(recordsDir, `${record}.json`), stored)
    return
  }
  assert.ok(existsSync(path), `no golden file for ${name}: run with ANTSEED_UPDATE_AUDIT_GOLDEN=1 to write it, and read it before keeping it`)
  const golden = goldenOf(path) as { asked?: string[] }
  const now = copy as { asked?: string[] }
  const differences: string[] = []
  // What was asked is one sequence: one request more or less would show as a difference at every later place, so it is
  // shown once, from the first place that differs.
  const [askedBefore, askedNow] = [golden.asked ?? [], now.asked ?? []]
  const from = askedBefore.findIndex((line, index) => line !== askedNow[index])
  const first = from >= 0 ? from : askedNow.length > askedBefore.length ? askedBefore.length : -1
  if (first >= 0) {
    const some = (lines: string[]): string => lines.slice(first, first + 6).map((line, index) => `\n      ${first + index}: ${line}`).join('') || '\n      (nothing more)'
    differences.push(`asked, from entry ${first} on (${askedBefore.length} entries in the golden file, ${askedNow.length} now)\n    golden:${some(askedBefore)}\n    now:${some(askedNow)}`)
  }
  const expected = leaves({ ...golden, asked: null })
  const actual = leaves({ ...now, asked: null })
  for (const [field, value] of expected) {
    if (!actual.has(field)) differences.push(`${field}\n    golden: ${value}\n    now:    (not there)`)
    else if (actual.get(field) !== value) differences.push(`${field}\n    golden: ${value}\n    now:    ${actual.get(field)}`)
  }
  for (const [field, value] of actual) if (!expected.has(field)) differences.push(`${field}\n    golden: (not there)\n    now:    ${value}`)
  if (differences.length > 0) {
    assert.fail(`${name}: ${differences.length} field(s) differ from ${relative(process.cwd(), path)}. The first ${Math.min(differences.length, 12)}:\n  `
      + `${differences.slice(0, 12).join('\n  ')}\n`
      + 'If the change is meant, rewrite the file with ANTSEED_UPDATE_AUDIT_GOLDEN=1 and read its diff.')
  }
}

/** A confirmation's report: another auditor's DIFF by `checks`, an hour before the audit. */
const report = (...checks: ConfirmationIdentity['checks']): ConfirmationIdentity => ({ checks, reportedAt: NOW / 1_000 - 3_600 })
/** A seller that counts input with another tokenizer than the model's. */
const OTHER_COUNT: Partial<Seller> = { inputTokens: (content) => Math.ceil(content.length / 2.5) }
/** A seller that bills a quarter more output than the model writes. */
const OVERBILLED: Partial<Seller> = { echoTokens: (echoed) => Math.round(outputTokens(echoed) * 1.25) }
/** A seller that ignores the reply limit. */
const UNCAPPED: Partial<Seller> = { capped: () => ({ answer: LONG_ANSWER, billed: 900 }) }
/** A seller whose FLIPS replies are not random. */
const STUCK: Partial<Seller> = { sequence: stuckSequence }
const sellerThat = (differs: Partial<Seller>): Seller => ({ ...HONEST, ...differs })

/** The test records of an audit's evidence file. */
function recordsOf(observed: Observed): StoredCheckRecords {
  const { tokenizerPrecheck, outputCap, outputEcho, flips } = observed.evidence as ProxyAuditEvidenceV1
  return {
    ...(tokenizerPrecheck ? { tokenizerPrecheck } : {}), ...(outputCap ? { outputCap } : {}), ...(outputEcho ? { outputEcho } : {}), ...(flips ? { flips } : {}),
  }
}

/**
 * An earlier audit of a scenario's seller, whose records or checkpoints the scenario's own audit starts from. Its
 * requests are named apart, and it is not held against a golden file.
 */
async function earlier(t: TestContext, network: Network, input: AuditInput): Promise<Observed> {
  network.phase = 'earlier attempt, '
  const observed = await audit(t, network, input)
  network.phase = ''
  assert.ok(observed.evidence, 'the earlier attempt finished')
  return observed
}

/**
 * A resume from a checkpoint of an earlier attempt, as the run builds it. The run names the checkpoint file's hash as
 * the parent's; that file holds request ids, so a fixed stand-in is given here.
 */
const resumeFrom = (checkpoint: ModelAuditCheckpointV1): ModelVerificationResumeInput => ({
  parentAuditId: checkpoint.auditId,
  reservationAuditId: checkpoint.reservationAuditId!,
  parentEvidenceHash: `0x${'9f'.repeat(32)}`,
  exchanges: checkpoint.exchanges,
  records: checkpoint.records,
})

type Expect = (network: Network, observed: Observed) => Promise<void>
const scenario = (name: string, about: string, run: (t: TestContext, expect: Expect) => Promise<void>): void => {
  test(`audit golden: ${about}`, (t) => run(t, (network, observed) => expectGolden(name, about, network, observed)))
}

scenario('a-honest-first-look', 'an honest seller\'s first look: every test passes', async (t, expect) => {
  const network = new Network(HONEST)
  await expect(network, await audit(t, network, { auditId: 'audit-a' }))
})

scenario('b-cap-flag', 'a seller that ignores the reply limit is flagged by the cap check, and the other tests still run', async (t, expect) => {
  const network = new Network(sellerThat(UNCAPPED))
  await expect(network, await audit(t, network, { auditId: 'audit-b' }))
})

scenario('c-precheck-mismatch-backed-by-crowd', 'a seller off the reference\'s token count in every round, with the model\'s other sellers on it: a pre-check mismatch', async (t, expect) => {
  const network = new Network(sellerThat(OTHER_COUNT))
  await expect(network, await audit(t, network, { auditId: 'audit-c' }))
})

scenario('d-confirm-flips-flag', 'a confirmation of a FLIPS flag asks FLIPS at the confirmation stage, and repeats the flag', async (t, expect) => {
  const network = new Network(sellerThat(STUCK))
  await expect(network, await audit(t, network, { auditId: 'audit-d-flips', confirming: report('flips') }))
})

scenario('d-confirm-cap-flag', 'a confirmation of a cap flag repeats the flag; its FLIPS is a first look\'s', async (t, expect) => {
  const network = new Network(sellerThat(UNCAPPED))
  await expect(network, await audit(t, network, { auditId: 'audit-d-cap', confirming: report('output-cap') }))
})

scenario('e-retry-carries-decided-records', 'a retry carries the tests that decided and asks none of them again, but a carried FLIPS of the other stage is asked again', async (t, expect) => {
  const network = new Network(HONEST)
  // The earlier attempt confirmed a FLIPS flag, so its FLIPS is the confirmation stage's; the retry is a first look.
  const attempt = await earlier(t, network, { auditId: 'audit-e-earlier', confirming: report('flips') })
  const carried = decidedRecords(recordsOf(attempt))
  assert.deepEqual([Object.keys(carried), carried.flips?.draw.stage], [['tokenizerPrecheck', 'outputCap', 'outputEcho', 'flips'], 'confirm'])
  await expect(network, await audit(t, network, { auditId: 'audit-e', carried }))
})

scenario('f-resume-after-first-batch', 'a resume from the checkpoint written after the first question batch: the pre-check and that batch are not asked again', async (t, expect) => {
  const network = new Network(HONEST)
  const attempt = await earlier(t, network, { auditId: 'audit-f-earlier' })
  const checkpoint = attempt.checkpoints.find((written) => written.exchanges.length === 1)!
  assert.deepEqual(Object.keys(checkpoint.records), ['tokenizerPrecheck'])
  await expect(network, await audit(t, network, { auditId: 'audit-f', resume: resumeFrom(checkpoint) }))
})

scenario('f-resume-after-cap-check', 'a resume from the checkpoint written after the cap check: only the echo check and FLIPS are left, asked with the seller\'s own thinking setting', async (t, expect) => {
  const network = new Network(HONEST)
  const attempt = await earlier(t, network, { auditId: 'audit-f-earlier' })
  const checkpoint = attempt.checkpoints.find((written) => written.records.outputCap && !written.records.outputEcho)!
  assert.equal(checkpoint.exchanges.length, 3)
  await expect(network, await audit(t, network, { auditId: 'audit-f-cap', resume: resumeFrom(checkpoint) }))
})

scenario('g-skipped-after-flag', 'a seller skipped at its first question batch after its pre-check flagged: the flag stands, and nothing more is asked', async (t, expect) => {
  const network = new Network(sellerThat({ ...OTHER_COUNT, questions: 'key-deleted' }))
  await expect(network, await audit(t, network, { auditId: 'audit-g-flag' }))
})

scenario('g-skipped-no-flag', 'a seller skipped at its first question batch with no flag: a skip, with what its pre-check cost', async (t, expect) => {
  const network = new Network(sellerThat({ questions: 'key-deleted' }))
  await expect(network, await audit(t, network, { auditId: 'audit-g-skip' }))
})

scenario('h-flips-reference-not-whole', 'a FLIPS reference that is not whole, where FLIPS counts: the audit is not started and the seller is asked nothing', async (t, expect) => {
  const network = new Network(HONEST, { flipsReference: 'holes' })
  await expect(network, await audit(t, network, { auditId: 'audit-h' }))
})

scenario('h-flips-reference-not-whole-last-attempt', 'the same on the auditor\'s last attempt: the audit runs, without FLIPS', async (t, expect) => {
  const network = new Network(HONEST, { flipsReference: 'holes' })
  await expect(network, await audit(t, network, { auditId: 'audit-h-last', lastAuditorAttempt: true }))
})

scenario('i-close-call-extra-set', 'an extra set of a close call asks questions only', async (t, expect) => {
  const network = new Network(sellerThat({ ...OTHER_COUNT, ...UNCAPPED, ...OVERBILLED, ...STUCK }))
  await expect(network, await audit(t, network, { auditId: 'audit-i', extension: true }))
})

scenario('j-time-runs-out-in-cap-check', 'the seller\'s time runs out in the cap check: the echo check and FLIPS are not started', async (t, expect) => {
  const network = new Network(sellerThat({ cappedHangs: true }))
  await expect(network, await audit(t, network, { auditId: 'audit-j', auditTimeoutMs: 400 }))
})

scenario('k-echo-flag-after-precheck-match', 'a seller that bills more output than the model writes, after a pre-check that matched: the crowd is asked and the echo check flags', async (t, expect) => {
  const network = new Network(sellerThat(OVERBILLED))
  await expect(network, await audit(t, network, { auditId: 'audit-k-match' }))
})

scenario('k-echo-undecided-after-precheck-mismatch', 'the same seller after a pre-check mismatch: the echo check decides nothing and asks no crowd', async (t, expect) => {
  const network = new Network(sellerThat({ ...OVERBILLED, ...OTHER_COUNT }))
  await expect(network, await audit(t, network, { auditId: 'audit-k-mismatch' }))
})

scenario('l-questions-fail', 'a seller whose first question batch fails every try: no other test is started', async (t, expect) => {
  const network = new Network(sellerThat({ questions: 'unavailable' }))
  await expect(network, await audit(t, network, { auditId: 'audit-l' }))
})

scenario('m-carried-echo-without-its-precheck', 'a carried echo check whose pre-check is not carried is asked again with it; the cap check and FLIPS are carried', async (t, expect) => {
  const network = new Network(HONEST)
  const { tokenizerPrecheck: _precheck, ...carried } = recordsOf(await earlier(t, network, { auditId: 'audit-m-earlier' }))
  await expect(network, await audit(t, network, { auditId: 'audit-m', carried }))
})

test('audit golden: every stored record is named by a scenario', async () => {
  const named = new Set<string>()
  for (const file of await readdir(goldenDir)) {
    if (!file.endsWith('.json')) continue
    for (const [, record] of readFileSync(join(goldenDir, file), 'utf8').matchAll(/\{"record":"([^"]+)"\}/g)) named.add(`${record}.json`)
  }
  const unnamed = (await readdir(recordsDir)).filter((file) => !named.has(file))
  // A rewrite leaves the records the scenarios named before it: they are removed here, after every scenario has run.
  if (updating) for (const file of unnamed) await rm(join(recordsDir, file))
  else assert.deepEqual(unnamed, [], 'a record no scenario names is left in fixtures/audit-golden/records')
})
