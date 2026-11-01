import { canonicalJsonStringify } from '@antseed/fingerprints'

/** The exact bytes of a published round file: canonical JSON, so every party hashes the same bytes. */
export function encodeRoundFile(value: unknown): Buffer {
  return Buffer.from(canonicalJsonStringify(value), 'utf8')
}
