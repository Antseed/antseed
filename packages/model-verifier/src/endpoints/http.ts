import type { ModelCallResult } from '../endpoint.js'
import { extractCompletionText, extractFinishReason } from '../completion.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface PostJsonInput {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  timeoutMs: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  readUsage(parsed: Record<string, unknown>): { inputTokens: number; outputTokens: number } | undefined
}

export async function postJson(input: PostJsonInput): Promise<ModelCallResult> {
  const requestBytes = encoder.encode(JSON.stringify(input.body))
  const timeout = AbortSignal.timeout(input.timeoutMs)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  let response: Response
  try {
    response = await (input.fetchImpl ?? fetch)(input.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...input.headers },
      body: requestBytes,
      signal,
    })
  } catch (error) {
    return { ok: false, retryable: true, message: error instanceof Error ? error.message : String(error) }
  }
  const responseBytes = new Uint8Array(await response.arrayBuffer())
  const bodyText = decoder.decode(responseBytes)
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'))
    return {
      ok: false,
      status: response.status,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
      message: `HTTP ${response.status}: ${bodyText.slice(0, 300)}`,
    }
  }
  const text = extractCompletionText(bodyText)
  if (text === null) {
    return { ok: false, status: response.status, retryable: true, message: 'response has no completion text' }
  }
  let usage: { inputTokens: number; outputTokens: number } | undefined
  try {
    usage = input.readUsage(JSON.parse(bodyText) as Record<string, unknown>)
  } catch {
    usage = undefined
  }
  return {
    ok: true,
    text,
    finishReason: extractFinishReason(bodyText),
    ...(usage ? { usage } : {}),
    raw: { request: requestBytes, response: responseBytes, status: response.status },
  }
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
