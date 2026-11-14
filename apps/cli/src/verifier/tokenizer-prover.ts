import { randomInt, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AbstractSigner } from 'ethers'
import type { StoredResponseAuth } from '@antseed/node'
import {
  isShapeRequest,
  jsonSafeContent,
  pairDelta,
  shapeRequestBody,
  type ResolvedService,
  type SignedReceipt,
  type TokenizerParameters,
  type TokenizerProbePair,
  type TokenizerRound,
  type TokenizerShape,
} from '@antseed/node/payments'
import { mapConcurrently } from './audit-concurrency.js'
import type { ResponseAuthReader } from './response-auth-reader.js'

/** What the prover needs from `AntseedTokenizerAudits` (a `TokenizerAuditsClient`). */
export interface TokenizerAuditsReader {
  activeShapes(): Promise<TokenizerShape[]>
  parameters(): Promise<TokenizerParameters>
  resolveServices(entries: ReadonlyArray<{ seller: string; service: string }>): Promise<ResolvedService[]>
  checkProof(from: string, modelHash: string, rounds: readonly TokenizerRound[]): Promise<string | null>
  proveTokenizerMismatch(signer: AbstractSigner, modelHash: string, rounds: readonly TokenizerRound[]): Promise<string>
}

/** A discovered seller and the services it sells, as the buyer proxy's snapshot lists them. */
export interface TokenizerPeer {
  peerId: string
  displayName?: string
  providerPricing?: Record<string, { services?: Record<string, unknown> }>
  providerServiceApiProtocols?: Record<string, { services?: Record<string, string[]> }>
}

/** Writes a fresh probe: a short question A and a follow-up B, both plain text. */
export type ProbeGenerator = () => Promise<{ a: string; b: string }>

interface Member {
  peerId: string
  sellerName: string | null
  service: string
  agentId: bigint
  liveSame: boolean
  /** The shape in an API the service speaks natively, so the seller signs the body exactly as sent. */
  shape: TokenizerShape
}

/**
 * `mismatch`: off the references in every round (a proof). `match`: matched them in some round.
 * `inconclusive`: a request failed, had no signed receipt or usage, a round had too few agreeing references,
 * or the service speaks no API a shape covers.
 */
export type TokenizerOutcome = 'mismatch' | 'match' | 'inconclusive'

export interface TokenizerSuspectResult {
  peerId: string
  sellerName: string | null
  service: string
  modelHash: string
  /** The suspect's service has a live SAME: a mismatch is a usage flag, not a DIFF. */
  liveSame: boolean
  outcome: TokenizerOutcome
  reason: string | null
  /** The suspect's signed delta per round (null when missing). */
  deltas: Array<number | null>
  /** The agreeing references' smallest and largest delta per round (null when too few agreed). */
  referenceRanges: Array<{ min: number; max: number } | null>
  /** null when the simulated proof succeeds; the contract error otherwise. Only for mismatches. */
  proofCheck: string | null
  txHash: string | null
}

export interface TokenizerProverOptions {
  proxyBaseUrl: string
  peers: readonly TokenizerPeer[]
  reader: ResponseAuthReader
  contract: TokenizerAuditsReader
  generator: ProbeGenerator
  /** Signs and sends proofs; null measures and simulates only. */
  signer: { wallet: AbstractSigner; address: string } | null
  /** Address simulated proofs are sent from when there is no signer. */
  simulateFrom: string
  /** Rounds per pass (at least the contract's `minRounds`). */
  rounds?: number
  /** Only these service names (case-insensitive) as suspects, when given. References come from all. */
  services?: readonly string[]
  /** Only these sellers as suspects, when given. */
  peerIds?: readonly string[]
  concurrency?: number
  /**
   * Skips suspects checked within this many ms (state in `statePath`); inconclusive ones are retried after
   * at most `INCONCLUSIVE_RECHECK_MS`. A mismatch counts as checked only once its proof is sent, so a dry run
   * or a failed proof never holds back the next live pass.
   */
  recheckAfterMs?: number
  statePath?: string
  evidenceDir: string
  requestTimeoutMs?: number
  fetchFn?: typeof fetch
  now?: () => number
  log?: (line: string) => void
}

