import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DEFAULT_IPFS_GATEWAYS } from '@antseed/model-verifier'
import { contentHash } from './sealing.js'

/**
 * Where round files live. Production uses IPFS (Pinata to publish, public gateways to read);
 * every read is checked against the hash committed on-chain, so any gateway is safe.
 */
export interface RoundStorage {
  put(bytes: Uint8Array, name: string): Promise<string>
  /** Fetches `uri` and, when given, rejects bytes whose keccak256 differs from `expectedHash`. */
  get(uri: string, expectedHash?: string): Promise<Buffer>
}

const PINATA_UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files'
const FETCH_TIMEOUT_MS = 60_000

export class PinataRoundStorage implements RoundStorage {
  constructor(
    private readonly jwt: string,
    private readonly gateways: readonly string[] = DEFAULT_IPFS_GATEWAYS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async put(bytes: Uint8Array, name: string): Promise<string> {
    if (!this.jwt.trim()) throw new Error('PINATA_JWT is required to publish round files')
    let lastError = ''
    for (let attempt = 1; attempt <= 4; attempt++) {
      const form = new FormData()
      form.append('file', new File([bytes], name, { type: 'application/octet-stream' }))
      form.append('network', 'public')
      form.append('name', name)
      form.append('cid_version', 'v1')
      try {
        const response = await this.fetchImpl(PINATA_UPLOAD_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.jwt}` },
          body: form,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (response.ok) {
          const parsed = await response.json() as { data?: { cid?: string } }
          const cid = parsed.data?.cid?.trim() ?? ''
          if (!/^b[a-z2-7]{20,}$/.test(cid)) throw new Error('Pinata returned an invalid CIDv1')
          return `ipfs://${cid}`
        }
        lastError = `HTTP ${response.status}`
        if (response.status !== 429 && response.status < 500) break
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** (attempt - 1)))
    }
    throw new Error(`Pinata upload of ${name} failed: ${lastError}`)
  }

  async get(uri: string, expectedHash?: string): Promise<Buffer> {
    const cid = uri.replace(/^ipfs:\/\//, '')
    const failures: string[] = []
    for (const gateway of this.gateways) {
      const url = `${gateway.replace(/\/+$/, '')}/${cid}`
      try {
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (!response.ok) {
          failures.push(`${url}: HTTP ${response.status}`)
          continue
        }
        const bytes = Buffer.from(await response.arrayBuffer())
        if (expectedHash && contentHash(bytes).toLowerCase() !== expectedHash.toLowerCase()) {
          failures.push(`${url}: content does not match the committed hash`)
          continue
        }
        return bytes
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`failed to fetch ${uri} (${failures.join('; ')})`)
  }
}

/**
 * A shared directory standing in for IPFS (local testnets and tests). URIs are
 * `ipfs://local-<sha256>`, so they pass the contract's ipfs:// check.
 */
export class DirectoryRoundStorage implements RoundStorage {
  constructor(private readonly directory: string) {}

  async put(bytes: Uint8Array): Promise<string> {
    await mkdir(this.directory, { recursive: true })
    const id = `local-${createHash('sha256').update(bytes).digest('hex')}`
    await writeFile(join(this.directory, id), bytes)
    return `ipfs://${id}`
  }

  async get(uri: string, expectedHash?: string): Promise<Buffer> {
    const id = uri.replace(/^ipfs:\/\//, '')
    if (!/^local-[0-9a-f]{64}$/.test(id)) throw new Error(`not a local round file: ${uri}`)
    const bytes = await readFile(join(this.directory, id))
    if (expectedHash && contentHash(bytes).toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error(`${uri} does not match the committed hash`)
    }
    return bytes
  }
}

/** `ANTSEED_ROUND_STORAGE_DIR` selects the directory store; otherwise Pinata with `PINATA_JWT`. */
export function roundStorageFromEnv(env: NodeJS.ProcessEnv = process.env): RoundStorage {
  const directory = env['ANTSEED_ROUND_STORAGE_DIR']?.trim()
  if (directory) return new DirectoryRoundStorage(directory)
  const gateways = env['ANTSEED_IPFS_GATEWAYS']?.split(',').map((value) => value.trim()).filter(Boolean)
  return new PinataRoundStorage(env['PINATA_JWT'] ?? '', gateways && gateways.length > 0 ? gateways : DEFAULT_IPFS_GATEWAYS)
}
