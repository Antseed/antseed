import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The package `antseed update` installs. */
export const CLI_PACKAGE = '@antseed/cli'

/** How long a registry answer stays fresh: one check a day, like npm's own notifier. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && SEMVER.test(value)
}

/** Semver precedence: negative when `a` is older than `b`. Unparseable versions compare equal. */
export function compareVersions(a: string, b: string): number {
  const left = SEMVER.exec(a)
  const right = SEMVER.exec(b)
  if (!left || !right) return 0
  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(left[index]) - Number(right[index])
    if (diff !== 0) return Math.sign(diff)
  }
  const pa = left[4]
  const pb = right[4]
  if (pa === pb) return 0
  if (pa === undefined) return 1
  if (pb === undefined) return -1
  const ids = pa.split('.')
  const others = pb.split('.')
  for (let index = 0; index < Math.max(ids.length, others.length); index += 1) {
    const x = ids[index]
    const y = others[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny && Number(x) !== Number(y)) return Math.sign(Number(x) - Number(y))
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function isNewer(latest: string | null | undefined, current: string): boolean {
  return Boolean(latest) && compareVersions(latest!, current) > 0
}

/** The npm registry to ask: `ANTSEED_NPM_REGISTRY`, then npm's own `npm_config_registry`, then npmjs.org. */
export function registryUrl(env: NodeJS.ProcessEnv = process.env): string {
  for (const candidate of [env['ANTSEED_NPM_REGISTRY'], env['npm_config_registry']]) {
    const value = candidate?.trim()
    if (value && /^https?:\/\//i.test(value)) return value.replace(/\/+$/, '')
  }
  return DEFAULT_REGISTRY
}

/** The dist-tags document of the CLI package: a few bytes, unlike the full packument. */
export function distTagsUrl(registry: string): string {
  return `${registry}/-/package/${CLI_PACKAGE.replace('/', '%2f')}/dist-tags`
}

/** The version the registry tags `latest`. Throws on network errors, timeouts and odd answers. */
export async function fetchLatestVersion(options: {
  registry?: string
  timeoutMs?: number
  fetch?: typeof fetch
} = {}): Promise<string> {
  const doFetch = options.fetch ?? fetch
  const response = await doFetch(distTagsUrl(options.registry ?? registryUrl()), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  })
  if (!response.ok) throw new Error(`npm registry answered ${response.status}`)
  const tags = await response.json() as { latest?: unknown }
  if (!isSemver(tags.latest)) throw new Error('npm registry returned no valid latest version')
  return tags.latest
}

/** The last registry answer, kept in the data dir so most runs never touch the network. */
export interface UpdateCache {
  checkedAt: number
  latest: string
}

export function updateCachePath(dataDir: string): string {
  return join(dataDir, 'update-check.json')
}

export function readUpdateCache(dataDir: string): UpdateCache | null {
  try {
    const parsed = JSON.parse(readFileSync(updateCachePath(dataDir), 'utf8')) as Partial<UpdateCache>
    if (typeof parsed.checkedAt !== 'number' || !isSemver(parsed.latest)) return null
    return { checkedAt: parsed.checkedAt, latest: parsed.latest }
  } catch {
    return null
  }
}

export function writeUpdateCache(dataDir: string, cache: UpdateCache): void {
  const path = updateCachePath(dataDir)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(cache))
  renameSync(tmp, path)
}

/** `NO_UPDATE_NOTIFIER` (the convention npm and update-notifier share), `ANTSEED_NO_UPDATE_CHECK`, or CI. */
export function updateChecksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const on = (name: string) => {
    const value = env[name]?.trim().toLowerCase()
    return Boolean(value) && value !== '0' && value !== 'false'
  }
  return on('NO_UPDATE_NOTIFIER') || on('ANTSEED_NO_UPDATE_CHECK') || on('CI')
}
