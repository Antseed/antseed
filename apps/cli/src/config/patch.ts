import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ConsoleError } from '../gateway/console-api/router.js'
import { configFromObject, resolveConfigPath } from './loader.js'

/**
 * The one way Antseed edits a config file in place: the gateway console's
 * buyer settings, the seller dashboard and `antseed seller settings`, and
 * `antseed config set`. Only the fields a caller changes are touched, so
 * everything else (defaults left implicit included) stays as written.
 */
type JsonObject = Record<string, unknown>

/** Config edits in flight, per file: each waits for the previous one so concurrent PATCHes never lose an update. */
const configLocks = new Map<string, Promise<void>>()

async function withConfigLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = configLocks.get(path) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(() => undefined, () => undefined)
  configLocks.set(path, settled)
  try {
    return await run
  } finally {
    if (configLocks.get(path) === settled) configLocks.delete(path)
  }
}

/** The file a (possibly symlinked) config path points at, so the edit replaces the target rather than the link. */
async function configTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path
    throw error
  }
}

/**
 * Edits the config file in place: reads the raw JSON, lets `mutate` touch
 * only the fields it changes (so everything else, defaults left implicit
 * included, stays as the operator wrote it), and replaces the file
 * atomically with the same mode. A file that does not parse is never
 * overwritten; a missing one is created with just the changed fields.
 * Edits are serialized in-process, and a symlinked config is written
 * through to its target.
 */
export async function patchConfigFile(configPath: string, mutate: (config: JsonObject) => void, options: { backup?: boolean } = {}): Promise<void> {
  const target = await configTarget(resolveConfigPath(configPath))
  await withConfigLock(target, () => patchConfigTarget(target, mutate, options.backup === true))
}

async function patchConfigTarget(path: string, mutate: (config: JsonObject) => void, backup: boolean): Promise<void> {
  let raw: string | null = null
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let config: JsonObject = {}
  if (raw !== null && raw.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new ConsoleError(409, 'config_unreadable', `The config file ${path} is not valid JSON; fix it before changing settings here`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConsoleError(409, 'config_unreadable', `The config file ${path} is not a JSON object`)
    }
    config = parsed as JsonObject
  }
  mutate(config)
  const mode = raw === null ? 0o600 : (await stat(path)).mode & 0o777
  if (raw === null) await mkdir(dirname(path), { recursive: true })
  // The backup is the exact file this edit replaces, written only once the edit is accepted.
  // Both are replaced through a fresh file, so each always gets the config's current mode.
  if (backup && raw !== null) await replaceFile(`${path}.bak`, raw, mode)
  await replaceFile(path, `${JSON.stringify(config, null, 2)}\n`, mode)
}

async function replaceFile(path: string, contents: string, mode: number): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, contents, { mode })
    await chmod(temp, mode)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}


/** The directory itself, or the closest ancestor that exists (a missing config directory is created on save). */
async function nearestDirectory(dir: string): Promise<string> {
  for (let current = dir; ; current = dirname(current)) {
    try {
      await stat(current)
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw error
    }
  }
}

/** Saving needs the file and its directory writable (atomic replace); a ConfigMap mount is neither. */
export async function configWritable(configPath: string): Promise<{ writable: boolean; reason: string | null }> {
  const path = await configTarget(resolveConfigPath(configPath))
  const readOnly = { writable: false, reason: `${configPath} is read-only here (for example mounted from a Kubernetes ConfigMap). Change it where it is managed, then restart.` }
  try {
    await access(await nearestDirectory(dirname(path)), constants.W_OK)
  } catch {
    return readOnly
  }
  try {
    await access(path, constants.W_OK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return readOnly
  }
  return { writable: true, reason: null }
}

/**
 * `patchConfigFile` for edits a person makes: refused (409 `config_read_only`)
 * when the file cannot be written, the previous file kept as `config.json.bak`,
 * and the result validated exactly as the node loads it (400 with the reason).
 * A file that is already invalid is refused (409 `config_invalid`).
 */
export async function patchValidatedConfig(configPath: string, mutate: (raw: JsonObject) => void): Promise<void> {
  const access = await configWritable(configPath)
  if (!access.writable) throw new ConsoleError(409, 'config_read_only', access.reason!)
  await patchConfigFile(configPath, (raw) => {
    try {
      configFromObject(structuredClone(raw))
    } catch (error) {
      throw new ConsoleError(409, 'config_invalid', `The config file is not valid (${(error as Error).message}); fix it before changing settings here`)
    }
    mutate(raw)
    try {
      configFromObject(structuredClone(raw))
    } catch (error) {
      throw new ConsoleError(400, 'invalid_request', (error as Error).message.replace(/^Invalid config:\s*(- )?/i, '').replace(/\n- /g, '; '))
    }
  }, { backup: true })
}
