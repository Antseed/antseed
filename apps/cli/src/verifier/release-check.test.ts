import assert from 'node:assert/strict'
import test from 'node:test'
import { checkVerifierRelease, requireCurrentVerifier } from './release-check.js'

/** npm: the dist-tags of @antseed/cli answer `body`. */
function fakeNpm(body: unknown, status = 200, seen: string[] = []): typeof fetch {
  return (async (url: string | URL) => {
    seen.push(String(url))
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
}

test('the latest version is read from npm\'s dist-tags of @antseed/cli', async () => {
  const seen: string[] = []
  await checkVerifierRelease({ localVersion: '0.1.216', registry: 'https://registry.npmjs.org', fetch: fakeNpm({ latest: '0.1.216' }, 200, seen) })
  assert.deepEqual(seen, ['https://registry.npmjs.org/-/package/@antseed%2fcli/dist-tags'])
})

test('a CLI older than the latest on npm is outdated; the same or newer is current', async () => {
  const fetch = fakeNpm({ latest: '0.1.216' })
  assert.deepEqual(await checkVerifierRelease({ localVersion: '0.1.215', fetch }), { status: 'outdated', latestVersion: '0.1.216' })
  assert.deepEqual(await checkVerifierRelease({ localVersion: '0.1.216', fetch }), { status: 'current', latestVersion: '0.1.216' })
  assert.equal((await checkVerifierRelease({ localVersion: '0.1.217', fetch })).status, 'current')
  assert.equal((await checkVerifierRelease({ localVersion: '0.1.216-rc.1', fetch })).status, 'outdated')
})

test('an unreachable registry or an odd answer makes the check unavailable', async () => {
  assert.equal((await checkVerifierRelease({ localVersion: '0.1.216', fetch: fakeNpm({}, 503) })).status, 'unavailable')
  assert.equal((await checkVerifierRelease({ localVersion: '0.1.216', fetch: (async () => { throw new Error('offline') }) as typeof fetch })).status, 'unavailable')
  assert.equal((await checkVerifierRelease({ localVersion: '0.1.216', fetch: fakeNpm({ latest: 'soon' }) })).status, 'unavailable')
  assert.equal((await checkVerifierRelease({ localVersion: 'dev', fetch: fakeNpm({ latest: '0.1.216' }) })).status, 'unavailable')
})

test('an outdated CLI cannot run or start a verifier', async () => {
  const outdated = async () => ({ status: 'outdated' as const, latestVersion: '0.2.0' })
  for (const command of ['run', 'start'] as const) {
    await assert.rejects(
      requireCurrentVerifier({ command, currentVersion: '0.1.0', skip: false, strictWhenUnavailable: false, warn: () => undefined, check: outdated }),
      /this CLI \(0\.1\.0\) is older than the latest @antseed\/cli 0\.2\.0\. Update with `antseed update`/,
    )
  }
})

test('when the check cannot be made, it warns, or stops when strict', async () => {
  const unavailable = async () => ({ status: 'unavailable' as const, reason: 'offline' })
  const warnings: string[] = []
  const warn = (text: string) => { warnings.push(text) }
  await requireCurrentVerifier({ command: 'run', currentVersion: '0.1.0', skip: false, strictWhenUnavailable: false, warn, check: unavailable })
  assert.match(warnings[0]!, /Could not check that this verifier is up to date: offline/)
  await assert.rejects(
    requireCurrentVerifier({ command: 'start', currentVersion: '0.1.0', skip: false, strictWhenUnavailable: true, warn, check: unavailable }),
    /--skip-version-check/,
  )
})

test('--skip-version-check skips the check with a warning', async () => {
  const warnings: string[] = []
  const result = await requireCurrentVerifier({
    command: 'start', currentVersion: '0.1.0', skip: true, strictWhenUnavailable: true,
    warn: (text) => { warnings.push(text) },
    check: async () => { throw new Error('must not be called') },
  })
  assert.equal(result, null)
  assert.match(warnings[0]!, /Skipping the verifier version check/)
})
