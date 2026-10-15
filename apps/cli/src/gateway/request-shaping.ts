import type { PresetRecord } from './store.js'

export const PRESET_MODEL_PREFIX = '@preset/'
export const END_USER_HEADER = 'x-antseed-end-user'
const MAX_END_USER_LENGTH = 256

export function presetSlug(model: string | null): string | null {
  return model?.startsWith(PRESET_MODEL_PREFIX) ? model.slice(PRESET_MODEL_PREFIX.length) : null
}

/**
 * Applies a preset to a JSON request body: the preset's model replaces
 * `@preset/<slug>`, its params sit under the client's own, and its system
 * prompt goes before the client's for chat, messages and responses shapes.
 * A `service` field is dropped: the buyer routes by it before `model`, so it
 * would route around the preset's model.
 */
export function applyPreset(body: Record<string, unknown>, preset: PresetRecord, routePrefix: string): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...preset.params, ...body, model: preset.model }
  delete merged['service']
  const prompt = preset.systemPrompt?.trim()
  if (!prompt) return merged
  if (routePrefix === '/v1/chat/completions') {
    const messages = Array.isArray(merged['messages']) ? merged['messages'] as unknown[] : []
    merged['messages'] = [{ role: 'system', content: prompt }, ...messages]
  } else if (routePrefix === '/v1/messages') {
    const system = merged['system']
    if (typeof system === 'string' && system.length > 0) merged['system'] = `${prompt}\n\n${system}`
    else if (Array.isArray(system)) merged['system'] = [{ type: 'text', text: prompt }, ...system]
    else merged['system'] = prompt
  } else if (routePrefix === '/v1/responses') {
    const instructions = merged['instructions']
    merged['instructions'] = typeof instructions === 'string' && instructions.length > 0 ? `${prompt}\n\n${instructions}` : prompt
  }
  return merged
}

/** End user from the body's `user` field (OpenAI convention) or the end-user header. */
export function extractEndUser(body: Record<string, unknown> | null, header: string | undefined): string | null {
  const fromBody = body && typeof body['user'] === 'string' ? body['user'] : null
  const value = (fromBody || header || '').trim()
  return value ? value.slice(0, MAX_END_USER_LENGTH) : null
}

/** A text field of a multipart form (image edits), without a full parser; `model` by default. */
export function sniffMultipartModel(body: Buffer, contentType: string | undefined, field: 'model' | 'service' = 'model'): string | null {
  if (!contentType?.toLowerCase().startsWith('multipart/form-data')) return null
  const text = body.subarray(0, 4 * 1024 * 1024).toString('latin1')
  const match = new RegExp(`content-disposition:\\s*form-data;\\s*name="${field}"[^\\r\\n]*\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n([^\\r\\n]*)\\r\\n`, 'i').exec(text)
  return match ? Buffer.from(match[1]!, 'latin1').toString('utf8').slice(0, 200) : null
}

/**
 * The model the buyer will route the request to, the way it reads it
 * (`service ?? model`, trimmed; see `extractRequestedService` in
 * proxy/request-utils.ts): a `service` field wins over `model`, and one that
 * is not a usable name leaves the request without a model. The gateway's
 * model allow list and its accounting use this, not `model` alone.
 */
export function effectiveRequestModel(parsed: Record<string, unknown> | null, body: Buffer, contentType: string | undefined): string | null {
  const raw = parsed
    ? parsed['service'] ?? parsed['model']
    : sniffMultipartModel(body, contentType, 'service') ?? sniffMultipartModel(body, contentType)
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}
