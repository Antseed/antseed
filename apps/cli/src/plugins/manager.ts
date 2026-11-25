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
 * How to run npm: the program and the arguments that come before npm's own.
 * On Windows `npm` is `npm.cmd`, which Node only starts through `cmd.exe`, and
 * the shell would rewrite a package spec (`%VAR%` expands even inside quotes).
 * So npm's own `npm-cli.js` runs on this Node instead: the one beside this
 * Node, beside an `npm.cmd` on PATH, or the user-wide one in %APPDATA%. With
 * none of those, setup stops and says how to fix it.
 */
export function npmInvocation(
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  exists: (file: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; leadingArgs: string[] } {
  if (platform !== 'win32') return { file: 'npm', leadingArgs: [] }
  const cliIn = (dir: string) => win32.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const pathDirs = (env['Path'] ?? env['PATH'] ?? '').split(';').map((dir) => dir.trim()).filter(Boolean)
  const candidates = [
    cliIn(win32.dirname(execPath)),
    ...pathDirs.filter((dir) => exists(win32.join(dir, 'npm.cmd'))).map(cliIn),
    ...(env['APPDATA'] ? [cliIn(win32.join(env['APPDATA'], 'npm'))] : []),
  ]
  const cli = candidates.find((candidate) => exists(candidate))
  if (!cli) {
    throw Object.assign(new Error('npm was not found: no npm-cli.js beside Node, beside npm.cmd on PATH, or in %APPDATA%\\npm. Install Node.js 20 or newer (which includes npm), then retry.'), { code: 'ENOENT' })
  }
  return { file: execPath, leadingArgs: [cli] }
}

/** The program and full argument list for an npm run: npm's arguments go through untouched. */
export function npmCommand(args: readonly string[], npm = npmInvocation()): { file: string; args: string[] } {
  return { file: npm.file, args: [...npm.leadingArgs, ...args] }
}

function runNpm(args: string[], options: { cwd: string; timeout?: number }): Promise<unknown> {
  const command = npmCommand(args)
  return execFileAsync(command.file, command.args, options)
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
