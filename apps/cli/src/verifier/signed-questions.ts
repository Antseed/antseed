import {
  buildKbfChatRequestBody,
  canonicalJsonStringify,
  computeMatchVector,
  isKbfTokenLimitFinishReason,
  kbfResponseFinishReason,
  parseKbfAnswers,
  stripKbfThinkBlocks,
  type KbfProbe,
} from '@antseed/fingerprints'
import { decodeHttpRequest, decodeHttpResponse } from '@antseed/node'
import { assertBoundToSeller, sellerBindingOf } from './audit-checks.js'
import { requestCarriesPrompt } from './methods/shared/output-usage.js'
import { extractCompletionText } from './model-run.js'
import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'

/**
 * The question batches of a seller's evidence, held to the bytes the seller signed. For a reader of another auditor's
 * published evidence: the stored answers and matches are what the first auditor wrote, and only the signed request and
 * response are the seller's. Each batch that counts (answered, with a verified ResponseAuth) must be:
 *
 * - the audited seller's: signed by it, for a request of this batch, for the audited service (`assertBoundToSeller`);
 * - asked what the batch says: the signed request carries the prompt of these questions in this wording;
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
    const prompt = buildKbfChatRequestBody(evidence.target.service, batch, { maxTokens: 1, variantId: exchange.promptVariantId })
      .messages.filter((message) => message.role === 'user').at(-1)?.content
    if (typeof prompt !== 'string' || !requestCarriesPrompt(request, prompt)) {
      refuse('a batch\'s signed request does not ask the questions the batch names')
    }
    // As the run reads an answer (`model-run.ts`): think blocks are not answers, and a reply cut off at the token limit
    // or with no readable answer scores nothing.
    const extracted = extractCompletionText(response)
    const completion = extracted === null ? null : stripKbfThinkBlocks(extracted)
    const truncated = isKbfTokenLimitFinishReason(kbfResponseFinishReason(new TextDecoder().decode(response)))
    const answers = completion === null || truncated ? batch.map(() => null) : parseKbfAnswers(completion, batch.length)
    const matches = answers.every((answer) => answer === null) ? batch.map(() => null) : computeMatchVector(answers, batch)
    if (canonicalJsonStringify(answers) !== canonicalJsonStringify(exchange.answers)
      || canonicalJsonStringify(matches) !== canonicalJsonStringify(exchange.matches)) {
      refuse('a batch\'s stored answers are not the ones its signed response gives')
    }
  }
}
