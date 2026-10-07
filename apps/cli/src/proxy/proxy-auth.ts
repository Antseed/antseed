/**
 * Optional bearer-token auth for the buyer proxy (`antseed buyer start
 * --auth-token` / ANTSEED_PROXY_TOKEN), plus the local credential file that
 * lets the CLI's own daemon clients authenticate to a token-protected buyer.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PROXY_TOKEN_ENV = 'ANTSEED_PROXY_TOKEN'
export const DEFAULT_PROXY_HOST = '127.0.0.1'
export const MIN_PROXY_TOKEN_LENGTH = 16

/** Why `token` is unusable as a proxy token, or null when it is fine. */
export function validateProxyToken(token: string): string | null {
  if (token.length < MIN_PROXY_TOKEN_LENGTH) {
    return `The proxy auth token must be at least ${MIN_PROXY_TOKEN_LENGTH} characters.`
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    return 'The proxy auth token must be printable ASCII without spaces.'
  }
  return null
}

/** True when `host` only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
    || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

/**
 * Constant-time check of an `Authorization: Bearer <token>` header. Both
 * sides are hashed first so the comparison never leaks the token's length.
 */
export function bearerMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') return false
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header)
  const supplied = match?.[1] ?? ''
  const ok = timingSafeEqual(digest(supplied), digest(token))
  return ok && supplied.length > 0
}

export function proxyAuthFile(dataDir: string, port: number): string {
  return join(dataDir, `buyer-proxy-auth-${port}.json`)
}

/**
 * Write the running daemon's token to a 0600 file in its data dir, so local
 * clients (buyer subcommands, gateway, system proxy) authenticate without
 * being handed the token again. The data dir already holds the buyer's wallet
 * key, so anyone able to read this file could spend the wallet directly.
 */
export async function publishProxyToken(dataDir: string, port: number, token: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const file = proxyAuthFile(dataDir, port)
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ port, token }), { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/**
 * Remove the credential file. With `token`, only when the file still holds
 * that token, so a stopping daemon never deletes a newer daemon's file.
 */
export async function removeProxyToken(dataDir: string, port: number, token?: string): Promise<void> {
  const file = proxyAuthFile(dataDir, port)
  try {
    if (token !== undefined) {
      const current = JSON.parse(await readFile(file, 'utf8')) as { token?: unknown }
      if (current.token !== token) return
    }
    await unlink(file)
  } catch {}
}

/**
 * Token a local client should present to the buyer on `port`: the running
 * daemon's credential file first (authoritative for that daemon), then
 * ANTSEED_PROXY_TOKEN. Null when the buyer needs no token.
 */
export function readProxyToken(dataDir: string, port: number): string | null {
  try {
    const parsed = JSON.parse(readFileSync(proxyAuthFile(dataDir, port), 'utf8')) as { port?: unknown; token?: unknown }
    if (parsed.port === port && typeof parsed.token === 'string' && parsed.token.length > 0) return parsed.token
  } catch {}
  const fromEnv = process.env[PROXY_TOKEN_ENV]?.trim()
  return fromEnv ? fromEnv : null
}

/** `Authorization` header for local requests to the buyer on `port`; empty when none is needed. */
export function proxyAuthHeaders(dataDir: string, port: number): Record<string, string> {
  const token = readProxyToken(dataDir, port)
  return token ? { authorization: `Bearer ${token}` } : {}
}