export interface TokenizerProverSummary {
  runId: string
  models: number
  suspects: number
  skipped: number
  results: TokenizerSuspectResult[]
  evidencePath: string
}

/** The API protocol each shape path is, as sellers declare it per service. */
const SHAPE_PROTOCOLS: Readonly<Record<string, string>> = {
  '/v1/chat/completions': 'openai-chat-completions',
  '/v1/messages': 'anthropic-messages',
  '/v1/responses': 'openai-responses',
}
/** Assumed for a service that declares no protocols (older seller metadata). */
const DEFAULT_PROTOCOL = 'openai-chat-completions'
const DEFAULT_CONCURRENCY = 8
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000
/** Retry window for an inconclusive suspect (a busy or unfunded seller often answers later). */
export const INCONCLUSIVE_RECHECK_MS = 6 * 3_600_000
const ZERO_HASH = /^0x0+$/

/** Every chat service a peer sells, with the API protocols it speaks for it. */
export function chatServices(peer: TokenizerPeer): Array<{ service: string; protocols: string[] }> {
  const protocolsByService = new Map<string, Set<string>>()
  for (const [provider, pricing] of Object.entries(peer.providerPricing ?? {})) {
    const declared = peer.providerServiceApiProtocols?.[provider]?.services ?? {}
    for (const service of Object.keys(pricing.services ?? {})) {
      const protocols = protocolsByService.get(service) ?? new Set<string>()
      for (const protocol of declared[service] ?? [DEFAULT_PROTOCOL]) protocols.add(protocol)
      protocolsByService.set(service, protocols)
    }
  }
  const chatProtocols = new Set(Object.values(SHAPE_PROTOCOLS))
  return [...protocolsByService]
    .map(([service, protocols]) => ({ service, protocols: [...protocols].filter((p) => chatProtocols.has(p)) }))
    .filter((entry) => entry.protocols.length > 0)
}

/** The first active shape in an API the service speaks; null when none is. */
export function shapeForProtocols(shapes: readonly TokenizerShape[], protocols: readonly string[]): TokenizerShape | null {
  return shapes.find((shape) => protocols.includes(SHAPE_PROTOCOLS[shape.path] ?? '')) ?? null
}

/**
 * One prover pass. For every model with enough live-SAME sellers, each round sends the same fresh prompt
 * pair (A, then A + B) to every seller of the model through the buyer proxy, in an API the seller speaks
 * natively, pinned to the seller with ResponseAuth preimages captured, and reads each seller's signed
 * prompt-token delta. A suspect off the references' agreed delta in every round is proved on-chain
 * (simulated without a signer).
 */
