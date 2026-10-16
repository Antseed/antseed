import { shouldEmitDebugLine, type PeerInfo, type SerializedHttpRequest, type SerializedHttpResponse } from '@antseed/node'
import { extractRequestBodyFields, nativeVideoRoute, parseJsonObject, requestService } from '@antseed/api-adapter'

function isTruthyDebugValue(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

function shouldEmitProxyLog(args: unknown[]): boolean {
  return shouldEmitDebugLine(`[proxy] ${args.map((arg) => typeof arg === 'string' ? arg : String(arg)).join(' ')}`)
}

export function DEBUG(): boolean {
  return isTruthyDebugValue(process.env['ANTSEED_DEBUG'])
}

export function log(...args: unknown[]): void {
  if (DEBUG() && shouldEmitProxyLog(args)) console.log('[proxy]', ...args)
}

function getHeader(headers: Record<string, string>, name: string): string {
  return headers[name] ?? headers[name.charAt(0).toUpperCase() + name.slice(1)] ?? ''
}

export function normalizePeerId(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  const withoutPrefix = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed
  return /^[0-9a-f]{40}$/.test(withoutPrefix) ? withoutPrefix : null
}

export function parsePeerPinnedService(value: string): { peerId: string; service: string } | null {
  const separatorIndex = value.indexOf('@')
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return null
  }

  const peerId = normalizePeerId(value.slice(0, separatorIndex))
  const service = value.slice(separatorIndex + 1).trim()
  if (!peerId || service.length === 0) {
    return null
  }
  return { peerId, service }
}

export function extractRequestedService(request: SerializedHttpRequest): string | null {
  if (nativeVideoRoute(request)) return requestService(request) ?? null
  const contentType = getHeader(request.headers, 'content-type').toLowerCase()
  if (!contentType.includes('application/json') && !contentType.startsWith('multipart/form-data')) {
    return null
  }
  const parsed = extractRequestBodyFields(request.headers, request.body)
  if (!parsed) return null

  const service = parsed.service ?? parsed.model
  if (typeof service === 'string' && service.trim().length > 0) {
    return service.trim()
  }
  return null
}

function summarizeMessageShape(messagesRaw: unknown): string {
  if (!Array.isArray(messagesRaw)) {
    return 'msgShape=none'
  }

  const roleCounts = new Map<string, number>()
  const contentKindCounts = new Map<string, number>()
  const blockTypeCounts = new Map<string, number>()
  let invalidMessages = 0
  let firstRole = 'none'
  let lastRole = 'none'

  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1)
  }

  for (const entry of messagesRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalidMessages += 1
      continue
    }

    const message = entry as Record<string, unknown>
    const role = typeof message.role === 'string' && message.role.trim().length > 0
      ? message.role.trim().toLowerCase()
      : 'invalid-role'
    bump(roleCounts, role)
    if (firstRole === 'none') {
      firstRole = role
    }
    lastRole = role

    const content = message.content
    if (typeof content === 'string') {
      bump(contentKindCounts, 'string')
      continue
    }
    if (Array.isArray(content)) {
      bump(contentKindCounts, 'array')
      for (const block of content) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
          bump(blockTypeCounts, 'invalid')
          continue
        }
        const blockType = typeof (block as Record<string, unknown>).type === 'string'
          ? String((block as Record<string, unknown>).type).trim().toLowerCase()
          : 'missing-type'
        bump(blockTypeCounts, blockType || 'missing-type')
      }
      continue
    }
    if (content && typeof content === 'object') {
      bump(contentKindCounts, 'object')
      continue
    }
    bump(contentKindCounts, 'other')
  }

  const joinMap = (map: Map<string, number>): string => (
    [...map.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([key, value]) => `${key}:${String(value)}`)
      .join(',')
  )

  const roleSummary = joinMap(roleCounts) || 'none'
  const contentSummary = joinMap(contentKindCounts) || 'none'
  const blockSummary = joinMap(blockTypeCounts) || 'none'

  return [
    `msgShape=roles{${roleSummary}}`,
    `content{${contentSummary}}`,
    `blocks{${blockSummary}}`,
    `firstRole=${firstRole}`,
    `lastRole=${lastRole}`,
    `invalidMsgs=${String(invalidMessages)}`,
  ].join(' ')
}

