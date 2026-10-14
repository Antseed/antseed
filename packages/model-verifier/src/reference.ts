import { readFile } from 'node:fs/promises'
import { validateKbfReferenceV1, type KbfReferenceV1 } from '@antseed/fingerprints'
import { fetchIpfsText } from './ipfs.js'

export interface LoadReferenceOptions {
  /** Accept references marked `imported`, whose provenance the operator vouches for. */
  trustImported?: boolean
  fetchImpl?: typeof fetch
  ipfsGateway?: string
}

/**
 * Loads a KBF reference from a file path, an https URL, or an ipfs:// URI and validates
 * it, including its content-addressed referenceId, before it is used to judge anything.
 */
export async function loadReference(source: string, options: LoadReferenceOptions = {}): Promise<KbfReferenceV1> {
  const raw = await readSource(source, options)
  return validateKbfReferenceV1(JSON.parse(raw) as unknown, { trustImported: options.trustImported === true })
}

async function readSource(source: string, options: LoadReferenceOptions): Promise<string> {
  if (source.startsWith('ipfs://')) return fetchIpfsText(source.slice('ipfs://'.length), options)
  if (source.startsWith('https://') || source.startsWith('http://')) return fetchText(source, options.fetchImpl)
  return readFile(source, 'utf8')
}

async function fetchText(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`failed to fetch reference ${url}: HTTP ${response.status}`)
  return response.text()
}
