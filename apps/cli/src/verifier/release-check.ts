import { compareVersions, isSemver } from '../update/version.js'

export const RELEASE_REPO = 'Antseed/antseed'

/** GitHub's latest release of the repo (any release: each tag carries the whole repo, CLI included). */
export function latestReleaseUrl(repo: string = RELEASE_REPO): string {
  return `https://api.github.com/repos/${repo}/releases/latest`
}

/** The CLI's package.json at a release tag; its `version` is the CLI version of that release. */
export function releasePackageUrl(tag: string, repo: string = RELEASE_REPO): string {
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(tag)}/apps/cli/package.json`
}

export type VerifierReleaseCheck =
  | { status: 'current'; latestVersion: string }
  | { status: 'outdated'; latestVersion: string }
  | { status: 'unavailable'; reason: string }

/**
 * Compares this CLI's version with the CLI version in `apps/cli/package.json` at the latest GitHub
 * release. Older is outdated; the same or newer is current.
 */
export async function checkVerifierRelease(options: {
  localVersion: string
  fetch?: typeof fetch
  timeoutMs?: number
}): Promise<VerifierReleaseCheck> {
  const doFetch = options.fetch ?? fetch
  const get = async (url: string): Promise<unknown> => {
    const response = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return response.json()
  }
  let tag: string
  let releaseVersion: unknown
  try {
    const latest = await get(latestReleaseUrl()) as { tag_name?: unknown }
    if (typeof latest.tag_name !== 'string' || !latest.tag_name) throw new Error('the latest release has no tag')
    tag = latest.tag_name
    releaseVersion = (await get(releasePackageUrl(tag)) as { version?: unknown }).version
  } catch (error) {
    return { status: 'unavailable', reason: `the latest GitHub release could not be read (${message(error)})` }
  }
  if (!isSemver(releaseVersion) || !isSemver(options.localVersion)) {
    return { status: 'unavailable', reason: `the CLI version of GitHub release ${tag} could not be compared` }
  }
  const latestVersion = `${releaseVersion} (GitHub release ${tag})`
  return compareVersions(options.localVersion, releaseVersion) < 0
    ? { status: 'outdated', latestVersion }
    : { status: 'current', latestVersion }
}

/**
 * Stops `verifier run` and `verifier submit` on a CLI older than the latest release's CLI, so every
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
      `this CLI (${input.currentVersion}) is older than the latest release ${result.latestVersion}. Update with \`antseed update\` (or \`npm i -g @antseed/cli@latest\`) `
      + `before running \`verifier ${input.command}\`, so every auditor audits the same models the same way.`,
    )
  }
  if (result.status === 'unavailable') {
    const text = `Could not check that this verifier is up to date: ${result.reason}.`
    if (input.strictWhenUnavailable) {
      throw new Error(`${text} Retry when GitHub can be reached, or pass --skip-version-check to submit anyway.`)
    }
    input.warn(`${text} Continuing; \`verifier submit\` checks again.`)
  }
  return result
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
