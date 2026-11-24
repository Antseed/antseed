import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import type { PreparedVerificationPublication, PublishedVerificationEvidence } from './ipfs-publication.js'

/**
 * Testing only: a dry run's evidence publication on this machine instead of IPFS (`verifier.testPublication`).
 * `verifier submit` writes each model audit's package to `<directory>/<id>/…`, and `verifier run` and `submit` read
 * other auditors' published evidence from `<gatewayUrl>/<id>/…` (a local HTTP server over that directory) instead of
 * the public gateways. Nothing becomes public.
 *
 * The id has the shape of a CIDv1 (`b` and base32) so every reader takes it, but it is no IPFS CID: it is the SHA-256
 * of the package's file list. Readers never trust it for integrity: the evidence is checked against the hash its audit
 * committed on chain, as for IPFS. It is allowed only while the chain RPC is on this machine (a local fork), so it can
 * never record an audit on Base.
 */
export interface TestPublicationConfig {
  directory: string
  gatewayUrl: string
}

/** The test publication to use, or null without one; throws when it is set but the chain RPC is not local. */
export function testPublicationFor(config: TestPublicationConfig | undefined, rpcUrl: string | undefined): TestPublicationConfig | null {
  if (!config) return null
  if (!isLocalUrl(rpcUrl)) {
    throw new Error('verifier.testPublication is for a dry run on a local fork only: the chain RPC must be on this machine '
      + `(127.0.0.1 or localhost), not ${rpcUrl ? new URL(rpcUrl).host : 'the default Base RPC'}. Remove it to publish to IPFS.`)
  }
  if (!isLocalUrl(config.gatewayUrl)) throw new Error('verifier.testPublication.gatewayUrl must be on this machine (127.0.0.1 or localhost)')
  return config
}

/** Whether a URL is on this machine: 127.0.0.1, localhost or [::1]. */
export function isLocalUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const host = new URL(value).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  } catch {
    return false
  }
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lower case, no padding. */
function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** The package's id: `b` and the base32 SHA-256 of its file list (paths and hashes), the same for the same package. */
export function testPublicationId(publication: Pick<PreparedVerificationPublication, 'files'>): string {
  const list = publication.files.map((file) => ({ path: file.path, sha256: file.sha256 })).sort((left, right) => left.path.localeCompare(right.path))
  return `b${base32(createHash('sha256').update(canonicalJsonStringify(list)).digest())}`
}

/** Writes the package under `<directory>/<id>/`, every path inside it; the same package always lands in the same place. */
export async function publishVerificationToDirectory(
  publication: PreparedVerificationPublication,
  directory: string,
  now: () => Date = () => new Date(),
): Promise<PublishedVerificationEvidence> {
  const id = testPublicationId(publication)
  const root = resolve(directory, id)
  for (const file of publication.files) {
    const target = resolve(root, file.path)
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`publication path ${file.path} escapes its package`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.bytes)
  }
  return {
    provider: 'local-test',
    evidenceHash: publication.evidenceHash,
    cid: id,
    uri: `ipfs://${id}`,
    pinSize: publication.totalBytes,
    fileCount: publication.fileCount,
    publishedAt: now().toISOString(),
  }
}

/** Where a package with this id was written, for tests and the run book. */
export function testPublicationPath(directory: string, id: string): string {
  return join(directory, id)
}