export async function runTokenizerProver(options: TokenizerProverOptions): Promise<TokenizerProverSummary> {
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  const shapes = await options.contract.activeShapes()
  if (shapes.length === 0) throw new Error('the tokenizer audits contract has no active request shape')
  const params = await options.contract.parameters()
  const roundCount = Math.max(params.minRounds, options.rounds ?? params.minRounds)

  const byModel = await sellersByModel(options, shapes)
  const wantedServices = options.services?.length ? new Set(options.services.map((s) => s.trim().toLowerCase())) : null
  const wantedPeers = options.peerIds?.length ? new Set(options.peerIds.map(normalizePeerId)) : null
  const state = options.statePath ? await readState(options.statePath) : {}
  const recheckAfterMs = options.recheckAfterMs ?? 0
  let skipped = 0
  const plan: Array<{ modelHash: string; members: Member[]; suspects: Member[] }> = []
  for (const [modelHash, members] of byModel) {
    // A model needs references besides any one suspect.
    if (members.filter((m) => m.liveSame).length < params.minReferences) continue
    const suspects = members.filter((m) => {
      if (wantedServices && !wantedServices.has(m.service.trim().toLowerCase())) return false
      if (wantedPeers && !wantedPeers.has(m.peerId)) return false
      if (checkedRecently(state[stateKey(m.peerId, m.service)], now(), recheckAfterMs)) {
        skipped++
        return false
      }
      return true
    })
    if (suspects.length) plan.push({ modelHash, members, suspects })
  }
  log(`${plan.length} models with ${params.minReferences}+ live-SAME references, ${plan.reduce((n, p) => n + p.suspects.length, 0)} suspects (${skipped} checked recently), ${roundCount} rounds`)

  // ── rounds: one fresh prompt, every seller of every planned model ──
  const rounds: ProbeRound[] = []
  for (let r = 0; r < roundCount && plan.length; r++) {
    let generated: { a: string; b: string }
    try {
      generated = await options.generator()
    } catch (error) {
      // Without every round nothing can be proved; the pass ends with inconclusive results.
      log(`  round ${r + 1}: ${error instanceof Error ? error.message : String(error)}`)
      break
    }
    const a = jsonSafeContent(generated.a).trim()
    const b = ' ' + jsonSafeContent(generated.b).trim()
    const jobs = plan.flatMap((p) => p.members.map((m) => ({ modelHash: p.modelHash, member: m })))
    const pairs = new Map<string, TokenizerProbePair | string>()
    await mapConcurrently(jobs, options.concurrency ?? DEFAULT_CONCURRENCY, async ({ modelHash, member }) => {
      pairs.set(memberKey(modelHash, member), await probePair(options, member, a, b))
    })
    rounds.push({ a, b, pairs, deltas: new Map() })
    log(`  round ${r + 1}: ${[...pairs.values()].filter((p) => typeof p !== 'string').length}/${jobs.length} signed pairs`)
  }

  // ── judge every suspect against the references of each round ──
  const results: TokenizerSuspectResult[] = []
  for (const { modelHash, members, suspects } of plan) {
    for (const suspect of suspects) {
      const result = await judge(options, params, modelHash, members, suspect, rounds)
      results.push(result)
      const key = stateKey(suspect.peerId, suspect.service)
      if (result.outcome === 'mismatch' && !result.txHash) delete state[key]
      else state[key] = { checkedAt: now(), outcome: result.outcome }
      log(describeResult(result))
    }
  }

  const runId = `tokenizer-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const evidencePath = join(options.evidenceDir, 'tokenizer', `${runId}.json`)
  await mkdir(dirname(evidencePath), { recursive: true })
  await writeFile(evidencePath, `${JSON.stringify({
    version: 1,
    runId,
    shapes,
    parameters: params,
    rounds: rounds.map((round) => ({ a: round.a, b: round.b })),
    prover: options.signer?.address ?? null,
    results,
  }, null, 2)}\n`)
  if (options.statePath) await writeState(options.statePath, state)
  return { runId, models: plan.length, suspects: results.length, skipped, results, evidencePath }
}

/**
 * Every resolvable seller service of each model, keyed by model hash. An agent may sell a model under several
 * services: each is a suspect of its own, and `agreeingReferences` takes one per agent.
 */
async function sellersByModel(options: TokenizerProverOptions, shapes: readonly TokenizerShape[]): Promise<Map<string, Member[]>> {
  const offered = options.peers.flatMap((peer) => chatServices(peer).flatMap(({ service, protocols }) => {
    const shape = shapeForProtocols(shapes, protocols)
    return shape ? [{ peer, service, shape }] : []
  }))
  const resolved = await options.contract.resolveServices(offered.map((o) => ({ seller: o.peer.peerId, service: o.service })))
  const byModel = new Map<string, Member[]>()
  offered.forEach((o, index) => {
    const r = resolved[index]!
    if (r.agentId === 0n || ZERO_HASH.test(r.modelHash)) return
    const members = byModel.get(r.modelHash) ?? []
    members.push({
      peerId: normalizePeerId(o.peer.peerId),
      sellerName: o.peer.displayName ?? null,
      service: o.service,
      agentId: r.agentId,
      liveSame: r.liveSame,
      shape: o.shape,
    })
    byModel.set(r.modelHash, members)
  })
  return byModel
}

/** Whether a suspect was checked within its recheck window (shorter for an inconclusive result). */
function checkedRecently(last: ProverState[string] | undefined, now: number, recheckAfterMs: number): boolean {
  if (!last) return false
  const window = last.outcome === 'inconclusive' ? Math.min(recheckAfterMs, INCONCLUSIVE_RECHECK_MS) : recheckAfterMs
  return now - last.checkedAt < window
}

async function judge(
  options: TokenizerProverOptions,
  params: TokenizerParameters,
  modelHash: string,
  members: Member[],
  suspect: Member,
  rounds: ProbeRound[],
): Promise<TokenizerSuspectResult> {
  const result: TokenizerSuspectResult = {
    peerId: suspect.peerId, sellerName: suspect.sellerName, service: suspect.service, modelHash, liveSame: suspect.liveSame,
    outcome: 'inconclusive', reason: null, deltas: [], referenceRanges: [], proofCheck: null, txHash: null,
  }
  const proofRounds: TokenizerRound[] = []
  let matched = false
  for (const round of rounds) {
    const own = round.pairs.get(memberKey(modelHash, suspect))
    const delta = measuredDelta(round, modelHash, suspect)
    result.deltas.push(delta)
    const candidates = members.filter((m) => m.liveSame && m.agentId !== suspect.agentId)
    const references = agreeingReferences(round, modelHash, candidates, params.tolerance)
    const range = references.length >= params.minReferences
      ? { min: references[0]!.delta, max: references[references.length - 1]!.delta }
      : null
    result.referenceRanges.push(range)
    if (delta === null) {
      result.reason ??= typeof own === 'string' ? own : 'no signed usage'
      continue
    }
    if (range === null) {
      result.reason ??= 'too few references agreed'
      continue
    }
    // As the contract judges it: a mismatch is more than `tolerance` outside the references' range.
    if (delta >= range.min - params.tolerance && delta <= range.max + params.tolerance) {
      matched = true
      continue
    }
    proofRounds.push({
      a: round.a, b: round.b, suspect: own as TokenizerProbePair,
      references: references.slice(0, params.minReferences).map((r) => r.pair),
    })
  }
  if (matched) return { ...result, outcome: 'match', reason: null }
  if (proofRounds.length < rounds.length || proofRounds.length < params.minRounds) return result

  result.outcome = 'mismatch'
  result.reason = null
  const from = options.signer?.address ?? options.simulateFrom
  result.proofCheck = await options.contract.checkProof(from, modelHash, proofRounds)
  if (result.proofCheck !== null || !options.signer) return result
  try {
    result.txHash = await options.contract.proveTokenizerMismatch(options.signer.wallet, modelHash, proofRounds)
  } catch (error) {
    result.reason = `proof transaction failed: ${error instanceof Error ? error.message : String(error)}`
  }
  return result
}

/**
 * The largest set of references, one service per agent, whose deltas all lie within `tolerance` of each other
 * (the contract checks their whole range), sorted by delta.
 */
function agreeingReferences(
  round: ProbeRound,
  modelHash: string,
  references: Member[],
  tolerance: number,
): Array<{ delta: number; pair: TokenizerProbePair }> {
  const byAgent = new Map<bigint, { delta: number; pair: TokenizerProbePair }>()
  for (const member of references) {
    if (byAgent.has(member.agentId)) continue
    const delta = measuredDelta(round, modelHash, member)
    if (delta !== null) byAgent.set(member.agentId, { delta, pair: round.pairs.get(memberKey(modelHash, member)) as TokenizerProbePair })
  }
  const measured = [...byAgent.values()].sort((x, y) => x.delta - y.delta)
  let best: typeof measured = []
  for (let start = 0, end = 0; start < measured.length; start++) {
    while (end < measured.length && measured[end]!.delta - measured[start]!.delta <= tolerance) end++
    if (end - start > best.length) best = measured.slice(start, end)
  }
  return best
}

/** A member's signed delta in a round, read once per round; null without a signed pair or usage. */
function measuredDelta(round: ProbeRound, modelHash: string, member: Member): number | null {
  const key = memberKey(modelHash, member)
  if (!round.deltas.has(key)) {
    const pair = round.pairs.get(key)
    round.deltas.set(key, pair && typeof pair !== 'string' ? pairDelta(pair) : null)
  }
  return round.deltas.get(key) ?? null
}

/** One base/probed pair for a seller, sending its shape's requests byte for byte; an error string on failure. */
async function probePair(options: TokenizerProverOptions, member: Member, a: string, b: string): Promise<TokenizerProbePair | string> {
  const { shape } = member
  const base = await signedRequest(options, member, shapeRequestBody(shape, member.service, a))
  if (typeof base === 'string') return base
  const probed = await signedRequest(options, member, shapeRequestBody(shape, member.service, a + b))
  if (typeof probed === 'string') return probed
  if (!isShapeRequest(base, shape, a) || !isShapeRequest(probed, shape, a + b)) {
    return 'the seller signed a different request than the one sent (e.g. a translated protocol)'
  }
  return { shapeId: shape.shapeId, base, probed }
}

async function signedRequest(options: TokenizerProverOptions, member: Member, body: string): Promise<SignedReceipt | string> {
  const requestId = randomUUID()
  try {
    const response = await (options.fetchFn ?? fetch)(`${options.proxyBaseUrl.replace(/\/$/, '')}${member.shape.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-antseed-pin-peer': member.peerId,
        'x-antseed-request-id': requestId,
        'x-antseed-capture-response-auth-preimages': '1',
      },
      body,
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    })
    await response.arrayBuffer()
    if (response.status !== 200) return `seller answered HTTP ${response.status}`
  } catch (error) {
    return `request failed: ${error instanceof Error ? error.message : String(error)}`
  }
  const evidence = await options.reader.waitForVerified({ requestId, sellerPeerId: member.peerId, advertisedService: member.service })
  const record = evidence.responseAuth
  if (evidence.status !== 'verified' || !record?.requestPreimage || !record.responsePreimage) {
    return evidence.failureReason ?? 'no verified ResponseAuth with preimages'
  }
  return toSignedReceipt(record)
}

