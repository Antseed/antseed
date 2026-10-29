import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkVerifierRelease,
  latestReleaseUrl,
  releasePackageUrl,
  requireCurrentVerifier,
} from './release-check.js'

/** GitHub: the latest release is `v0.2.70`, whose apps/cli/package.json is `body`. */
function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async (url: string | URL) => String(url).startsWith('https://api.github.com/')
    ? new Response(JSON.stringify({ tag_name: 'v0.2.70' }))
    : new Response(JSON.stringify(body), { status })) as typeof fetch
}

test('the CLI package.json is read at the latest GitHub release', () => {
  assert.equal(latestReleaseUrl(), 'https://api.github.com/repos/Antseed/antseed/releases/latest')
  assert.equal(releasePackageUrl('v0.2.70'), 'https://raw.githubusercontent.com/Antseed/antseed/v0.2.70/apps/cli/package.json')
})

test('a CLI older than the latest release\'s CLI is outdated; the same or newer is current', async () => {
  const fetch = fakeFetch({ version: '0.1.208' })
  assert.deepEqual(await checkVerifierRelease({ localVersion: '0.1.207', fetch }), { status: 'outdated', latestVersion: '0.1.208 (GitHub release v0.2.70)' })
  assert.deepEqual(await checkVerifierRelease({ localVersion: '0.1.208', fetch }), { status: 'current', latestVersion: '0.1.208 (GitHub release v0.2.70)' })
  assert.equal((await checkVerifierRelease({ localVersion: '0.1.212', fetch })).status, 'current')
})

test('an unreachable GitHub or an unreadable version makes the check unavailable', async () => {
  assert.equal((await checkVerifierRelease({ localVersion: '0.1.208', fetch: fakeFetch({}, 503) })).status, 'unavailable')
  assert.equal((await checkVerifierRelease({ localVersion: '0.1.208', fetch: (async () => { throw new Error('offline') }) as typeof fetch })).status, 'unavailable')
  const invalid = await checkVerifierRelease({ localVersion: '0.1.208', fetch: fakeFetch({ name: '@antseed/cli' }) })
  assert.deepEqual(invalid, { status: 'unavailable', reason: 'the CLI version of GitHub release v0.2.70 could not be compared' })
})

test('an outdated CLI cannot run or submit', async () => {
  const outdated = async () => ({ status: 'outdated' as const, latestVersion: '0.2.0 (GitHub release v0.2.70)' })
  for (const command of ['run', 'submit'] as const) {
    await assert.rejects(
      requireCurrentVerifier({ command, currentVersion: '0.1.0', skip: false, strictWhenUnavailable: false, warn: () => undefined, check: outdated }),
      /this CLI \(0\.1\.0\) is older than the latest release 0\.2\.0 \(GitHub release v0\.2\.70\)\. Update with `antseed update`/,
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
  assert.match(warnings[0]!, /Skipping the verifier version check/)
})
