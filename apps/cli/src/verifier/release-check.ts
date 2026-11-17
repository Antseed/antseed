import { CLI_PACKAGE, compareVersions, isSemver, registryUrl } from '../update/version.js'
import { VERIFIER_COMPAT, readCompat } from './verifier-compat.js'

export type VerifierReleaseCheck =
  | { status: 'current'; latestVersion: string; latestCompat: number }
  /** A newer release audits the same way: an update notice, nothing more. */
  | { status: 'update-available'; latestVersion: string; latestCompat: number }
  /** The latest release audits differently (a higher `antseedVerifier.compat`). */
  | { status: 'outdated'; latestVersion: string; latestCompat: number }
  | { status: 'unavailable'; reason: string }

/** The published package.json of `@antseed/cli@latest`, the version `antseed update` installs (a few KB). */
export function latestManifestUrl(registry: string): string {
  return `${registry}/${CLI_PACKAGE.replace('/', '%2f')}/latest`
}

/**
 * Compares this CLI's verifier compatibility (`antseedVerifier.compat`) with the latest
 * `@antseed/cli` on npm. A lower compat is outdated: that release changed how auditors split
 * models or judge sellers. A newer release with the same compat is only an available update.
 */
export async function checkVerifierRelease(options: {
  localVersion: string
  localCompat?: number
  fetch?: typeof fetch
  registry?: string
  timeoutMs?: number
}): Promise<VerifierReleaseCheck> {
  const localCompat = options.localCompat ?? VERIFIER_COMPAT
  let latestVersion: string
  let latestCompat: number
  try {
    const response = await (options.fetch ?? fetch)(latestManifestUrl(options.registry ?? registryUrl()), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    })
    if (!response.ok) throw new Error(`npm registry answered ${response.status}`)
    const manifest = await response.json() as { version?: unknown }
    if (!isSemver(manifest.version)) throw new Error('npm registry returned no valid latest version')
    latestVersion = manifest.version
    latestCompat = readCompat(manifest)
  } catch (error) {
    return { status: 'unavailable', reason: `the latest @antseed/cli could not be read from npm (${message(error)})` }
  }
  if (latestCompat > localCompat) return { status: 'outdated', latestVersion, latestCompat }
  const newer = isSemver(options.localVersion) && compareVersions(options.localVersion, latestVersion) < 0
  return { status: newer ? 'update-available' : 'current', latestVersion, latestCompat }
}

/**
 * Stops `verifier run` and `verifier submit` when the latest CLI on npm audits differently from this
 * one (a higher verifier compat), so every auditor splits the models and judges sellers the same way
 * in an epoch. Any other newer release only prints a notice. When the check can't be made, `run`
 * (and `submit --dry-run`) only warn, while a real submit stops; `--skip-version-check` skips it.
 */
export async function requireCurrentVerifier(input: {
  command: 'run' | 'submit'
  currentVersion: string
  skip: boolean
  strictWhenUnavailable: boolean
  warn: (message: string) => void
  check?: () => Promise<VerifierReleaseCheck>
}): Promise<VerifierReleaseCheck | null> {
  if (input.skip) {
    input.warn('Skipping the verifier version check (--skip-version-check): this CLI may audit differently from other auditors.')
    return null
  }
  const result = await (input.check ?? (() => checkVerifierRelease({ localVersion: input.currentVersion })))()
  if (result.status === 'outdated') {
    throw new Error(
      `the latest @antseed/cli ${result.latestVersion} changed how audits work (verifier compat ${result.latestCompat}; this CLI ${input.currentVersion} has ${VERIFIER_COMPAT}). `
      + `Update with \`antseed update\` (or \`npm i -g @antseed/cli@latest\`) before running \`verifier ${input.command}\`, so every auditor audits the same models the same way.`,
    )
  }
  if (result.status === 'update-available') {
    input.warn(`@antseed/cli ${result.latestVersion} is available (this CLI is ${input.currentVersion}). It audits the same way, so this ${input.command} continues; update with \`antseed update\` when convenient.`)
  }
  if (result.status === 'unavailable') {
    const text = `Could not check that this verifier is up to date: ${result.reason}.`
    if (input.strictWhenUnavailable) {
      throw new Error(`${text} Retry when the npm registry can be reached, or pass --skip-version-check to submit anyway.`)
    }
    input.warn(`${text} Continuing; \`verifier submit\` checks again.`)
  }
  return result
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
