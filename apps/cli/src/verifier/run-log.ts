import { appendFileSync, createWriteStream, mkdirSync } from 'node:fs'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

/** Days of daily log files `verifier` commands keep. */
export const VERIFIER_LOG_RETENTION_DAYS = 14

const LOG_FILE_NAME = /^verifier-(\d{4}-\d{2}-\d{2})\.log$/
const MAX_LOGGED_LINE_LENGTH = 4_000
const MIN_SENSITIVE_VALUE_LENGTH = 8
const ANSI_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
/** The live progress boards rewrite themselves in place; the summary tables that follow keep their result. */
const IN_PLACE_REDRAW = /\x1b\[\d*A|\x1b\[2K/
const SENSITIVE_NAME = /key|secret|token|password|passphrase|jwt|mnemonic|credential|rpc/i
const NAMED_SECRET = /\b(api[_-]?key|authorization|password|passphrase|secret|private[_-]?key|access[_-]?token|auth[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi
const SECRET_FLAG = /(--(?:private-key|password|api-key|jwt)[ =])\S+/gi
const BEARER = /\bBearer\s+[^\s"',}]+/gi
const SK_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g
const URL_TEXT = /https?:\/\/[^\s"'<>)]+/g
const TOKEN_LIKE_PATH_SEGMENT = /^[A-Za-z0-9_-]{20,}$/
const SENSITIVE_QUERY_NAME = /key|token|secret|auth/i

export type LogRedactor = (text: string) => string

function redactUrl(text: string): string {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return text
  }
  const hasSecret = Boolean(url.username || url.password)
    || url.pathname.split('/').some((segment) => TOKEN_LIKE_PATH_SEGMENT.test(segment))
    || [...url.searchParams.keys()].some((name) => SENSITIVE_QUERY_NAME.test(name))
  return hasSecret ? `${url.protocol}//${url.host}/<redacted>` : text
}

/** The secret values to remove literally: from sensitive environment variables and config keys. */
export function sensitiveValues(env: NodeJS.ProcessEnv, config?: unknown): string[] {
  const values = new Set<string>()
  const add = (value: string) => {
    if (value.length < MIN_SENSITIVE_VALUE_LENGTH) return
    values.add(value)
    if (value.startsWith('0x')) values.add(value.slice(2))
  }
  for (const [name, value] of Object.entries(env)) {
    if (value && SENSITIVE_NAME.test(name)) add(value)
  }
  const visit = (value: unknown, sensitive: boolean, depth: number) => {
    if (depth > 12) return
    if (typeof value === 'string') {
      if (sensitive) add(value)
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, sensitive, depth + 1)
    } else if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) visit(item, sensitive || SENSITIVE_NAME.test(name), depth + 1)
    }
  }
  visit(config, false, 0)
  // Longest first, so a value that contains another is removed whole.
  return [...values].sort((left, right) => right.length - left.length)
}

export function createLogRedactor(values: readonly string[]): LogRedactor {
  return (text) => {
    let result = text
    for (const value of values) result = result.split(value).join('<redacted>')
    return result
      .replace(BEARER, 'Bearer <redacted>')
      .replace(SK_KEY, '<redacted>')
      .replace(JWT, '<redacted>')
      .replace(NAMED_SECRET, '$1$2<redacted>')
      .replace(SECRET_FLAG, '$1<redacted>')
      .replace(URL_TEXT, redactUrl)
  }
}

/** A copy of a config with sensitive values replaced, for a bundle's header. */
export function redactedConfig(config: unknown, redact: LogRedactor): unknown {
  const visit = (value: unknown, sensitive: boolean, depth: number): unknown => {
    if (depth > 12) return '<too deep>'
    if (typeof value === 'string') return sensitive ? '<redacted>' : redact(value)
    if (Array.isArray(value)) return value.map((item) => visit(item, sensitive, depth + 1))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => (
        [name, visit(item, sensitive || SENSITIVE_NAME.test(name), depth + 1)]
      )))
    }
    return sensitive && value !== undefined && value !== null ? '<redacted>' : value
  }
  return visit(config, false, 0)
}

function logFilePath(dir: string, now: Date): string {
  return join(dir, `verifier-${now.toISOString().slice(0, 10)}.log`)
}

async function removeExpiredLogs(dir: string, now: Date): Promise<void> {
  const oldest = new Date(now.getTime() - VERIFIER_LOG_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)
  for (const name of await readdir(dir)) {
    const date = LOG_FILE_NAME.exec(name)?.[1]
    if (date && date < oldest) await rm(join(dir, name), { force: true })
  }
}

