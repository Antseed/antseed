import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, type ScryptOptions } from 'node:crypto'
import {
  chmodSync, closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs'
import { connect } from 'node:net'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { PassThrough, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import Database from 'better-sqlite3'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { buyerIdentityAddress, listBuyerIdentities, loadDefaultBuyerIdentity } from '../buyer-identities/store.js'
import { sameAddress, type BuyerAddressBook } from './services/wallet-address.js'
import { CONSOLE_LOCATION_SETTING, readConsoleLocation, type ConsoleLocation } from './console-location.js'
import { clearRecoveryTokens } from './console-recovery.js'
import { GatewayStore } from './store.js'

/**
 * A password-encrypted copy of a gateway's state, for moving it to another
 * machine (`antseed gateway export` / `import`).
 *
 * File layout:
 *   "ANTSEED-GATEWAY-BUNDLE 1\n"  header JSON + "\n"  ciphertext  16-byte GCM tag
 * The header (KDF parameters, salt, IV) is authenticated as AAD. The key is
 * scrypt(password, salt). The plaintext is a gzipped sequence of entries,
 * each `u32 header length | header JSON {path, size, sha256} | bytes`, and
 * every entry's SHA-256 is checked again on import.
 */
export const BUNDLE_MAGIC = 'ANTSEED-GATEWAY-BUNDLE 1\n'
const CONTAINER_MAGIC = Buffer.from('AGWB\x01', 'binary')
const TAG_BYTES = 16
const KEY_BYTES = 32
const MAX_HEADER_BYTES = 4096
export const MIN_PASSWORD_LENGTH = 10
const SCRYPT_DEFAULT = { N: 2 ** 17, r: 8, p: 1 }

const GATEWAY_DB = 'data/gateway/gateway.db'
const CHANNELS_DB = 'data/payments/sessions.db'
const IDENTITY_KEY = 'data/identity.key'
const IDENTITIES_PREFIX = 'data/buyer-identities/'
const CONFIG = 'config/config.json'
const MANIFEST = 'manifest.json'

interface BundleHeader {
  kdf: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
  cipher: 'aes-256-gcm'
  iv: string
  compression: 'gzip'
}

export interface BundleManifest {
  format: 'antseed-gateway-bundle'
  version: 1
  createdAt: string
  cliVersion: string
  /** The console location the source gateway saved; tells import whether passkeys can keep working. */
  consoleLocation: ConsoleLocation | null
  files: string[]
}

export interface BundleSummary {
  workspaces: Array<{ id: string; name: string; wallet: string; address: string | null }>
  activeKeys: number
  members: Array<{ label: string; email: string | null; orgRole: string; status: string }>
  wallets: Array<{ name: string; address: string | null; note?: string }>
  passkeys: number
}

/** Owner-only modes for everything restored or written. */
const FILE_MODE = 0o600
const DIR_MODE = 0o700

function scrypt(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: 256 * params.N * params.r + 1024 * 1024 }
  return new Promise((resolvePromise, reject) => {
    scryptCallback(password.normalize('NFKC'), salt, KEY_BYTES, options, (error, key) => (error ? reject(error) : resolvePromise(key)))
  })
}

function sha256File(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE })
  if (process.platform !== 'win32') chmodSync(path, DIR_MODE)
}

