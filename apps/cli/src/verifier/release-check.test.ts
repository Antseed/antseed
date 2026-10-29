import assert from 'node:assert/strict'
import test from 'node:test'
import pkg from '../../package.json' with { type: 'json' }
import {
  checkVerifierRelease,
  latestReleaseUrl,
  releasePackageUrl,
  localVerifierManifest,
  requireCurrentVerifier,
  type VerifierManifest,
} from './release-check.js'

const local: VerifierManifest = { auditRulesVersion: 3, auditedModelsHash: `0x${'a'.repeat(64)}` }

/** GitHub: the latest release is `v0.2.70`, whose apps/cli/package.json is `body`. */
function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async (url: string | URL) => String(url).startsWith('https://api.github.com/')
    ? new Response(JSON.stringify({ tag_name: 'v0.2.70' }))
    : new Response(JSON.stringify(body), { status })) as typeof fetch
}

test('package.json antseedVerifier matches this CLI (run `pnpm --filter @antseed/cli verifier-manifest`)', () => {
  assert.deepEqual(pkg.antseedVerifier, localVerifierManifest())
})

test('the CLI package.json is read at the latest GitHub release', () => {
  assert.equal(latestReleaseUrl(), 'https://api.github.com/repos/Antseed/antseed/releases/latest')
  assert.equal(releasePackageUrl('v0.2.70'), 'https://raw.githubusercontent.com/Antseed/antseed/v0.2.70/apps/cli/package.json')
})

test('a release with the same manifest is current, whatever else it changed', async () => {
  const result = await checkVerifierRelease({ local, fetch: fakeFetch({ version: '9.9.9', antseedVerifier: local }) })
  assert.deepEqual(result, { status: 'current', latestVersion: '9.9.9 (GitHub release v0.2.70)' })
})

test('a changed model list or audit rules version makes this CLI outdated', async () => {
  const release = { auditRulesVersion: 4, auditedModelsHash: `0x${'b'.repeat(64)}` }
  const result = await checkVerifierRelease({ local, fetch: fakeFetch({ version: '9.9.9', antseedVerifier: release }) })
  assert.equal(result.status, 'outdated')
  assert.deepEqual(result.status === 'outdated' && result.differences, [
    'the list of audited models changed',
    'the audit rules changed (version 3 here, 4 in the release)',
  ])
})

test('a release from before the check passes', async () => {
  const result = await checkVerifierRelease({ local, fetch: fakeFetch({ version: '0.1.208' }) })
  assert.deepEqual(result, { status: 'current', latestVersion: '0.1.208 (GitHub release v0.2.70)' })
})

test('a CLI newer than the release\'s is never outdated', async () => {
  const release = { auditRulesVersion: 4, auditedModelsHash: `0x${'b'.repeat(64)}` }
  const fetch = fakeFetch({ version: '0.1.208', antseedVerifier: release })
  assert.equal((await checkVerifierRelease({ local, localVersion: '0.1.212', fetch })).status, 'current')
  assert.equal((await checkVerifierRelease({ local, localVersion: '0.1.207', fetch })).status, 'outdated')
})

test('an unreachable GitHub or an invalid manifest makes the check unavailable', async () => {
  assert.equal((await checkVerifierRelease({ local, fetch: fakeFetch({}, 503) })).status, 'unavailable')
  assert.equal((await checkVerifierRelease({ local, fetch: (async () => { throw new Error('offline') }) as typeof fetch })).status, 'unavailable')
  const invalid = await checkVerifierRelease({ local, fetch: fakeFetch({ version: '0.1.211', antseedVerifier: { auditRulesVersion: 1 } }) })
  assert.deepEqual(invalid, { status: 'unavailable', reason: 'the verifier manifest in GitHub release v0.2.70 is not valid' })
})

test('an outdated CLI cannot run or submit', async () => {
  const outdated = async () => ({ status: 'outdated' as const, latestVersion: '0.2.0', differences: ['the list of audited models changed'] })
  for (const command of ['run', 'submit'] as const) {
    await assert.rejects(
      requireCurrentVerifier({ command, currentVersion: '0.1.0', skip: false, strictWhenUnavailable: false, warn: () => undefined, check: outdated }),
      /this CLI \(0\.1\.0\) audits differently from the latest release 0\.2\.0: the list of audited models changed\. Update with `antseed update`/,
    )
  }
})

test('when the check cannot be made, run warns and a real submit stops', async () => {
  const unavailable = async () => ({ status: 'unavailable' as const, reason: 'offline' })
  const warnings: string[] = []
  const warn = (text: string) => { warnings.push(text) }
  await requireCurrentVerifier({ command: 'run', currentVersion: '0.1.0', skip: false, strictWhenUnavailable: false, warn, check: unavailable })
  assert.match(warnings[0]!, /Could not check that this verifier is up to date: offline/)
  await assert.rejects(
    requireCurrentVerifier({ command: 'submit', currentVersion: '0.1.0', skip: false, strictWhenUnavailable: true, warn, check: unavailable }),
    /--skip-version-check/,
  )
})

test('--skip-version-check skips the check with a warning', async () => {
  const warnings: string[] = []
  const result = await requireCurrentVerifier({
    command: 'submit', currentVersion: '0.1.0', skip: true, strictWhenUnavailable: true,
    warn: (text) => { warnings.push(text) },
    check: async () => { throw new Error('must not be called') },
  })
  assert.equal(result, null)
  assert.match(warnings[0]!, /Skipping the verifier release check/)
})
