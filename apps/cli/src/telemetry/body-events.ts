/**
 * The JSON objects of a response body, for telemetry readers only: the
 * events of an event stream (`data:` lines, `[DONE]` left out) or a whole
 * JSON answer. A partial or non-JSON event is skipped; an empty body or one
 * over 4 MiB is not read.
 */

type Json = Record<string, unknown>

export const MAX_BODY_BYTES = 4 * 1024 * 1024

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
}

/** Calls `visit` with each JSON object of the body, in order. */
export function visitBodyEvents(contentType: string | undefined, body: Uint8Array, visit: (event: Json) => void): void {
  if (body.length === 0 || body.length > MAX_BODY_BYTES) return
  const text = Buffer.from(body).toString('utf8')
  const read = (payload: string): void => {
    let event: Json | null
    try {
      event = asObject(JSON.parse(payload))
    } catch {
      return
    }
    if (event) visit(event)
  }
  if (!(contentType ?? '').toLowerCase().includes('text/event-stream')) {
    read(text)
    return
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload && payload !== '[DONE]') read(payload)
  }
}