/** A consistent copy of a live SQLite database (other processes may keep writing). */
export function snapshotSqlite(source: string, target: string): void {
  ensureDir(dirname(target))
  const db = new Database(source, { readonly: true, fileMustExist: true, timeout: 10_000 })
  try {
    db.pragma('busy_timeout = 10000')
    db.prepare('VACUUM INTO ?').run(target)
  } finally {
    db.close()
  }
  if (process.platform !== 'win32') chmodSync(target, FILE_MODE)
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
export function portInUse(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (open: boolean) => { socket.destroy(); resolvePromise(open) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The buyer port a config file sets (8377 by default). */
export function configuredBuyerPort(configPath: string): number {
  const buyer = readJson(configPath)?.['buyer']
  const port = buyer && typeof buyer === 'object' ? (buyer as { proxyPort?: unknown }).proxyPort : undefined
  return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : 8377
}

/** Regular files under a directory, as paths relative to it (symlinks and other specials are skipped). */
function walkFiles(root: string, relative = ''): string[] {
  const dir = join(root, relative)
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const path = relative ? `${relative}/${name}` : name
    const stat = lstatSync(join(root, path))
    if (stat.isDirectory()) files.push(...walkFiles(root, path))
    else if (stat.isFile()) files.push(path)
  }
  return files
}

function safeSegment(segment: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..'
}

/** Only these paths may come out of a bundle; anything else is refused. */
export function allowedBundlePath(path: string): boolean {
  if ([GATEWAY_DB, CHANNELS_DB, IDENTITY_KEY, CONFIG, MANIFEST].includes(path)) return true
  if (!path.startsWith(IDENTITIES_PREFIX)) return false
  const rest = path.slice(IDENTITIES_PREFIX.length).split('/')
  return rest.length >= 2 && rest.length <= 4 && rest.every(safeSegment)
}

// ── Export ────────────────────────────────────────────────────────────────

export interface ExportOptions {
  dataDir: string
  configPath: string
  outFile: string
  password: string
  /** Replace an existing file at outFile. */
  force?: boolean
  cliVersion: string
  now?: () => number
  /** KDF cost override, for tests only. */
  scryptParams?: { N: number; r: number; p: number }
  /**
   * The running buyer's identity → address. A wallet key that is not the one
   * the buyer pays from is refused rather than exported.
   */
  buyerAddresses?: BuyerAddressBook
}

export interface ExportResult {
  outFile: string
  bytes: number
  files: string[]
  warnings: string[]
  summary: BundleSummary
}

async function writeChunk(stream: Writable, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) await new Promise<void>((resolvePromise) => stream.once('drain', () => resolvePromise()))
}

async function writeEntry(stream: Writable, path: string, file: string): Promise<void> {
  const size = statSync(file).size
  const header = Buffer.from(JSON.stringify({ path, size, sha256: sha256File(file) }), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(header.length)
  await writeChunk(stream, length)
  await writeChunk(stream, header)
  let written = 0
  for await (const chunk of createReadStream(file)) {
    written += (chunk as Buffer).length
    await writeChunk(stream, chunk as Buffer)
  }
  if (written !== size) throw new Error(`${path} changed while it was being exported; try again.`)
}

/**
 * Writes the encrypted bundle. Databases are copied with `VACUUM INTO`, a
 * consistent snapshot even while the gateway and buyer keep writing.
 */
export async function exportGatewayBundle(options: ExportOptions): Promise<ExportResult> {
  const { dataDir, configPath, password } = options
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
  const outFile = resolve(options.outFile)
  if (existsSync(outFile) && !options.force) throw new Error(`${outFile} already exists; pass --force to replace it.`)
  const gatewayDb = join(dataDir, 'gateway', 'gateway.db')
  if (!existsSync(gatewayDb)) throw new Error(`No gateway data in ${dataDir} (missing gateway/gateway.db). Is --data-dir right?`)
  // The default wallet as the buyer loads it: ANTSEED_IDENTITY_HEX (the desktop app's key) wins over identity.key.
  const defaultIdentity = await loadDefaultBuyerIdentity(dataDir).catch(() => ({ identity: null, fromEnv: false }))
  if (!defaultIdentity.fromEnv && !existsSync(join(dataDir, 'identity.key')) && existsSync(join(dataDir, 'identity.enc'))) {
    throw new Error('The default wallet is encrypted by the Antseed desktop app (identity.enc), which the CLI cannot read. Export its private key from the app, save it as identity.key in the data dir, and try again.')
  }

  const warnings: string[] = []
  const staging = join(dirname(outFile), `.${basename(outFile)}.export-${randomBytes(6).toString('hex')}`)
  ensureDir(staging)
  const partial = join(dirname(outFile), `.${basename(outFile)}.partial-${randomBytes(6).toString('hex')}`)
  try {
    const entries: Array<{ path: string; file: string }> = []
    const snapshotDb = join(staging, GATEWAY_DB)
    snapshotSqlite(gatewayDb, snapshotDb)
    entries.push({ path: GATEWAY_DB, file: snapshotDb })
    const channelsDb = join(dataDir, 'payments', 'sessions.db')
    if (existsSync(channelsDb)) {
      const snapshot = join(staging, CHANNELS_DB)
      snapshotSqlite(channelsDb, snapshot)
      entries.push({ path: CHANNELS_DB, file: snapshot })
    }
    if (defaultIdentity.fromEnv && defaultIdentity.identity) {
      const envKey = join(staging, 'identity.key')
      writeOwnerOnly(envKey, defaultIdentity.identity.wallet.privateKey.replace(/^0x/, ''))
      entries.push({ path: IDENTITY_KEY, file: envKey })
      warnings.push(`The default wallet (${defaultIdentity.identity.wallet.address}) was taken from ANTSEED_IDENTITY_HEX, as the buyer does; the bundle stores it as identity.key.`)
    } else if (existsSync(join(dataDir, 'identity.key'))) entries.push({ path: IDENTITY_KEY, file: join(dataDir, 'identity.key') })
    else warnings.push('There is no default wallet yet (identity.key); the server creates a new one on first start.')
    const identitiesDir = join(dataDir, 'buyer-identities')
    for (const relative of walkFiles(identitiesDir)) {
      const path = `${IDENTITIES_PREFIX}${relative}`
      if (!allowedBundlePath(path)) {
        warnings.push(`Skipped buyer-identities/${relative}: unexpected file name.`)
        continue
      }
      entries.push({ path, file: join(identitiesDir, relative) })
    }
    const live = options.buyerAddresses ? await options.buyerAddresses().catch(() => null) : null
    if (live) {
      const exported = [
        { name: DEFAULT_BUYER_IDENTITY, address: defaultIdentity.identity?.wallet.address ?? null },
        ...(await listBuyerIdentities(dataDir)).map((identity) => ({ name: identity.name, address: identity.address })),
      ]
      for (const { name, address } of exported) {
        const buyerAddress = live.get(name)
        if (address && buyerAddress && !sameAddress(address, buyerAddress)) {
          throw new Error(`The key for wallet "${name}" here is ${address}, but the running buyer pays from ${buyerAddress}. Run the export with the buyer's key (e.g. the same ANTSEED_IDENTITY_HEX) so the bundle carries the wallet the gateway uses.`)
        }
      }
    }
    for (const identity of await listBuyerIdentities(dataDir)) {
      if (identity.keyFrom) warnings.push(`Wallet "${identity.name}" reads its key from ${identity.keyFrom}; that key is not in the bundle. Provide the same ${identity.keyFrom.split(':')[0]} on the server.`)
    }
    if (existsSync(configPath)) entries.push({ path: CONFIG, file: configPath })

    const location = readConsoleLocationFrom(snapshotDb)
    const manifest: BundleManifest = {
      format: 'antseed-gateway-bundle',
      version: 1,
      createdAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      cliVersion: options.cliVersion,
      consoleLocation: location,
      files: entries.map((entry) => entry.path),
    }
    const manifestFile = join(staging, MANIFEST)
    writeOwnerOnly(manifestFile, JSON.stringify(manifest, null, 2))

    const params = options.scryptParams ?? SCRYPT_DEFAULT
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const header: BundleHeader = { kdf: 'scrypt', ...params, salt: salt.toString('base64'), cipher: 'aes-256-gcm', iv: iv.toString('base64'), compression: 'gzip' }
    const headerBytes = Buffer.from(`${BUNDLE_MAGIC}${JSON.stringify(header)}\n`, 'utf8')
    const key = await scrypt(password, salt, params)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(headerBytes)

    // 'wx' with 0600: never follows an existing file, never readable by others.
    const fd = openSync(partial, 'wx', FILE_MODE)
    writeSync(fd, headerBytes)
    const out = createWriteStream(partial, { fd, autoClose: true, start: headerBytes.length })
    const plain = new PassThrough()
    const written = pipeline(plain, createGzip({ level: 6 }), cipher, out)
    await writeChunk(plain, CONTAINER_MAGIC)
    await writeEntry(plain, MANIFEST, manifestFile)
    for (const entry of entries) await writeEntry(plain, entry.path, entry.file)
    plain.end()
    await written
    const tagFd = openSync(partial, 'a')
    try {
      writeSync(tagFd, cipher.getAuthTag())
    } finally {
      closeSync(tagFd)
    }
    if (process.platform !== 'win32') {
      chmodSync(partial, FILE_MODE)
      const mode = statSync(partial).mode & 0o777
      if (mode !== FILE_MODE) throw new Error(`Could not make the bundle private (mode ${mode.toString(8)}); write it to another directory.`)
    }
    renameSync(partial, outFile)

    const summary = await summarizeDataDir(join(staging, 'data'), { identitySource: dataDir })
    return { outFile, bytes: statSync(outFile).size, files: manifest.files, warnings, summary }
  } finally {
    rmSync(partial, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

function writeOwnerOnly(path: string, content: string): void {
  ensureDir(dirname(path))
  const fd = openSync(path, 'w', FILE_MODE)
  try {
    writeSync(fd, content)
  } finally {
    closeSync(fd)
  }
}

function readConsoleLocationFrom(dbFile: string): ConsoleLocation | null {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()
    if (!hasTable) return null
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CONSOLE_LOCATION_SETTING) as { value: string | null } | undefined
    if (!row?.value) return null
    return readConsoleLocation({ getSetting: <T>() => JSON.parse(row.value!) as T })
  } catch {
    return null
  } finally {
    db.close()
  }
}

// ── Import ────────────────────────────────────────────────────────────────

export interface ImportOptions {
  bundleFile: string
  dataDir: string
  configPath: string
  password: string
  /** Back up and replace an existing data dir. */
  force?: boolean
  /** Origin the console will be reached at on this machine; null for localhost only. */
  publicUrl?: string | null
  /** Gateway port on this machine (default: what the bundle had, else 8379). */
  port?: number
  now?: () => number
}

export interface ImportResult {
  manifest: BundleManifest
  /** Where a replaced data dir (with --force) and config were moved. */
  backups: string[]
  summary: BundleSummary
  sessionsCleared: number
  /** Passkeys were created for another domain and will not work here. */
  passkeysStranded: boolean
  previousOrigin: string | null
  newOrigin: string
}

export class BundleError extends Error {}

function parseHeader(file: string): { header: BundleHeader; headerBytes: Buffer; size: number } {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const buffer = Buffer.alloc(Math.min(MAX_HEADER_BYTES, size))
    readSync(fd, buffer, 0, buffer.length, 0)
    if (!buffer.subarray(0, BUNDLE_MAGIC.length).equals(Buffer.from(BUNDLE_MAGIC))) throw new BundleError('This is not an Antseed gateway bundle.')
    const end = buffer.indexOf(0x0a, BUNDLE_MAGIC.length)
    if (end < 0) throw new BundleError('The bundle header is damaged.')
    const headerBytes = buffer.subarray(0, end + 1)
    let header: BundleHeader
    try {
      header = JSON.parse(headerBytes.subarray(BUNDLE_MAGIC.length).toString('utf8')) as BundleHeader
    } catch {
      throw new BundleError('The bundle header is damaged.')
    }
    const validCost = Number.isInteger(header.N) && header.N >= 2 ** 14 && header.N <= 2 ** 20 && (header.N & (header.N - 1)) === 0
      && Number.isInteger(header.r) && header.r >= 1 && header.r <= 16 && Number.isInteger(header.p) && header.p >= 1 && header.p <= 4
    if (header.kdf !== 'scrypt' || header.cipher !== 'aes-256-gcm' || header.compression !== 'gzip' || !validCost) {
      throw new BundleError('This bundle uses settings this CLI does not support; update @antseed/cli.')
    }
    if (size < headerBytes.length + TAG_BYTES) throw new BundleError('The bundle is truncated.')
    return { header, headerBytes: Buffer.from(headerBytes), size }
  } finally {
    closeSync(fd)
  }
}

/** Decrypts into `target` (0600); throws BundleError on a wrong password or any tampering. */
async function decryptTo(file: string, password: string, target: string): Promise<void> {
  const { header, headerBytes, size } = parseHeader(file)
  const key = await scrypt(password, Buffer.from(header.salt, 'base64'), header)
  const tag = Buffer.alloc(TAG_BYTES)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES)
  } finally {
    closeSync(fd)
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
  decipher.setAAD(headerBytes)
  decipher.setAuthTag(tag)
  const out = createWriteStream(target, { flags: 'wx', mode: FILE_MODE })
  try {
    await pipeline(createReadStream(file, { start: headerBytes.length, end: size - TAG_BYTES - 1 }), decipher, createGunzip(), out)
  } catch {
    throw new BundleError('Could not open the bundle: the password is wrong, or the file was changed or damaged.')
  }
}

/** Splits the decrypted container into files under `root`, checking each one's hash. */
function unpackContainer(container: string, root: string): string[] {
  const fd = openSync(container, 'r')
  const paths: string[] = []
  try {
    let position = 0
    const read = (length: number): Buffer => {
      const buffer = Buffer.alloc(length)
      const got = readSync(fd, buffer, 0, length, position)
      if (got !== length) throw new BundleError('The bundle is truncated.')
      position += length
      return buffer
    }
    if (!read(CONTAINER_MAGIC.length).equals(CONTAINER_MAGIC)) throw new BundleError('The bundle contents are damaged.')
    const total = fstatSync(fd).size
    const chunk = Buffer.alloc(1024 * 1024)
    while (position < total) {
      const headerLength = read(4).readUInt32BE(0)
      if (headerLength > MAX_HEADER_BYTES) throw new BundleError('The bundle contents are damaged.')
      const entry = JSON.parse(read(headerLength).toString('utf8')) as { path?: unknown; size?: unknown; sha256?: unknown }
      if (typeof entry.path !== 'string' || !allowedBundlePath(entry.path) || paths.includes(entry.path)
        || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== 'string') {
        throw new BundleError(`The bundle holds an unexpected entry${typeof entry.path === 'string' ? ` (${entry.path})` : ''}; refusing to import it.`)
      }
      const target = join(root, ...entry.path.split('/'))
      if (!resolve(target).startsWith(resolve(root) + sep)) throw new BundleError('The bundle holds an unexpected entry; refusing to import it.')
      ensureDir(dirname(target))
      const out = openSync(target, 'wx', FILE_MODE)
      const hash = createHash('sha256')
      try {
        let left = entry.size
        while (left > 0) {
          const got = readSync(fd, chunk, 0, Math.min(chunk.length, left), position)
          if (got === 0) throw new BundleError('The bundle is truncated.')
          position += got
          left -= got
          hash.update(chunk.subarray(0, got))
          writeSync(out, chunk, 0, got)
        }
      } finally {
        closeSync(out)
      }
      if (hash.digest('hex') !== entry.sha256) throw new BundleError(`${entry.path} failed its integrity check.`)
      paths.push(entry.path)
    }
  } finally {
    closeSync(fd)
  }
  return paths
}

/** The data dir already holds a gateway or a wallet, which an import would replace. */
export function dataDirInUse(dataDir: string): string[] {
  const found = ['identity.key', 'identity.enc', join('gateway', 'gateway.db'), join('payments', 'sessions.db')]
    .filter((path) => existsSync(join(dataDir, path)))
  if (walkFiles(join(dataDir, 'buyer-identities')).length > 0) found.push('buyer-identities/')
  return found
}

function timestamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
}

