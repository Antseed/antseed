import { compareVersions, fetchLatestVersion, isSemver } from '../update/version.js'

export type VerifierReleaseCheck =
  | { status: 'current'; latestVersion: string }
  | { status: 'outdated'; latestVersion: string }
  | { status: 'unavailable'; reason: string }

/**
 * Compares this CLI's version with the latest `@antseed/cli` on npm, the version `antseed update`
 * installs. Older is outdated; the same or newer is current.
 */
export async function checkVerifierRelease(options: {
  localVersion: string
  fetch?: typeof fetch
  registry?: string
  timeoutMs?: number
}): Promise<VerifierReleaseCheck> {
  let latestVersion: string
  try {
    latestVersion = await fetchLatestVersion({ fetch: options.fetch, registry: options.registry, timeoutMs: options.timeoutMs })
  } catch (error) {
    return { status: 'unavailable', reason: `the latest @antseed/cli version could not be read from npm (${message(error)})` }
  }
  if (!isSemver(options.localVersion)) {
    return { status: 'unavailable', reason: `this CLI's version ${options.localVersion} could not be compared` }
  }
  return compareVersions(options.localVersion, latestVersion) < 0
    ? { status: 'outdated', latestVersion }
    : { status: 'current', latestVersion }
}

/**
 * Stops `verifier run` and `verifier submit` on a CLI older than the latest one on npm, so every
 * auditor audits the same models the same way. When the check can't be made,
 * `run` (and `submit --dry-run`) only warn, while a real submit stops; `--skip-version-check`
 * skips the check.
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
      `this CLI (${input.currentVersion}) is older than the latest @antseed/cli ${result.latestVersion}. Update with \`antseed update\` (or \`npm i -g @antseed/cli@latest\`) `
      + `before running \`verifier ${input.command}\`, so every auditor audits the same models the same way.`,
    )
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