export function summarizeRequestShape(request: SerializedHttpRequest): string {
  const contentType = getHeader(request.headers, 'content-type').toLowerCase()
  const accept = getHeader(request.headers, 'accept').toLowerCase()
  const providerHeader = request.headers['x-antseed-provider'] ?? 'none'
  const preferPeerHeader = request.headers['x-antseed-prefer-peer'] ?? 'none'
  const service = extractRequestedService(request) ?? 'none'
  const wantsStreaming = requestWantsStreaming(request.headers, request.body)

  const baseParts = [
    `method=${request.method}`,
    `path=${request.path}`,
    `provider=${providerHeader}`,
    `preferPeer=${preferPeerHeader}`,
    `contentType=${contentType || 'none'}`,
    `accept=${accept || 'none'}`,
    `stream=${String(wantsStreaming)}`,
    `service=${service}`,
    `bodyBytes=${String(request.body.length)}`,
  ]

  const jsonBody = parseJsonObject(request.body)
  if (!jsonBody) {
    return baseParts.join(' ')
  }

  const messagesRaw = jsonBody.messages
  const toolsRaw = jsonBody.tools
  const messageCount = Array.isArray(messagesRaw) ? messagesRaw.length : 0
  const toolCount = Array.isArray(toolsRaw) ? toolsRaw.length : 0
  const maxTokens = Number(jsonBody.max_tokens ?? jsonBody.maxTokens)
  const keys = Object.keys(jsonBody).sort().join(',')

  baseParts.push(`messages=${String(messageCount)}`)
  baseParts.push(`tools=${String(toolCount)}`)
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    baseParts.push(`maxTokens=${String(Math.floor(maxTokens))}`)
  }
  if (keys.length > 0) {
    baseParts.push(`keys=[${keys}]`)
  }
  baseParts.push(summarizeMessageShape(messagesRaw))

  return baseParts.join(' ')
}

export function summarizeErrorResponse(response: SerializedHttpResponse): string {
  const contentType = (response.headers['content-type'] ?? '').toLowerCase()
  if (!response.body || response.body.length === 0) {
    return 'empty response body'
  }

  const raw = new TextDecoder().decode(response.body).trim()
  if (raw.length === 0) {
    return 'empty response body'
  }

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const object = parsed as Record<string, unknown>
        const nestedError = object.error && typeof object.error === 'object' && !Array.isArray(object.error)
          ? (object.error as Record<string, unknown>)
          : null
        const message = (
          (typeof nestedError?.message === 'string' && nestedError.message)
          || (typeof object.message === 'string' && object.message)
          || (typeof object.detail === 'string' && object.detail)
        )
        if (message) {
          return `message="${message}"`
        }
      }
    } catch {
      // fall through to raw snippet
    }
  }

  const compact = raw.replace(/\s+/g, ' ')
  const maxChars = 280
  const snippet = compact.length > maxChars ? `${compact.slice(0, maxChars)}...` : compact
  return `body="${snippet}"`
}

export function requestWantsStreaming(headers: Record<string, string>, body: Uint8Array): boolean {
  if (getHeader(headers, 'accept').toLowerCase().includes('text/event-stream')) {
    return true
  }

  if (!getHeader(headers, 'content-type').toLowerCase().includes('application/json') || body.length === 0) {
    return false
  }

  const parsed = parseJsonObject(body)
  return parsed?.stream === true
}

function extractHostFromAddress(address: string): string {
  const trimmed = address.trim()
  if (trimmed.length === 0) return ''

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end > 1 ? trimmed.slice(1, end).toLowerCase() : ''
  }

  const idx = trimmed.lastIndexOf(':')
  if (idx > 0) {
    return trimmed.slice(0, idx).toLowerCase()
  }
  return trimmed.toLowerCase()
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function isLoopbackPeer(peer: PeerInfo): boolean {
  if (!peer.publicAddress) {
    return false
  }
  const host = extractHostFromAddress(peer.publicAddress)
  return isLoopbackHost(host)
}

/**
 * Model alias that tool configs can carry instead of a concrete
 * `<peerId>@<service>` key. The buyer substitutes the session's default
 * routed model at request time, so the route selected in the desktop
 * (floating pill / VPR) applies to already-running tool sessions without
 * rewriting their configs.
 */
export const ROUTED_MODEL_ALIAS = 'antseed'

export function substituteRoutedModelAlias(
  body: Uint8Array,
  headers: Record<string, string>,
  defaultRoutedModel: string | null,
): { body: Uint8Array; headers: Record<string, string>; aliasRequested: boolean; substituted: boolean } {
  if (!getHeader(headers, 'content-type').toLowerCase().includes('application/json') || body.length === 0) {
    return { body, headers, aliasRequested: false, substituted: false }
  }
  const obj = parseJsonObject(body)
  if (!obj) {
    return { body, headers, aliasRequested: false, substituted: false }
  }

  const rawModel = typeof obj['model'] === 'string' ? obj['model'].trim() : ''
  const rawService = typeof obj['service'] === 'string' ? obj['service'].trim() : ''
  const modelIsAlias = rawModel.toLowerCase() === ROUTED_MODEL_ALIAS
  const serviceIsAlias = rawService.toLowerCase() === ROUTED_MODEL_ALIAS
  if (!modelIsAlias && !serviceIsAlias) {
    return { body, headers, aliasRequested: false, substituted: false }
  }

  const target = defaultRoutedModel?.trim()
  if (!target) {
    return { body, headers, aliasRequested: true, substituted: false }
  }
  if (modelIsAlias) obj['model'] = target
  if (serviceIsAlias) obj['service'] = target
  const { body: rewritten, headers: updatedHeaders } = encodeRewrittenJsonBody(obj, headers)
  return { body: rewritten, headers: updatedHeaders, aliasRequested: true, substituted: true }
}

