import type { CollectedSliceV1, SliceExchangeV1, SliceManifestV1 } from './types.js'

/**
 * Validates a committed slice manifest's structure. Anyone in the epoch can commit any bytes,
 * so nothing from a manifest is trusted before this. Returns null for a manifest that is not a
 * slice manifest at all; a malformed slice or exchange inside an otherwise valid manifest is
 * dropped on its own (its slice then counts as undelivered). Deterministic: every verifier keeps
 * exactly the same parts.
 */
export function parseSliceManifest(value: unknown): SliceManifestV1 | null {
  if (!isRecord(value)) return null
  if (value['kind'] !== 'antseed-kbf-slices' || value['version'] !== 1) return null
  if (typeof value['epoch'] !== 'string' || typeof value['collector'] !== 'string' || typeof value['backup'] !== 'boolean') return null
  if (!Array.isArray(value['slices'])) return null
  const slices = value['slices'].map(parseSlice).filter((slice): slice is CollectedSliceV1 => slice !== null)
  return {
    kind: 'antseed-kbf-slices',
    version: 1,
    epoch: value['epoch'],
    collector: value['collector'],
    backup: value['backup'],
    slices,
  }
}

function parseSlice(value: unknown): CollectedSliceV1 | null {
  if (!isRecord(value) || typeof value['targetKey'] !== 'string' || !isIndex(value['sliceIndex']) || !Array.isArray(value['exchanges'])) {
    return null
  }
  return {
    targetKey: value['targetKey'],
    sliceIndex: value['sliceIndex'],
    exchanges: value['exchanges'].map(parseExchange).filter((exchange): exchange is SliceExchangeV1 => exchange !== null),
  }
}

const AUTH_STRING_FIELDS = [
  'requestId', 'buyerPeerId', 'sellerPeerId', 'advertisedService', 'provider', 'requestHash', 'responseHash', 'signature',
] as const
const AUTH_NUMBER_FIELDS = ['statusCode', 'responseStartedAt', 'responseCompletedAt'] as const

function parseExchange(value: unknown): SliceExchangeV1 | null {
  if (!isRecord(value) || !isIndex(value['batchIndex']) || typeof value['requestId'] !== 'string') return null
  if (typeof value['requestBase64'] !== 'string' || typeof value['responseBase64'] !== 'string') return null
  const auth = value['responseAuth']
  if (!isRecord(auth) || auth['version'] !== 1) return null
  if (AUTH_STRING_FIELDS.some((field) => typeof auth[field] !== 'string')) return null
  if (AUTH_NUMBER_FIELDS.some((field) => typeof auth[field] !== 'number' || !Number.isFinite(auth[field]))) return null
  if (auth['channelId'] !== undefined && typeof auth['channelId'] !== 'string') return null
  return {
    batchIndex: value['batchIndex'],
    requestId: value['requestId'],
    responseAuth: {
      version: 1,
      requestId: auth['requestId'] as string,
      ...(typeof auth['channelId'] === 'string' ? { channelId: auth['channelId'] } : {}),
      buyerPeerId: auth['buyerPeerId'] as string,
      sellerPeerId: auth['sellerPeerId'] as string,
      advertisedService: auth['advertisedService'] as string,
      provider: auth['provider'] as string,
      statusCode: auth['statusCode'] as number,
      requestHash: auth['requestHash'] as string,
      responseHash: auth['responseHash'] as string,
      responseStartedAt: auth['responseStartedAt'] as number,
      responseCompletedAt: auth['responseCompletedAt'] as number,
      signature: auth['signature'] as string,
    },
    requestBase64: value['requestBase64'],
    responseBase64: value['responseBase64'],
  }
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
