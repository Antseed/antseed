import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock } from '@antseed/node'
import { configFromObject, resolveConfigPath } from './loader.js'
import type { AntseedConfig } from './types.js'

/**
 * Seller settings saved from the dashboard when the config file cannot be
 * written (a Kubernetes ConfigMap, a Nix store path). They live in the data
 * directory as a JSON merge patch (RFC 7396) over the config file: only the
 * fields changed there, `null` for one removed. Every other field still comes
 * from the config file, so its later edits keep applying.
 */
type JsonObject = Record<string, unknown>

export const CONFIG_OVERRIDES_FILE = 'config.overrides.json'

export function configOverridesPath(dataDir: string): string {
  return join(dataDir, CONFIG_OVERRIDES_FILE)
}

const isObject = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)

/** RFC 7396: the patch's objects merge in, `null` removes, anything else replaces. Returns a new object. */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return structuredClone(patch)
  const out: JsonObject = isObject(target) ? structuredClone(target) : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else out[key] = applyMergePatch(out[key], value)
  }
  return out
}

/** The smallest merge patch that turns `before` into `after` (null when they are equal). */
export function mergePatchBetween(before: unknown, after: unknown): unknown {
  if (!isObject(before) || !isObject(after)) return JSON.stringify(before) === JSON.stringify(after) ? undefined : structuredClone(after)
  const patch: JsonObject = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(key in after)) patch[key] = null
    else {
      const child = mergePatchBetween(before[key], after[key])
      if (child !== undefined) patch[key] = child
    }
  }
  return Object.keys(patch).length > 0 ? patch : undefined
}

/** The overrides saved in this data dir, or null; a file that does not parse is reported, never applied. */
export function readConfigOverridesSync(dataDir: string): JsonObject | null {
  let text: string
  try {
    text = readFileSync(configOverridesPath(dataDir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const parsed = JSON.parse(text) as unknown
  if (!isObject(parsed)) throw new Error(`${configOverridesPath(dataDir)} is not a JSON object`)
  return parsed
}

/** Count of the leaf settings an overrides patch changes, for "N settings saved from the dashboard". */
export function overriddenSettings(patch: JsonObject | null): string[] {
  const out: string[] = []
  const walk = (value: unknown, path: string) => {
    if (isObject(value) && Object.keys(value).length > 0) for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key)
    else out.push(path)
  }
  if (patch) walk(patch, '')
  return out
}

/**
 * Edits the overrides under a lock: `edit` gets the raw config with the
 * overrides applied and changes it in place; what differs from the config
 * file is saved (the file is removed when nothing does).
 */
export async function patchConfigOverrides(dataDir: string, base: JsonObject, edit: (raw: JsonObject) => void): Promise<void> {
  const path = configOverridesPath(dataDir)
  await mkdir(dataDir, { recursive: true })
  await withFileLock(path, async () => {
    const current = readConfigOverridesSync(dataDir)
    const raw = applyMergePatch(base, current ?? {}) as JsonObject
    edit(raw)
    const next = mergePatchBetween(base, raw)
    if (next === undefined) {
      await rm(path, { force: true })
      return
    }
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      await chmod(temp, 0o600)
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  })
}

export async function removeConfigOverrides(dataDir: string): Promise<void> {
  const path = configOverridesPath(dataDir)
  await withFileLock(path, () => rm(path, { force: true }))
}

/** `loadConfig` for a seller: the config file with this data dir's dashboard overrides applied. */
export async function loadSellerConfig(configPath: string, dataDir: string): Promise<{ config: AntseedConfig; overridden: string[] }> {
  const resolved = resolveConfigPath(configPath)
  let raw: unknown = {}
  try {
    raw = JSON.parse(await readFile(resolved, 'utf-8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const overrides = readConfigOverridesSync(dataDir)
  return { config: configFromObject(overrides ? applyMergePatch(raw, overrides) : raw), overridden: overriddenSettings(overrides) }
}
