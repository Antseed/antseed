import {
  computeMatchVector,
  isKbfTokenLimitFinishReason,
  kbfResponseFinishReason,
  parseKbfAnswers,
  stripKbfThinkBlocks,
  type KbfProbe,
  type MatchVector,
} from '@antseed/fingerprints'

/**
 * How a question batch's reply is read and scored: pure functions of its bytes, for the live audit (`model-run.ts`)
 * and for a reader of stored evidence (`signed-questions.ts`) alike, so the two cannot read a reply differently.
 */

/**
 * One batch's answers and matches from the bytes of its reply, for the run and for any reader of stored evidence
 * (`signed-questions.ts`): the one way a reply is scored.
 * - As the reference code does before parsing, `<think>…</think>` blocks are not answers.
 * - A reply cut off at the token limit is not scored: the model was still writing (often reasoning in the reply), so
 *   its numbers are not its answers.
 * - A reply with no readable answer scores nothing (`malformedOutput`).
 */
export function scoreQuestionBatch(responseBody: Uint8Array, probes: readonly KbfProbe[]): {
  completion: string | null
  truncated: boolean
  answers: Array<number | null>
  matches: MatchVector
  malformedOutput: boolean
} {
  const extracted = extractCompletionText(responseBody)
  const completion = extracted === null ? null : stripKbfThinkBlocks(extracted)
  const truncated = isKbfTokenLimitFinishReason(kbfResponseFinishReason(new TextDecoder().decode(responseBody)))
  const answers = completion === null || truncated
    ? new Array<number | null>(probes.length).fill(null)
    : parseKbfAnswers(completion, probes.length)
  const malformedOutput = answers.every((answer) => answer === null)
  const matches: MatchVector = malformedOutput
    ? new Array<null>(probes.length).fill(null)
    : computeMatchVector(answers, [...probes])
  return { completion, truncated, answers, matches, malformedOutput }
}

export function extractCompletionText(body: Uint8Array): string | null {
  const text = new TextDecoder().decode(body)
  try {
    return extractCompletionFromJson(JSON.parse(text) as Record<string, unknown>)
  } catch {
    return extractCompletionFromSse(text)
  }
}

function extractCompletionFromJson(parsed: Record<string, unknown>): string | null {
  const response = parsed as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>
    content?: Array<{ type?: string; text?: unknown }>
    output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }>
    output_text?: unknown
  }
  const chatContent = response.choices?.[0]?.message?.content
  if (typeof chatContent === 'string') return chatContent
  const completionText = response.choices?.[0]?.text
  if (typeof completionText === 'string') return completionText
  const anthropicText = response.content?.find((block) => block?.type === 'text')?.text
  if (typeof anthropicText === 'string') return anthropicText
  if (typeof response.output_text === 'string') return response.output_text
  const outputText = response.output
    ?.flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
  return outputText || null
}

function extractCompletionFromSse(text: string): string | null {
  const deltas: string[] = []
  let completed: string | null = null
  let done: string | null = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice('data:'.length).trim()
    if (!data || data === '[DONE]') continue
    try {
      const event = JSON.parse(data) as Record<string, unknown>
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        deltas.push(event.delta)
      } else if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
        done = event.text
      } else if (event.type === 'response.completed' && event.response && typeof event.response === 'object') {
        completed = extractCompletionFromJson(event.response as Record<string, unknown>)
      }
    } catch {
      continue
    }
  }
  if (deltas.length > 0) return deltas.join('')
  return completed ?? done
}