export interface VerifierRunLogOptions {
  dir: string
  /** e.g. `run` or `watch`: labels every line, so a watch and its steps can share a file. */
  command: string
  argv: readonly string[]
  version: string
  redact: LogRedactor
  now?: () => Date
  pid?: number
  streams?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }
  /** Registers the closing line; tests leave it out. */
  onExit?: (close: (exitCode: number | undefined) => void) => void
}

export interface VerifierRunLog {
  path: () => string
  close: (exitCode: number | undefined) => void
}

/**
 * Copies this command's terminal output to today's log file, with a time on every line, secrets
 * removed and live progress redraws left out. A log must never fail a command, so the first write
 * error turns logging off.
 */
export function startVerifierRunLog(options: VerifierRunLogOptions): VerifierRunLog {
  const now = options.now ?? (() => new Date())
  const pid = options.pid ?? process.pid
  const startedAt = now()
  const streams = options.streams ?? { stdout: process.stdout, stderr: process.stderr }
  mkdirSync(options.dir, { recursive: true })
  void removeExpiredLogs(options.dir, startedAt).catch(() => undefined)

  let enabled = true
  const label = `[${pid} ${options.command}]`
  const append = (text: string, marker: string) => {
    if (!enabled) return
    try {
      const at = now()
      const lines = text.split('\n').map((line) => (
        `${at.toISOString()} ${label}${marker} ${options.redact(line).slice(0, MAX_LOGGED_LINE_LENGTH)}\n`
      ))
      appendFileSync(logFilePath(options.dir, at), lines.join(''), { mode: 0o600 })
    } catch {
      enabled = false
    }
  }

  const restore: Array<() => void> = []
  const flush: Array<() => void> = []
  const capture = (stream: NodeJS.WritableStream, marker: string) => {
    let partial = ''
    const original = stream.write
    const take = (chunk: unknown) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      if (IN_PLACE_REDRAW.test(text)) return
      partial += text.replace(ANSI_SEQUENCE, '').replace(/\r/g, '\n')
      const end = partial.lastIndexOf('\n')
      if (end < 0) return
      const complete = partial.slice(0, end)
      partial = partial.slice(end + 1)
      if (complete.trim()) append(complete, marker)
    }
    stream.write = function write(this: NodeJS.WritableStream, ...args: unknown[]) {
      if (enabled) {
        try {
          take(args[0])
        } catch {
          enabled = false
        }
      }
      return (original as (...params: unknown[]) => boolean).apply(this, args)
    } as NodeJS.WritableStream['write']
    restore.push(() => {
      stream.write = original
    })
    flush.push(() => {
      if (partial.trim()) append(partial, marker)
      partial = ''
    })
  }

  append(
    `started: antseed ${options.argv.join(' ')} (cli ${options.version}, node ${process.version}, ${process.platform} ${process.arch})`,
    '',
  )
  capture(streams.stdout, '')
  capture(streams.stderr, ' stderr')

  let closed = false
  const close = (exitCode: number | undefined) => {
    if (closed) return
    closed = true
    for (const finish of flush) finish()
    for (const undo of restore) undo()
    const seconds = Math.round((now().getTime() - startedAt.getTime()) / 1000)
    append(`finished: exit ${exitCode ?? 0} after ${seconds}s`, '')
  }
  options.onExit?.(close)
  return { path: () => logFilePath(options.dir, now()), close }
}

export interface VerifierLogFile {
  name: string
  path: string
  date: string
  bytes: number
}

/** Daily log files, newest first. */
export async function listVerifierLogs(dir: string): Promise<VerifierLogFile[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const files: VerifierLogFile[] = []
  for (const name of names) {
    const date = LOG_FILE_NAME.exec(name)?.[1]
    if (!date) continue
    const path = join(dir, name)
    files.push({ name, path, date, bytes: (await stat(path)).size })
  }
  return files.sort((left, right) => right.date.localeCompare(left.date))
}

/**
 * Writes the newest `days` daily logs to one gzip file, oldest first. Every line is redacted again
 * with the current secrets, so a secret set after a line was logged is still removed.
 */
export async function bundleVerifierLogs(input: {
  files: readonly VerifierLogFile[]
  days: number
  header: string
  redact: LogRedactor
  outPath: string
}): Promise<{ files: number }> {
  const selected = input.files.slice(0, input.days).reverse()
  async function* lines(): AsyncGenerator<string> {
    yield `${input.header}\n`
    for (const file of selected) {
      yield `\n===== ${file.name} =====\n`
      yield `${input.redact(await readFile(file.path, 'utf8'))}\n`
    }
  }
  await pipeline(Readable.from(lines()), createGzip(), createWriteStream(input.outPath, { mode: 0o600 }))
  return { files: selected.length }
}