function moveFile(from: string, to: string): void {
  ensureDir(dirname(to))
  try {
    renameSync(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyFileSync(from, to)
    rmSync(from, { force: true })
  }
  if (process.platform !== 'win32') chmodSync(to, FILE_MODE)
}

/** Ends every console session and drops every pending sign-in ticket; credentials stay. */
function invalidateSessions(store: GatewayStore): number {
  const db = store.database
  const exists = (table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
  let sessions = 0
  if (exists('auth_sessions')) sessions = db.prepare('DELETE FROM auth_sessions').run().changes
  for (const table of ['auth_enrollments', 'auth_challenges', 'auth_wallet_nonces', 'auth_oidc_states', 'auth_setup_tokens']) {
    if (exists(table)) db.prepare(`DELETE FROM ${table}`).run()
  }
  clearRecoveryTokens(db)
  return sessions
}

export async function importGatewayBundle(options: ImportOptions): Promise<ImportResult> {
  const now = options.now ?? Date.now
  const dataDir = resolve(options.dataDir)
  const configPath = resolve(options.configPath)
  if (!existsSync(options.bundleFile)) throw new Error(`No such file: ${options.bundleFile}`)
  const inUse = dataDirInUse(dataDir)
  if (inUse.length > 0 && !options.force) {
    throw new Error(`${dataDir} already holds a gateway or wallet (${inUse.join(', ')}). Importing would replace it: pass --force to move it aside first.`)
  }

  const staging = `${dataDir}.import-${randomBytes(6).toString('hex')}`
  ensureDir(staging)
  const backups: string[] = []
  try {
    const container = join(staging, 'bundle.bin')
    await decryptTo(options.bundleFile, options.password, container)
    const root = join(staging, 'files')
    ensureDir(root)
    const paths = unpackContainer(container, root)
    rmSync(container, { force: true })
    if (!paths.includes(MANIFEST) || !paths.includes(GATEWAY_DB)) throw new BundleError('The bundle is incomplete (no manifest or gateway database).')
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as BundleManifest
    if (manifest.format !== 'antseed-gateway-bundle' || manifest.version !== 1) throw new BundleError('Unsupported bundle version; update @antseed/cli.')

    const suffix = `backup-${timestamp(now())}`
    if (inUse.length > 0 && existsSync(dataDir)) {
      renameSync(dataDir, `${dataDir}.${suffix}`)
      backups.push(`${dataDir}.${suffix}`)
    }
    // A config of its own on this machine is kept beside the imported one.
    if (paths.includes(CONFIG) && existsSync(configPath)) {
      renameSync(configPath, `${configPath}.${suffix}`)
      backups.push(`${configPath}.${suffix}`)
    }
    ensureDir(dataDir)
    for (const path of paths) {
      if (path === MANIFEST) continue
      const from = join(root, ...path.split('/'))
      if (path === CONFIG) {
        moveFile(from, configPath)
        continue
      }
      const relative = path.slice('data/'.length).split('/')
      for (let depth = 1; depth < relative.length; depth += 1) ensureDir(join(dataDir, ...relative.slice(0, depth)))
      const target = join(dataDir, ...relative)
      // A database restored over stale WAL files would be read with them.
      if (target.endsWith('.db')) for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true })
      moveFile(from, target)
    }

    const store = new GatewayStore(dataDir, now)
    let sessionsCleared = 0
    let previousOrigin: string | null = null
    let newOrigin: string
    let passkeys = 0
    try {
      sessionsCleared = invalidateSessions(store)
      const saved = readConsoleLocation(store) ?? manifest.consoleLocation
      previousOrigin = saved ? (saved.publicUrl ?? `http://localhost:${saved.port}`) : null
      const location: ConsoleLocation = { publicUrl: options.publicUrl ?? null, port: options.port ?? saved?.port ?? 8379 }
      store.setSetting(CONSOLE_LOCATION_SETTING, location)
      newOrigin = location.publicUrl ?? `http://localhost:${location.port}`
      passkeys = countPasskeys(store)
      store.recordAudit({
        actor: { kind: 'cli', id: null },
        action: 'gateway.import',
        details: { bundleCreatedAt: manifest.createdAt, files: manifest.files.length, sessionsCleared, publicUrl: location.publicUrl },
      })
    } finally {
      store.close()
    }
    const summary = await summarizeDataDir(dataDir)
    const hostOf = (origin: string | null) => (origin ? new URL(origin).hostname : null)
    return {
      manifest,
      backups,
      summary,
      sessionsCleared,
      passkeysStranded: passkeys > 0 && hostOf(previousOrigin) !== hostOf(newOrigin),
      previousOrigin,
      newOrigin,
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function countPasskeys(store: GatewayStore): number {
  const db = store.database
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'").get()) return 0
  return (db.prepare("SELECT COUNT(*) AS n FROM auth_credentials WHERE kind = 'passkey'").get() as { n: number }).n
}

/**
 * Workspaces, keys, members and wallet addresses of a data dir; never a
 * secret. `identitySource` reads wallet keys from another dir (the live one
 * during export, whose `keyFrom` wallets resolve there).
 */
export async function summarizeDataDir(dataDir: string, options: { identitySource?: string } = {}): Promise<BundleSummary> {
  const identityDir = options.identitySource ?? dataDir
  const store = new GatewayStore(dataDir)
  try {
    const wallets: BundleSummary['wallets'] = []
    const addressOf = new Map<string, string | null>()
    const defaultAddress = await buyerIdentityAddress(identityDir, DEFAULT_BUYER_IDENTITY).catch(() => null)
    addressOf.set(DEFAULT_BUYER_IDENTITY, defaultAddress)
    wallets.push({ name: DEFAULT_BUYER_IDENTITY, address: defaultAddress, ...(defaultAddress ? {} : { note: 'created on first buyer start' }) })
    for (const identity of await listBuyerIdentities(identityDir)) {
      addressOf.set(identity.name, identity.address)
      const note = identity.keyFrom ? `key from ${identity.keyFrom}` : identity.error
      wallets.push({ name: identity.name, address: identity.address, ...(note ? { note } : {}) })
    }
    const workspaces = store.listWorkspaces().map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      wallet: workspace.buyerIdentity,
      address: addressOf.get(workspace.buyerIdentity) ?? null,
    }))
    const members = store.listMembers().map((member) => ({ label: member.label, email: member.email, orgRole: member.orgRole, status: member.status }))
    return { workspaces, activeKeys: store.countActiveKeys(), members, wallets, passkeys: countPasskeys(store) }
  } finally {
    store.close()
  }
}
