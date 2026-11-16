/**
 * Completion-text extraction across the response shapes endpoints return:
 * OpenAI chat/completions, Anthropic messages, OpenAI Responses, and their SSE streams.
 */

export function extractCompletionText(body: string): string | null {
  try {
    return extractCompletionFromJson(JSON.parse(body) as Record<string, unknown>)
  } catch {
    return extractCompletionFromSse(body)
  }
}

export function extractFinishReason(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      choices?: Array<{ finish_reason?: unknown }>
      stop_reason?: unknown
      status?: unknown
    }
    const reason = parsed.choices?.[0]?.finish_reason ?? parsed.stop_reason ?? parsed.status
    return typeof reason === 'string' ? reason : null
  } catch {
    return null
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
      const choices = event.choices as Array<{ delta?: { content?: unknown } }> | undefined
      const chatDelta = choices?.[0]?.delta?.content
      if (typeof chatDelta === 'string') {
        deltas.push(chatDelta)
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta as { text?: unknown } | undefined
        if (typeof delta?.text === 'string') deltas.push(delta.text)
      } else if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
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