function toSignedReceipt(record: StoredResponseAuth): SignedReceipt {
  const { receivedAt: _r, verified: _v, verificationError: _e, requestPreimage, responsePreimage, ...payload } = record
  return { payload, request: requestPreimage!, response: responsePreimage! }
}

const PROBE_SCRIPTS = ['Georgian', 'Amharic', 'Tamil', 'Thai', 'Korean', 'Hebrew', 'Arabic', 'Hindi', 'Greek', 'Armenian', 'Japanese', 'Khmer']
const PROBE_SNIPPETS = ['a SQL query', 'a bash command', 'a Python function', 'a JSON object', 'a stack trace line', 'a regex', 'a YAML block', 'a Rust match arm', 'a curl command', 'a CSS rule']

/**
 * A probe generator that asks a model on the network (through the buyer proxy) to write a realistic
 * message: a short question and a follow-up mixing code, a non-Latin script, emoji and numbers, which
 * different tokenizers split very differently.
 */
export function modelProbeGenerator(input: {
  proxyBaseUrl: string
  model: string
  peerId?: string
  /** Models (auto-routed) to try when `model` fails. */
  fallbackModels?: readonly string[]
  fetchFn?: typeof fetch
}): ProbeGenerator {
  const writers = [{ model: input.model, peerId: input.peerId }, ...(input.fallbackModels ?? []).map((model) => ({ model, peerId: undefined }))]
  return async () => {
    const script = PROBE_SCRIPTS[randomInt(PROBE_SCRIPTS.length)]!
    const snippet = PROBE_SNIPPETS[randomInt(PROBE_SNIPPETS.length)]!
    const instruction = `Write a realistic message a person might send to an AI assistant, in two parts.
Part "a": one short natural question (under 20 words), on a random everyday or technical topic of your choice.
Part "b": a follow-up the same person adds, 60 to 100 words, that naturally includes: ${snippet} inline, a sentence or phrase in ${script}, two or three emoji, some numbers (an ID, a date, an amount with a currency symbol), and one unusual long word or proper name.
It must read like a real person, not a test. Do not mention tokens or tests. Use no double quotes or backslashes.
Return only JSON: {"a": "...", "b": "..."}. Variation seed: ${randomInt(1e9)}`
    let lastError = 'no answer'
    for (let attempt = 0; attempt < writers.length * 2; attempt++) {
      const writer = writers[Math.floor(attempt / 2)]!
      try {
        const response = await (input.fetchFn ?? fetch)(`${input.proxyBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(writer.peerId ? { 'x-antseed-pin-peer': normalizePeerId(writer.peerId) } : {}) },
          body: JSON.stringify({ model: writer.model, messages: [{ role: 'user', content: instruction }], max_tokens: 2000, temperature: 1 }),
          signal: AbortSignal.timeout(120_000),
        })
        if (!response.ok) {
          lastError = `${writer.model}: HTTP ${response.status}`
          continue
        }
        const text = String((await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content ?? '')
        const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { a?: unknown; b?: unknown }
        if (typeof parsed.a === 'string' && typeof parsed.b === 'string' && parsed.a.trim() && parsed.b.trim()) {
          return { a: parsed.a, b: parsed.b }
        }
        lastError = `${writer.model}: answer without a and b`
      } catch (error) {
        lastError = `${writer.model}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    throw new Error(`probe generator failed: ${lastError}`)
  }
}

function describeResult(result: TokenizerSuspectResult): string {
  const who = `${result.sellerName ?? result.peerId.slice(0, 10)} ${result.service}`
  const deltas = result.deltas.map((d) => d ?? '?').join('/')
  const refs = result.referenceRanges.map((r) => (r === null ? '?' : r.min === r.max ? r.min : `${r.min}-${r.max}`)).join('/')
  switch (result.outcome) {
    case 'match':
      return `  match        ${who}: ${deltas} (references ${refs})`
    case 'inconclusive':
      return `  inconclusive ${who}: ${result.reason}`
    case 'mismatch': {
      const kind = result.liveSame ? 'USAGE MISREPORTED' : 'MISMATCH'
      return `  ${kind.padEnd(12)} ${who}: ${deltas}, references ${refs} → ${proofStatus(result)}`
    }
  }
}

function proofStatus(result: TokenizerSuspectResult): string {
  if (result.txHash) return `proved in ${result.txHash}`
  if (result.proofCheck) return `proof would revert: ${result.proofCheck}`
  if (result.reason) return result.reason
  return 'proof valid (dry run)'
}

type ProverState = Record<string, { checkedAt: number; outcome: TokenizerOutcome }>

/** One round's prompt and, per member (`memberKey`), its signed pair or why there is none, and its delta. */
interface ProbeRound {
  a: string
  b: string
  pairs: Map<string, TokenizerProbePair | string>
  deltas: Map<string, number | null>
}

function memberKey(modelHash: string, member: Member): string {
  return `${modelHash}|${member.peerId}|${member.service}`
}

function stateKey(peerId: string, service: string): string {
  return `${normalizePeerId(peerId)}|${service.trim().toLowerCase()}`
}

async function readState(path: string): Promise<ProverState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ProverState : {}
  } catch {
    return {}
  }
}

async function writeState(path: string, state: ProverState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`)
}

function normalizePeerId(peerId: string): string {
  return peerId.replace(/^0x/i, '').toLowerCase()
}
