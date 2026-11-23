import {
  buildKbfChatRequestBody,
  canonicalJsonStringify,
  type KbfProbe,
} from '@antseed/fingerprints'
import { decodeHttpRequest, decodeHttpResponse } from '@antseed/node'
import { assertBoundToSeller, sellerBindingOf } from './audit-checks.js'
import { isDiscoveryMember, isDiscoveryPrefill } from './audit-thinking.js'
import { isRecord, parseObject } from './methods/shared/output-usage.js'
import { scoreQuestionBatch } from './question-scoring.js'
import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'

/**
 * The question batches of a seller's evidence, held to the bytes the seller signed. For a reader of another auditor's
 * published evidence: the stored answers and matches are what the first auditor wrote, and only the signed request and
 * response are the seller's. Each batch that counts (answered, with a verified ResponseAuth) must be:
 *
 * - the audited seller's: signed by it, for a request of this batch, for the audited service (`assertBoundToSeller`);
 * - asked what the batch says and nothing else: the signed request is the audit's own conversation for these questions
 *   in this wording (`requestIsQuestionBatch`);
 * - scored as the run scores it: the answers parsed from the signed response and matched against the reference are
 *   the stored ones.
 *
 * A batch that failed counts no answer, so it may store none. A batch answered without a verified ResponseAuth leaves
 * the questions undecided where they are judged (`adjudicateQuestions`), whatever it stores. Throws.
 */
export function assertQuestionsFromSignedBytes(evidence: ProxyAuditEvidenceV1): void {
  const refuse = (why: string): never => { throw new Error(`the questions: ${why}`) }
  const probes = new Map(evidence.reference.probes.map((probe) => [probe.id, probe as unknown as KbfProbe]))
  const seller = sellerBindingOf(evidence)
  for (const exchange of evidence.exchanges) {
    if (exchange.status !== 'succeeded') {
      if (exchange.matches.some((match) => match !== null)) refuse('a batch that failed stores scored answers')
      continue
    }
    const auth = exchange.responseAuth
    if (auth.status !== 'verified') continue
    assertBoundToSeller([{ signer: 'audited', requestIds: exchange.requestIds, responseAuth: auth }], seller, 'the questions')
    if (!auth.signedPreimages) refuse('an answered batch holds no signed bytes')
    const batch = exchange.probeIds.map((id) => probes.get(id) ?? refuse('a batch asks a question that is not in its question set'))
    let request: Uint8Array
    let response: Uint8Array
    try {
      request = decodeHttpRequest(Buffer.from(auth.signedPreimages!.requestBase64, 'base64')).body
      response = decodeHttpResponse(Buffer.from(auth.signedPreimages!.responseBase64, 'base64')).body
    } catch {
      return refuse('a batch\'s signed bytes cannot be read')
    }
    const asked = buildKbfChatRequestBody(evidence.target.service, batch, { maxTokens: 1, variantId: exchange.promptVariantId }).messages
    if (!requestIsQuestionBatch(request, { messages: asked, temperature: evidence.reference.queryProfile.auditTemperature })) {
      refuse('a batch\'s signed request is not the audit\'s request for the questions the batch names')
    }
    // Scored by the run's own function, so stored evidence is read exactly as the audit that made it read its replies.
    const { answers, matches } = scoreQuestionBatch(response, batch)
    if (canonicalJsonStringify(answers) !== canonicalJsonStringify(exchange.answers)
      || canonicalJsonStringify(matches) !== canonicalJsonStringify(exchange.matches)) {
      refuse('a batch\'s stored answers are not the ones its signed response gives')
    }
  }
}


/**
 * The top-level members a question request may carry besides its thinking setting: what the audit sends and what the
 * buyer proxy writes when it translates the request to Chat Completions, Messages or Responses. None of them is
 * input the model reads or a setting that changes how it answers. Any other member (tools, a response schema, a
 * stored prompt, an earlier response, another sampling setting, ...) may be.
 */
const QUESTION_REQUEST_MEMBERS: ReadonlySet<string> = new Set([
  'model', 'messages', 'input', 'system', 'instructions', 'stream', 'stream_options',
  'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'metadata', 'user', 'prompt_cache_key',
])
const QUESTION_TURN_MEMBERS: ReadonlySet<string> = new Set(['role', 'type', 'content'])
const QUESTION_PART_MEMBERS: ReadonlySet<string> = new Set(['type', 'text', 'cache_control'])

/** A turn's or the system's content as one text: a string, or one text part. Null for anything else. */
function oneText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.length !== 1) return null
  const part: unknown = content[0]
  return isRecord(part) && Object.keys(part).every((key) => QUESTION_PART_MEMBERS.has(key))
    && (part['type'] === 'text' || part['type'] === 'input_text' || part['type'] === 'output_text') && typeof part['text'] === 'string'
    ? part['text'] : null
}

/**
 * Whether the request a seller signed is the audit's own request for one batch, in any API shape the buyer proxy
 * translates to, and nothing more: the batch's system text (a system turn, Messages' `system`, Responses'
 * `instructions`), then the one user turn with the batch's prompt, then at most the thinking prefill; only known
 * members; the audit's temperature when one is sent; and a thinking setting only as the audit sends one. A request
 * that carries the prompt among other instructions or turns is a different question, and its answer is no audit answer.
 */
export function requestIsQuestionBatch(
  requestBody: Uint8Array,
  expected: { messages: ReadonlyArray<{ role: string; content: string }>; temperature: number },
): boolean {
  const body = parseObject(requestBody)
  if (!body) return false
  for (const [member, value] of Object.entries(body)) {
    if (QUESTION_REQUEST_MEMBERS.has(member)) continue
    // A thinking setting only as discovery sends one: the questions' declaration is the seller's own (`QUESTIONS_CHECK`).
    if (!isDiscoveryMember(member, value)) return false
  }
  if (body['temperature'] !== undefined && body['temperature'] !== expected.temperature) return false
  if (body['messages'] !== undefined && body['input'] !== undefined) return false
  const system = expected.messages.filter((message) => message.role === 'system').map((message) => message.content)
  const users = expected.messages.filter((message) => message.role === 'user').map((message) => message.content)
  if (system.length > 1 || users.length !== 1 || expected.messages.length !== system.length + 1) return false
  // The conversation as roles and texts, the system text first wherever the shape keeps it.
  const conversation: Array<[string, string]> = []
  for (const member of ['system', 'instructions']) {
    if (body[member] === undefined) continue
    const text = oneText(body[member])
    if (text === null) return false
    conversation.push(['system', text])
  }
  const turns: unknown = typeof body['input'] === 'string' ? [{ role: 'user', content: body['input'] }] : body['messages'] ?? body['input']
  if (!Array.isArray(turns)) return false
  for (const turn of turns) {
    if (!isRecord(turn) || Object.keys(turn).some((key) => !QUESTION_TURN_MEMBERS.has(key))) return false
    if (typeof turn['role'] !== 'string' || (turn['type'] !== undefined && turn['type'] !== 'message')) return false
    const text = oneText(turn['content'])
    if (text === null) return false
    conversation.push([turn['role'] === 'developer' ? 'system' : turn['role'], text])
  }
  const prefilled = conversation.at(-1)?.[0] === 'assistant'
  if (prefilled && !isDiscoveryPrefill(conversation.at(-1)![1])) return false
  const asked = prefilled ? conversation.slice(0, -1) : conversation
  return canonicalJsonStringify(asked) === canonicalJsonStringify([...system.map((text) => ['system', text]), ['user', users[0]]])
}