/**
 * Marker header the system proxy stamps on requests whose `model` field IT
 * rewrote from the connect-time route — intercepted tools (Claude Code
 * talking to api.anthropic.com through the MITM proxy) send upstream model
 * names, not an AntSeed route, so the model on such requests is AntSeed
 * plumbing rather than a client choice. The buyer treats those models like
 * the routed-model alias for per-chat routing: a chat's pinned model
 * overrides the proxy-resolved route. Internal — stripped before dispatch.
 */
export const SYSTEM_ROUTED_MODEL_HEADER = 'x-antseed-system-routed'

/** Internal profile marker stamped by the system proxy so intercepted app
    traffic is attributed to the Connected App profile that captured it,
    rather than to a generic SDK User-Agent. Stripped before dispatch. */
export const SYSTEM_PROXY_SOURCE_HEADER = 'x-antseed-system-proxy-source'

/** Names the stored buyer identity (wallet) that pays for a request; absent
    means the default identity. Local to the buyer — stripped before dispatch. */
export const BUYER_IDENTITY_HEADER = 'x-antseed-buyer-identity'

/**
 * Replace a proxy-assigned model with the chat's pinned route. Only used for
 * requests carrying SYSTEM_ROUTED_MODEL_HEADER — client-chosen models are
 * never overridden.
 */
export function overrideRoutedModelInBody(
  body: Uint8Array,
  headers: Record<string, string>,
  pinnedModel: string,
): { body: Uint8Array; headers: Record<string, string>; overridden: boolean } {
  if (!getHeader(headers, 'content-type').toLowerCase().includes('application/json') || body.length === 0) {
    return { body, headers, overridden: false }
  }
  const obj = parseJsonObject(body)
  if (!obj) {
    return { body, headers, overridden: false }
  }
  const rawModel = typeof obj['model'] === 'string' ? obj['model'].trim() : ''
  if (!rawModel || rawModel === pinnedModel) {
    return { body, headers, overridden: false }
  }
  obj['model'] = pinnedModel
  if (typeof obj['service'] === 'string' && obj['service'].trim() === rawModel) {
    obj['service'] = pinnedModel
  }
  const { body: rewritten, headers: updatedHeaders } = encodeRewrittenJsonBody(obj, headers)
  return { body: rewritten, headers: updatedHeaders, overridden: true }
}

function encodeRewrittenJsonBody(
  obj: Record<string, unknown>,
  headers: Record<string, string>,
): { body: Uint8Array; headers: Record<string, string> } {
  const rewritten = new TextEncoder().encode(JSON.stringify(obj))
  const updatedHeaders = { ...headers }
  if ('content-length' in updatedHeaders) {
    updatedHeaders['content-length'] = String(rewritten.length)
  } else if ('Content-Length' in updatedHeaders) {
    updatedHeaders['Content-Length'] = String(rewritten.length)
  }
  return { body: rewritten, headers: updatedHeaders }
}

export function rewritePeerPinnedServiceInBody(
  body: Uint8Array,
  headers: Record<string, string>,
): { body: Uint8Array; headers: Record<string, string>; pinnedPeerId: string | null } {
  if (!getHeader(headers, 'content-type').toLowerCase().includes('application/json') || body.length === 0) {
    return { body, headers, pinnedPeerId: null }
  }
  const obj = parseJsonObject(body)
  if (!obj) {
    return { body, headers, pinnedPeerId: null }
  }

  const rawModel = typeof obj['model'] === 'string' ? obj['model'].trim() : ''
  const rawService = typeof obj['service'] === 'string' ? obj['service'].trim() : ''
  const parsedModel = rawModel ? parsePeerPinnedService(rawModel) : null
  const parsedService = rawService ? parsePeerPinnedService(rawService) : null
  const parsed = parsedModel ?? parsedService
  if (!parsed) {
    return { body, headers, pinnedPeerId: null }
  }

  if (parsedModel) {
    obj['model'] = parsedModel.service
    if (obj['service'] === undefined || obj['service'] === rawModel) {
      obj['service'] = parsedModel.service
    }
  } else if (parsedService) {
    obj['service'] = parsedService.service
    if (obj['model'] === undefined || obj['model'] === rawService) {
      obj['model'] = parsedService.service
    }
  }

  const { body: rewritten, headers: updatedHeaders } = encodeRewrittenJsonBody(obj, headers)
  return { body: rewritten, headers: updatedHeaders, pinnedPeerId: parsed.peerId }
}
