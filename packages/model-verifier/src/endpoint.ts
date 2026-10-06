/**
 * The seam between the KBF audit and whatever serves the model under test.
 * An endpoint turns one probe batch into completion text; it never scores.
 */

export interface ModelBatchRequest {
  model: string
  system: string
  user: string
  temperature: number
  topP: number
  maxTokens: number
}

export interface ModelCallSuccess {
  ok: true
  text: string
  finishReason: string | null
  usage?: { inputTokens: number; outputTokens: number }
  /** Exact bytes exchanged, kept so a third party can re-parse the answer. */
  raw: { request: Uint8Array; response: Uint8Array; status: number }
  /** Transport-specific proof that the endpoint produced this response (e.g. a signed receipt). */
  attestation?: unknown
}

export interface ModelCallFailure {
  ok: false
  status?: number
  retryable: boolean
  retryAfterMs?: number
  message: string
}

export type ModelCallResult = ModelCallSuccess | ModelCallFailure

export interface ModelEndpoint {
  /** Human-readable target description for reports, e.g. the base URL. */
  readonly label: string
  call(request: ModelBatchRequest, signal?: AbortSignal): Promise<ModelCallResult>
}
