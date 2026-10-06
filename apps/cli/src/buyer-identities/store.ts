import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_BUYER_IDENTITY,
  FileIdentityStore,
  identityFromPrivateKeyHex,
  isValidBuyerIdentityName,
  type Identity,
} from '@antseed/node'

/**
 * Extra buyer wallets live next to the default identity, one directory each:
 *   <dataDir>/buyer-identities/<name>/identity.key
 * A running buyer pays as any of them when a request names it.
 */
const IDENTITIES_DIR = 'buyer-identities'
const ARCHIVE_DIR = '.archived'

export interface StoredBuyerIdentity {
  name: string
  address: string
  dir: string
}

export function buyerIdentitiesDir(dataDir: string): string {
  return join(dataDir, IDENTITIES_DIR)
}

export function buyerIdentityDir(dataDir: string, name: string): string {
  return join(buyerIdentitiesDir(dataDir), name)
}

export function assertBuyerIdentityName(name: string): void {
  if (name === DEFAULT_BUYER_IDENTITY) throw new Error(`"${DEFAULT_BUYER_IDENTITY}" is the identity in your data dir and always exists.`)
  if (!isValidBuyerIdentityName(name)) {
    throw new Error('Identity names use lowercase letters, digits and dashes (max 32 characters).')
  }
}

/**
 * Generated directly rather than through loadOrCreateIdentity, which would
 * adopt an ANTSEED_IDENTITY_HEX inherited from a parent process and give the
 * new identity the default wallet.
 */
export async function createBuyerIdentity(dataDir: string, name: string): Promise<StoredBuyerIdentity> {
  assertBuyerIdentityName(name)
  const dir = buyerIdentityDir(dataDir, name)
  const store = new FileIdentityStore(dir)
  if (await store.load() !== null) throw new Error(`Buyer identity "${name}" already exists.`)
  const hex = randomBytes(32).toString('hex')
  await store.save(hex)
  return { name, address: identityFromPrivateKeyHex(hex).wallet.address, dir }
}

export async function loadBuyerIdentity(dataDir: string, name: string): Promise<Identity | null> {
  if (!isValidBuyerIdentityName(name) || name === DEFAULT_BUYER_IDENTITY) return null
  const hex = await new FileIdentityStore(buyerIdentityDir(dataDir, name)).load()
  return hex && hex.length === 64 ? identityFromPrivateKeyHex(hex) : null
}

export async function listBuyerIdentities(dataDir: string): Promise<StoredBuyerIdentity[]> {
  let names: string[]
  try {
    names = await readdir(buyerIdentitiesDir(dataDir))
  } catch {
    return []
  }
  const identities: StoredBuyerIdentity[] = []
  for (const name of names.sort()) {
    const identity = await loadBuyerIdentity(dataDir, name).catch(() => null)
    if (identity) identities.push({ name, address: identity.wallet.address, dir: buyerIdentityDir(dataDir, name) })
  }
  return identities
}

/** The default wallet's address, or why the CLI cannot read it. */
export async function readDefaultWallet(dataDir: string): Promise<{ address: string | null; note: string }> {
  try {
    const hex = await new FileIdentityStore(dataDir).load()
    if (hex && hex.length === 64) return { address: identityFromPrivateKeyHex(hex).wallet.address, note: '' }
    return { address: null, note: 'created on first buyer start' }
  } catch {
    return { address: null, note: 'encrypted by the AI VPN' }
  }
}

/** Wallet address of any identity, default included; null when unknown or unreadable. */
export async function buyerIdentityAddress(dataDir: string, name: string): Promise<string | null> {
  if (name === DEFAULT_BUYER_IDENTITY) return (await readDefaultWallet(dataDir)).address
  return (await loadBuyerIdentity(dataDir, name))?.wallet.address ?? null
}

/** Move an identity aside; its key is kept because the wallet may still hold funds. */
export async function archiveBuyerIdentity(dataDir: string, name: string): Promise<string> {
  assertBuyerIdentityName(name)
  const dir = buyerIdentityDir(dataDir, name)
  await stat(dir).catch(() => { throw new Error(`Unknown buyer identity "${name}".`) })
  const archiveRoot = join(buyerIdentitiesDir(dataDir), ARCHIVE_DIR)
  await mkdir(archiveRoot, { recursive: true })
  const target = join(archiveRoot, `${name}-${Date.now()}`)
  await rename(dir, target)
  return target
}
