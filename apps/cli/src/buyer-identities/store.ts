import { randomBytes } from 'node:crypto'
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  DEFAULT_BUYER_IDENTITY,
  FileIdentityStore,
  identityFromPrivateKeyHex,
  isValidBuyerIdentityName,
  loadOrCreateIdentity,
  type Identity,
  type IdentityStore,
} from '@antseed/node'

/**
 * Extra buyer wallets live next to the default identity, one directory each:
 *   <dataDir>/buyer-identities/<name>/identity.key   (the private key), or
 *   <dataDir>/buyer-identities/<name>/identity.json  ({"keyFrom": "env:VAR" | "file:/path"})
 * The second form keeps the key out of the data dir: it is read at load time
 * from an env var or a file a secret manager provides.
 * A running buyer pays as any of them when a request names it.
 */
const IDENTITIES_DIR = 'buyer-identities'
const ARCHIVE_DIR = '.archived'
const KEY_FILE = 'identity.key'
const KEY_SOURCE_FILE = 'identity.json'
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface StoredBuyerIdentity {
  name: string
  /** Null when the key cannot be read; `error` says why. */
  address: string | null
  dir: string
  /** Where the key comes from when it is not stored in the data dir. */
  keyFrom?: string
  error?: string
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

/** Validates a `--key-from` value: `env:<VAR>` or `file:<absolute path>`. */
export function parseKeySource(spec: string): string {
  const [kind, ...rest] = spec.split(':')
  const target = rest.join(':')
  if (kind === 'env' && ENV_NAME_PATTERN.test(target)) return spec
  if (kind === 'file' && isAbsolute(target)) return spec
  throw new Error('--key-from takes env:<VAR> or file:<absolute path>.')
}

async function readKeyFromSource(keyFrom: string): Promise<string> {
  const [kind, ...rest] = keyFrom.split(':')
  const target = rest.join(':')
  let raw: string | undefined
  if (kind === 'env') {
    raw = process.env[target]
    if (!raw) throw new Error(`env var ${target} is not set`)
  } else {
    raw = await readFile(target, 'utf8').catch(() => { throw new Error(`cannot read ${target}`) })
  }
  const hex = raw.trim().replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${keyFrom} does not hold a 32-byte hex private key`)
  return hex.toLowerCase()
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/**
 * Without `keyFrom`, a new key is generated and stored in the data dir.
 * Generated directly rather than through loadOrCreateIdentity, which would
 * adopt an ANTSEED_IDENTITY_HEX inherited from a parent process and give the
 * new identity the default wallet. With `keyFrom`, only the reference is
 * stored and the key is read from it on every load.
 */
export async function createBuyerIdentity(dataDir: string, name: string, keyFrom?: string): Promise<StoredBuyerIdentity> {
  assertBuyerIdentityName(name)
  const dir = buyerIdentityDir(dataDir, name)
  if (await buyerIdentityExists(dataDir, name)) {
    throw new Error(`Buyer identity "${name}" already exists.`)
  }
  if (keyFrom) {
    const hex = await readKeyFromSource(parseKeySource(keyFrom))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, KEY_SOURCE_FILE), `${JSON.stringify({ keyFrom }, null, 2)}\n`, { mode: 0o600 })
    return { name, address: identityFromPrivateKeyHex(hex).wallet.address, dir, keyFrom }
  }
  const hex = randomBytes(32).toString('hex')
  await new FileIdentityStore(dir).save(hex)
  return { name, address: identityFromPrivateKeyHex(hex).wallet.address, dir }
}

/** True when an identity with this name is stored, without reading its key. */
export async function buyerIdentityExists(dataDir: string, name: string): Promise<boolean> {
  const dir = buyerIdentityDir(dataDir, name)
  return await exists(join(dir, KEY_FILE)) || await exists(join(dir, KEY_SOURCE_FILE))
}

/** Where an identity's key comes from, or null when it is stored in the data dir. */
async function readKeySourceRef(dir: string): Promise<string | null> {
  const raw = await readFile(join(dir, KEY_SOURCE_FILE), 'utf8').catch(() => null)
  if (raw === null) return null
  const keyFrom = (JSON.parse(raw) as { keyFrom?: unknown }).keyFrom
  if (typeof keyFrom !== 'string') throw new Error(`${KEY_SOURCE_FILE} has no keyFrom`)
  return parseKeySource(keyFrom)
}

/**
 * The identity's wallet, or null when no identity has that name. Throws when
 * it exists but its key cannot be read, rather than falling back to anything.
 */
export async function loadBuyerIdentity(dataDir: string, name: string): Promise<Identity | null> {
  if (!isValidBuyerIdentityName(name) || name === DEFAULT_BUYER_IDENTITY) return null
  const dir = buyerIdentityDir(dataDir, name)
  const keyFrom = await readKeySourceRef(dir)
  if (keyFrom) {
    if (await exists(join(dir, KEY_FILE))) {
      throw new Error(`Buyer identity "${name}" has both ${KEY_FILE} and ${KEY_SOURCE_FILE}; remove the one you did not mean to use`)
    }
    return identityFromPrivateKeyHex(await readKeyFromSource(keyFrom))
  }
  const hex = await new FileIdentityStore(dir).load()
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
    if (!isValidBuyerIdentityName(name) || name === DEFAULT_BUYER_IDENTITY) continue
    const dir = buyerIdentityDir(dataDir, name)
    const keyFrom = await readKeySourceRef(dir).catch(() => undefined)
    try {
      const identity = await loadBuyerIdentity(dataDir, name)
      if (identity) identities.push({ name, address: identity.wallet.address, dir, ...(keyFrom ? { keyFrom } : {}) })
    } catch (err) {
      identities.push({ name, address: null, dir, ...(keyFrom ? { keyFrom } : {}), error: err instanceof Error ? err.message : String(err) })
    }
  }
  return identities
}

/** The default wallet's address, or why the CLI cannot read it. */
export async function readDefaultWallet(dataDir: string): Promise<{ address: string | null; note: string }> {
  try {
    const { identity, fromEnv } = await loadDefaultBuyerIdentity(dataDir)
    if (identity) return { address: identity.wallet.address, note: fromEnv ? 'from ANTSEED_IDENTITY_HEX' : '' }
    return { address: null, note: 'created on first buyer start' }
  } catch {
    return { address: null, note: 'encrypted by the AI VPN' }
  }
}

class NoStoredDefaultIdentity extends Error {}

/**
 * The default identity exactly as the buyer loads it: ANTSEED_IDENTITY_HEX
 * (how the desktop app hands the buyer its wallet) first, then the data
 * dir's identity.key. Goes through the node's own loader, so a key it already
 * took from the environment in this process is found too, but never creates
 * a key. `fromEnv` says the key did not come from the data dir.
 */
export async function loadDefaultBuyerIdentity(dataDir: string): Promise<{ identity: Identity | null; fromEnv: boolean }> {
  let readDisk = false
  const store: IdentityStore = {
    load: () => {
      readDisk = true
      return new FileIdentityStore(dataDir).load()
    },
    save: () => Promise.reject(new NoStoredDefaultIdentity()),
  }
  try {
    const identity = await loadOrCreateIdentity(store)
    return { identity, fromEnv: !readDisk }
  } catch (err) {
    if (err instanceof NoStoredDefaultIdentity) return { identity: null, fromEnv: false }
    throw err
  }
}

/**
 * The desktop app keeps the default wallet encrypted (identity.enc) and hands
 * it to the buyer in ANTSEED_IDENTITY_HEX; without that variable a CLI
 * process cannot know which wallet the buyer pays from.
 */
export function hasDesktopIdentity(dataDir: string): Promise<boolean> {
  return exists(join(dataDir, 'identity.enc'))
}

/** The signing key of any identity, default included, as the buyer loads it; null when none is stored. */
export async function loadBuyerSigningIdentity(dataDir: string, name: string): Promise<Identity | null> {
  if (name === DEFAULT_BUYER_IDENTITY) return (await loadDefaultBuyerIdentity(dataDir)).identity
  return loadBuyerIdentity(dataDir, name)
}

/** Wallet address of any identity, default included (honouring ANTSEED_IDENTITY_HEX); null when unknown or unreadable. */
export async function buyerIdentityAddress(dataDir: string, name: string): Promise<string | null> {
  if (name === DEFAULT_BUYER_IDENTITY) return (await loadDefaultBuyerIdentity(dataDir).catch(() => null))?.identity?.wallet.address ?? null
  return (await loadBuyerIdentity(dataDir, name).catch(() => null))?.wallet.address ?? null
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
