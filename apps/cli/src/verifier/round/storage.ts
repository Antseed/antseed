import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
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
  /**
   * Fetches `uri` and, when given, rejects bytes whose keccak256 differs from `expectedHash`.
   * Never holds more than `maxBytes` (default: the largest round file) in memory.
   */
  get(uri: string, expectedHash?: string, maxBytes?: number): Promise<Buffer>
}

const MIB = 1024 * 1024

/**
 * Largest file of each kind a reader accepts. Anything bigger is cut off while it streams in,
 * so one oversized commitment cannot exhaust a verifier's memory; well above what a real round
 * produces (a plan for 100 targets is a few MiB, a collector's slices tens of KiB per target).
 */
export const ROUND_FILE_MAX_BYTES = {
  bank: 64 * MIB,
  plan: 32 * MIB,
  slices: 32 * MIB,
  results: 16 * MIB,
  keyShares: 1 * MIB,
} as const

/**
 * The commitment is invalid for good, whoever reads it: a URI that cannot name a round file, or
 * (for the directory store, which reads its own disk) bytes that are not the committed ones.
 * Bytes from an IPFS gateway that miss the committed hash are not this: they are not checked
 * against the CID, so a bad gateway or an error page would look the same. Those count as
 * unavailable, which verifiers wait out before scoring without them.
 */
export class RoundFileMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoundFileMismatchError'
  }
}

/** A round file larger than its kind allows; counts as not served, like any failed fetch. */
export class RoundFileTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoundFileTooLargeError'
  }
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

  async get(uri: string, expectedHash?: string, maxBytes: number = ROUND_FILE_MAX_BYTES.bank): Promise<Buffer> {
    const cid = uri.replace(/^ipfs:\/\//, '')
    if (!/^[A-Za-z0-9]{20,128}$/.test(cid)) throw new RoundFileMismatchError(`not an IPFS round file: ${uri}`)
    const failures: string[] = []
    for (const gateway of this.gateways) {
      const url = `${gateway.replace(/\/+$/, '')}/${cid}`
      try {
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (!response.ok) {
          failures.push(`${url}: HTTP ${response.status}`)
          continue
        }
        // A gateway's oversized answer proves nothing about the CID, so like a mismatch it only
        // fails this gateway; a commitment that really is oversized fails on every gateway and
        // ends up unavailable, which verifiers wait out and then score without.
        const bytes = await readBounded(response, maxBytes)
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

/** Reads a response body, cancelling it as soon as it exceeds `maxBytes`. */
export async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new RoundFileTooLargeError(`declared ${declared} bytes, more than the ${maxBytes} allowed`)
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new RoundFileTooLargeError(`more than the ${maxBytes} bytes allowed`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
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

  async get(uri: string, expectedHash?: string, maxBytes: number = ROUND_FILE_MAX_BYTES.bank): Promise<Buffer> {
    const id = uri.replace(/^ipfs:\/\//, '')
    if (!/^local-[0-9a-f]{64}$/.test(id)) throw new RoundFileMismatchError(`not a local round file: ${uri}`)
    const path = join(this.directory, id)
    // The store's own disk: an oversized file is the committed file, so it is invalid for good.
    if ((await stat(path)).size > maxBytes) throw new RoundFileMismatchError(`${uri} is larger than the ${maxBytes} bytes allowed`)
    const bytes = await readFile(path)
    if (expectedHash && contentHash(bytes).toLowerCase() !== expectedHash.toLowerCase()) {
      throw new RoundFileMismatchError(`${uri} does not match the committed hash`)
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
