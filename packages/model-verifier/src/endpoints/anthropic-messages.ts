import type { ModelBatchRequest, ModelCallResult, ModelEndpoint } from '../endpoint.js'
import { postJson, trimTrailingSlash } from './http.js'

export interface AnthropicMessagesEndpointOptions {
  /** Base URL including the version segment, e.g. https://api.anthropic.com/v1. */
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  extraBody?: Record<string, unknown>
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class AnthropicMessagesEndpoint implements ModelEndpoint {
  readonly label: string

  constructor(private readonly options: AnthropicMessagesEndpointOptions) {
    this.label = trimTrailingSlash(options.baseUrl)
  }

  call(request: ModelBatchRequest, signal?: AbortSignal): Promise<ModelCallResult> {
    return postJson({
      url: `${this.label}/messages`,
      headers: {
        'anthropic-version': '2023-06-01',
        ...(this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {}),
        ...this.options.headers,
      },
      body: {
        model: request.model,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        ...this.options.extraBody,
      },
      timeoutMs: this.options.timeoutMs ?? 120_000,
      ...(signal ? { signal } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      readUsage: (parsed) => {
        const usage = parsed.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined
        if (typeof usage?.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return undefined
        return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
      },
    })
  }
}
