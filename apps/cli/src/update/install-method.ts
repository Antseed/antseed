import { accessSync, constants, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { CLI_PACKAGE } from './version.js'

/**
 * How this copy of the CLI was installed, which decides how it updates:
 * `installer` is the gateway server installer (a root updater service does
 * it), the package managers update their global install, and the rest can
 * only be told what to do.
 */
export type InstallKind =
  | 'installer'
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'volta'
  | 'npx'
  | 'nix'
  | 'desktop'
  | 'local'
  | 'source'

export interface InstallMethod {
  kind: InstallKind
  /** The command that updates this install, as shown to people; null when there is none to run. */
  command: string | null
  /** The same command as argv, when `antseed update` can run it itself. */
  argv: string[] | null
  /** One line on how updates work for this install. */
  note: string
}

const LATEST = `${CLI_PACKAGE}@latest`

/** Where the running CLI lives, symlinks resolved (`npm i -g` links the bin into the prefix). */
export function cliScriptPath(argv1: string | undefined = process.argv[1]): string {
  if (!argv1) return ''
  try {
    return realpathSync(argv1)
  } catch {
    return argv1
  }
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The `node_modules` directory holding `@antseed/cli` in `path`, or null. */
function globalModulesDir(path: string): string | null {
  const marker = path.search(/[\\/]node_modules[\\/]@antseed[\\/]cli[\\/]/)
  return marker === -1 ? null : path.slice(0, marker + '/node_modules'.length)
}

export function detectInstallMethod(options: {
  scriptPath?: string
  env?: NodeJS.ProcessEnv
  electron?: boolean
  isWritable?: (path: string) => boolean
} = {}): InstallMethod {
  const env = options.env ?? process.env
  const path = (options.scriptPath ?? cliScriptPath()).replaceAll('\\', '/')
  const isWritable = options.isWritable ?? writable

  if (env['ANTSEED_UPDATER_REQUEST']?.trim()) {
    return { kind: 'installer', command: 'antseed update', argv: null, note: 'Installed by the gateway installer; its root update service installs new versions and restarts the services.' }
  }
  if (options.electron ?? (Boolean(process.versions['electron']) || env['ELECTRON_RUN_AS_NODE'] === '1')) {
    return { kind: 'desktop', command: null, argv: null, note: 'Bundled with the desktop app, which updates it.' }
  }
  if (path.includes('/_npx/')) {
    return { kind: 'npx', command: `npx ${LATEST}`, argv: null, note: 'Run through npx; ask for @latest to get the newest version.' }
  }
  if (path.startsWith('/nix/store/')) {
    return { kind: 'nix', command: 'nix profile upgrade antseed', argv: null, note: 'Installed with Nix; update the flake input (or your profile) to get a new version.' }
  }
  if (path.includes('/pnpm/global/') || path.includes('/.pnpm-global/')) {
    return { kind: 'pnpm', command: `pnpm add -g ${LATEST}`, argv: ['pnpm', 'add', '-g', LATEST], note: 'Installed globally with pnpm.' }
  }
  if (path.includes('/yarn/global/')) {
    return { kind: 'yarn', command: `yarn global add ${LATEST}`, argv: ['yarn', 'global', 'add', LATEST], note: 'Installed globally with Yarn.' }
  }
  if (path.includes('/.bun/install/global/')) {
    return { kind: 'bun', command: `bun add -g ${LATEST}`, argv: ['bun', 'add', '-g', LATEST], note: 'Installed globally with Bun.' }
  }
  if (path.includes('/.volta/tools/image/packages/')) {
    return { kind: 'volta', command: `volta install ${LATEST}`, argv: ['volta', 'install', LATEST], note: 'Installed with Volta.' }
  }
  const modules = globalModulesDir(path)
  if (modules) {
    // npm's global layout: <prefix>/lib/node_modules on Unix, <prefix>/node_modules on Windows.
    const global = /\/lib\/node_modules$/.test(modules) || /\/npm\/node_modules$/.test(modules)
    if (global) {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      if (isWritable(modules)) {
        return { kind: 'npm', command: `npm install -g ${LATEST}`, argv: [npm, 'install', '-g', LATEST], note: 'Installed globally with npm.' }
      }
      return { kind: 'npm', command: `sudo npm install -g ${LATEST}`, argv: null, note: `Installed globally with npm in ${dirname(modules)}, which needs root to change.` }
    }
    return { kind: 'local', command: `npm install ${LATEST}`, argv: null, note: `A project dependency in ${dirname(modules)}; update it in that project.` }
  }
  return { kind: 'source', command: 'git pull && pnpm install && pnpm run build', argv: null, note: 'Running from a source checkout.' }
}
