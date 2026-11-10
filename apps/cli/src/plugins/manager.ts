import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { homedir } from 'node:os'

const execFileAsync = promisify(execFile)

/** Upper bound on a plugin install so an unreachable registry can't hang a caller forever. */
const INSTALL_TIMEOUT_MS = 120_000
/** Dedupe concurrent installs of the same package so first-requests can't race npm. */
const inflightInstalls = new Map<string, Promise<void>>()

export const PLUGINS_DIR = join(homedir(), '.antseed', 'plugins')

function resolvePluginsDir(): string {
  if (existsSync(PLUGINS_DIR)) return PLUGINS_DIR
  return PLUGINS_DIR
}

export function getPluginsDir(): string {
  return resolvePluginsDir()
}

export interface InstalledPlugin {
  name: string
  package: string
  version: string
}

async function ensurePluginsDir(): Promise<void> {
  const pluginsDir = resolvePluginsDir()
  const pluginsPackageJson = join(pluginsDir, 'package.json')
  await mkdir(pluginsDir, { recursive: true })
  try {
    await access(pluginsPackageJson, constants.R_OK)
  } catch {
    await writeFile(
      pluginsPackageJson,
      JSON.stringify({ name: 'antseed-plugins', version: '1.0.0', private: true, dependencies: {} }, null, 2),
      'utf-8'
    )
  }
}

/**
 * How to run npm. On Windows `npm` is `npm.cmd`, which Node won't start
 * without a shell: run the `npm-cli.js` that ships beside this Node instead,
 * or go through the shell when there isn't one.
 */
export function npmInvocation(
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  exists: (file: string) => boolean = existsSync,
): { file: string; leadingArgs: string[]; shell: boolean } {
  if (platform !== 'win32') return { file: 'npm', leadingArgs: [], shell: false }
  const cli = win32.join(win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return exists(cli) ? { file: execPath, leadingArgs: [cli], shell: false } : { file: 'npm', leadingArgs: [], shell: true }
}

function runNpm(args: string[], options: { cwd: string; timeout?: number }): Promise<unknown> {
  const npm = npmInvocation()
  // Through the shell every argument is quoted: paths and specs can hold spaces.
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`
  return npm.shell
    ? execFileAsync(npm.file, args.map(quote), { ...options, shell: true })
    : execFileAsync(npm.file, [...npm.leadingArgs, ...args], options)
}

export function normalizePluginInstallError(packageName: string, error: unknown): Error {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    return new Error(
      `Cannot install ${packageName}: npm was not found. Install Node.js 20 or newer (which includes npm), then retry.`,
    )
  }
  return error instanceof Error ? error : new Error(String(error))
}

export async function installPlugin(packageName: string): Promise<void> {
  const existing = inflightInstalls.get(packageName)
  if (existing) return existing
  const run = (async () => {
    await ensurePluginsDir()
    try {
      await runNpm(['install', '--ignore-scripts', packageName], {
        cwd: getPluginsDir(),
        timeout: INSTALL_TIMEOUT_MS,
      })
    } catch (error) {
      throw normalizePluginInstallError(packageName, error)
    }
  })()
  inflightInstalls.set(packageName, run)
  try {
    await run
  } finally {
    inflightInstalls.delete(packageName)
  }
}

export async function removePlugin(packageName: string): Promise<void> {
  await ensurePluginsDir()
  await runNpm(['uninstall', packageName], { cwd: getPluginsDir() })
}

export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  await ensurePluginsDir()
  try {
    const raw = await readFile(join(getPluginsDir(), 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
    const deps = pkg.dependencies ?? {}
    return Object.entries(deps).map(([pkgName, version]) => ({
      name: pkgName,
      package: pkgName,
      version: version,
    }))
  } catch {
    return []
  }
}
