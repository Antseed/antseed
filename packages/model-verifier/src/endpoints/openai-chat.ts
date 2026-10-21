import type { ModelBatchRequest, ModelCallResult, ModelEndpoint } from '../endpoint.js'
import { postJson, trimTrailingSlash } from './http.js'

export interface OpenAIChatEndpointOptions {
  /** Base URL including the version segment, e.g. https://openrouter.ai/api/v1. */
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  /** Extra body fields the target needs (never the reference's quirks). */
  extraBody?: Record<string, unknown>
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class OpenAIChatEndpoint implements ModelEndpoint {
  readonly label: string

  constructor(private readonly options: OpenAIChatEndpointOptions) {
    this.label = trimTrailingSlash(options.baseUrl)
  }

  call(request: ModelBatchRequest, signal?: AbortSignal): Promise<ModelCallResult> {
    return postJson({
      url: `${this.label}/chat/completions`,
      headers: {
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        ...this.options.headers,
      },
      body: {
        model: request.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        temperature: request.temperature,
        top_p: request.topP,
        max_tokens: request.maxTokens,
        ...this.options.extraBody,
      },
      timeoutMs: this.options.timeoutMs ?? 120_000,
      ...(signal ? { signal } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      readUsage: (parsed) => {
        const usage = parsed.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined
        if (typeof usage?.prompt_tokens !== 'number' || typeof usage.completion_tokens !== 'number') return undefined
        return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
      },
    })
  }
}
