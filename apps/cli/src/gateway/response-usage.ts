import { StringDecoder } from 'node:string_decoder'
import { extractUsage } from '@antseed/api-adapter'

/**
 * Token counts a response reported about itself. `inputTokens` is the total
 * logical input (cached included), like the buyer's spend events.
 */
export interface ResponseTokens {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

/** A JSON body is parsed whole up to this size; past it only its tail is kept. */
const MAX_JSON_BYTES = 1024 * 1024
const JSON_TAIL_BYTES = 64 * 1024
/** An SSE line longer than this (an inline image, say) is skipped. */
const MAX_SSE_LINE_BYTES = 1024 * 1024

/**
 * Reads the `usage` a model response carries as it streams past: the final
 * usage of an OpenAI chat completion or response, or an Anthropic message,
 * in JSON or as server-sent events (OpenAI chat `usage` chunk, Responses
 * `response.completed`, Anthropic `message_start` + `message_delta`).
 * Memory stays bounded whatever the response size.
 */
export class ResponseUsageReader {
  private _mode: 'json' | 'sse' | null
  private _jsonChunks: Buffer[] = []
  private _jsonBytes = 0
  private _jsonTruncated = false
  private _tail = Buffer.alloc(0)
  private readonly _decoder = new StringDecoder('utf8')
  private _line = ''
  private _skippingLine = false
  private _usage: ResponseTokens | null = null

  constructor(contentType: string | undefined) {
    const type = contentType?.toLowerCase() ?? ''
    this._mode = type.includes('text/event-stream') ? 'sse' : type.includes('json') ? 'json' : null
  }

  push(chunk: Buffer): void {
    if (this._mode === null) {
      // No telling content type: sniff the first bytes.
      const start = chunk.toString('utf8', 0, Math.min(chunk.length, 64)).trimStart()
      if (!start) return
      this._mode = start.startsWith('{') ? 'json' : 'sse'
    }
    if (this._mode === 'sse') this._pushSse(chunk)
    else this._pushJson(chunk)
  }

  /** The usage seen, or null when the response reported none. */
  result(): ResponseTokens | null {
    if (this._mode === 'sse') {
      if (this._line) this._sseLine(this._line)
      this._line = ''
      return this._usage
    }
    if (this._mode !== 'json') return null
    if (!this._jsonTruncated) {
      const parsed = parseObject(Buffer.concat(this._jsonChunks).toString('utf8'))
      return parsed ? usageOf(parsed) : null
    }
    const usage = lastUsageObject(this._tail.toString('utf8'))
    return usage ? usageOf({ usage }) : null
  }

  private _pushJson(chunk: Buffer): void {
    if (!this._jsonTruncated) {
      this._jsonChunks.push(chunk)
      this._jsonBytes += chunk.length
      if (this._jsonBytes <= MAX_JSON_BYTES) return
      this._jsonTruncated = true
      this._tail = Buffer.concat(this._jsonChunks)
      this._jsonChunks = []
    } else {
      this._tail = Buffer.concat([this._tail, chunk])
    }
    if (this._tail.length > JSON_TAIL_BYTES) this._tail = this._tail.subarray(this._tail.length - JSON_TAIL_BYTES)
  }

  private _pushSse(chunk: Buffer): void {
    const text = this._decoder.write(chunk)
    let start = 0
    for (;;) {
      const newline = text.indexOf('\n', start)
      if (newline === -1) break
      const piece = text.slice(start, newline)
      if (!this._skippingLine) this._sseLine(this._line + piece)
      this._line = ''
      this._skippingLine = false
      start = newline + 1
    }
    if (this._skippingLine) return
    this._line += text.slice(start)
    if (this._line.length > MAX_SSE_LINE_BYTES) {
      this._line = ''
      this._skippingLine = true
    }
  }

  private _sseLine(raw: string): void {
    const line = raw.trim()
    if (!line.startsWith('data:') || !line.includes('"usage"')) return
    const event = parseObject(line.slice(5).trim())
    const usage = event && usageOf(event)
    if (!usage) return
    // Anthropic splits usage over message_start (input) and message_delta
    // (output, cumulative); OpenAI sends one final usage. Keep the largest.
    const current = this._usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    this._usage = {
      inputTokens: Math.max(current.inputTokens, usage.inputTokens),
      cachedInputTokens: Math.max(current.cachedInputTokens, usage.cachedInputTokens),
      outputTokens: Math.max(current.outputTokens, usage.outputTokens),
    }
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Usage of a body or event that has a `usage` object (directly, or under `response` / `message`). */
function usageOf(parsed: Record<string, unknown>): ResponseTokens | null {
  const hasUsage = isObject(parsed['usage'])
    || (isObject(parsed['response']) && isObject(parsed['response']['usage']))
    || (isObject(parsed['message']) && isObject(parsed['message']['usage']))
  if (!hasUsage) return null
  const usage = extractUsage(parsed)
  return { inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens }
}

/** The last `"usage": {…}` object in a JSON fragment (the end of a body too large to parse). */
function lastUsageObject(text: string): Record<string, unknown> | null {
  const pattern = /"usage"\s*:\s*\{/g
  let start = -1
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) start = match.index + match[0].length - 1
  if (start === -1) return null
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return parseObject(text.slice(start, index + 1))
    }
  }
  return null
}
