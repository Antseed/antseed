import { canonicalHashBytes32 } from '@antseed/fingerprints'
import { AUDITED_MODELS } from './audited-models.js'
import { compareVersions, isSemver } from '../update/version.js'

/**
 * Raise when a change makes this CLI audit differently: how answers are scored, what is sent to
 * sellers or the reference, the DIFF/recheck rules, or the round-robin assignment. A change to the
 * audited model list is picked up automatically through `auditedModelsHash`. After changing either,
 * run `pnpm --filter @antseed/cli verifier-manifest` to update `antseedVerifier` in package.json.
 */
export const AUDIT_RULES_VERSION = 2

/** What decides how this CLI audits; kept as `antseedVerifier` in the CLI's package.json. */
export interface VerifierManifest {
  auditRulesVersion: number
  /** Hash of the built-in audited models: names, OpenRouter ids and seller aliases. */
  auditedModelsHash: string
}

export function localVerifierManifest(): VerifierManifest {
  return {
    auditRulesVersion: AUDIT_RULES_VERSION,
    auditedModelsHash: canonicalHashBytes32({ domain: 'antseed-verifier-audited-models-v1', models: AUDITED_MODELS }),
  }
}

export const RELEASE_REPO = 'Antseed/antseed'

/** GitHub's latest release of the repo (any release: each tag carries the whole repo, CLI included). */
export function latestReleaseUrl(repo: string = RELEASE_REPO): string {
  return `https://api.github.com/repos/${repo}/releases/latest`
}

/** The CLI's package.json, which carries `antseedVerifier`, at a release tag. */
export function releasePackageUrl(tag: string, repo: string = RELEASE_REPO): string {
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(tag)}/apps/cli/package.json`
}

export type VerifierReleaseCheck =
  | { status: 'current'; latestVersion: string }
  | { status: 'outdated'; latestVersion: string; differences: string[] }
  | { status: 'unavailable'; reason: string }

/**
 * Compares this CLI's `antseedVerifier` with the one in `apps/cli/package.json` at the latest GitHub
 * release. Only that field is compared, so a release that changes nothing about audits never asks
 * verifiers to update. A CLI newer than the release's (published after it) is never outdated.
 */
export async function checkVerifierRelease(options: {
  fetch?: typeof fetch
  local?: VerifierManifest
  localVersion?: string
  timeoutMs?: number
} = {}): Promise<VerifierReleaseCheck> {
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
  let release: { version?: unknown; antseedVerifier?: unknown }
  try {
    const latest = await get(latestReleaseUrl()) as { tag_name?: unknown }
    if (typeof latest.tag_name !== 'string' || !latest.tag_name) throw new Error('the latest release has no tag')
    tag = latest.tag_name
    release = await get(releasePackageUrl(tag)) as typeof release
  } catch (error) {
    return { status: 'unavailable', reason: `the latest GitHub release could not be read (${message(error)})` }
  }
  const releaseVersion = typeof release.version === 'string' ? release.version : 'unknown'
  const latestVersion = `${releaseVersion} (GitHub release ${tag})`
  // A release from before this check has nothing to compare with, so it can't make this CLI outdated.
  if (release.antseedVerifier === undefined) return { status: 'current', latestVersion }
  if (!isManifest(release.antseedVerifier)) {
    return { status: 'unavailable', reason: `the verifier manifest in GitHub release ${tag} is not valid` }
  }
  if (options.localVersion && isSemver(releaseVersion) && compareVersions(options.localVersion, releaseVersion) > 0) {
    return { status: 'current', latestVersion }
  }
  const differences = manifestDifferences(options.local ?? localVerifierManifest(), release.antseedVerifier)
  return differences.length === 0
    ? { status: 'current', latestVersion }
    : { status: 'outdated', latestVersion, differences }
}

export function manifestDifferences(local: VerifierManifest, release: VerifierManifest): string[] {
  const differences: string[] = []
  if (local.auditedModelsHash.toLowerCase() !== release.auditedModelsHash.toLowerCase()) {
    differences.push('the list of audited models changed')
  }
  if (local.auditRulesVersion !== release.auditRulesVersion) {
    differences.push(`the audit rules changed (version ${local.auditRulesVersion} here, ${release.auditRulesVersion} in the release)`)
  }
  return differences
}

/**
 * Stops `verifier run` and `verifier submit` on a CLI that audits differently from the latest
 * release, so every auditor audits the same models the same way. When the check can't be made,
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
    input.warn('Skipping the verifier release check (--skip-version-check): this CLI may audit differently from other auditors.')
    return null
  }
  const result = await (input.check ?? (() => checkVerifierRelease({ localVersion: input.currentVersion })))()
  if (result.status === 'outdated') {
    throw new Error(
      `this CLI (${input.currentVersion}) audits differently from the latest release ${result.latestVersion}: `
      + `${result.differences.join('; ')}. Update with \`antseed update\` (or \`npm i -g @antseed/cli@latest\`) `
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

function isManifest(value: unknown): value is VerifierManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<VerifierManifest>
  return Number.isSafeInteger(manifest.auditRulesVersion)
    && typeof manifest.auditedModelsHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(manifest.auditedModelsHash)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
