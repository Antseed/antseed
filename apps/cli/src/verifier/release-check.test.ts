import assert from 'node:assert/strict'
import test from 'node:test'
import { checkVerifierRelease, requireCurrentVerifier } from './release-check.js'

/** npm: the latest package.json of @antseed/cli answers `body`. */
function fakeNpm(body: unknown, status = 200, seen: string[] = []): typeof fetch {
  return (async (url: string | URL) => {
    seen.push(String(url))
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
}

const latest = (version: string, compat?: number) => ({ name: '@antseed/cli', version, ...(compat === undefined ? {} : { antseedVerifier: { compat } }) })

test('the latest release is read from npm\'s latest package.json of @antseed/cli', async () => {
  const seen: string[] = []
  await checkVerifierRelease({ localVersion: '0.1.216', localCompat: 1, registry: 'https://registry.npmjs.org', fetch: fakeNpm(latest('0.1.216', 1), 200, seen) })
  assert.deepEqual(seen, ['https://registry.npmjs.org/@antseed%2fcli/latest'])
})

test('only a higher verifier compat makes a CLI outdated; a newer release with the same compat is an update notice', async () => {
  const check = (localVersion: string, body: unknown) => checkVerifierRelease({ localVersion, localCompat: 2, fetch: fakeNpm(body) })
  assert.deepEqual(await check('0.1.215', latest('0.1.216', 3)), { status: 'outdated', latestVersion: '0.1.216', latestCompat: 3 })
  assert.deepEqual(await check('0.1.215', latest('0.1.216', 2)), { status: 'update-available', latestVersion: '0.1.216', latestCompat: 2 })
  assert.deepEqual(await check('0.1.216', latest('0.1.216', 2)), { status: 'current', latestVersion: '0.1.216', latestCompat: 2 })
  assert.equal((await check('0.1.217', latest('0.1.216', 2))).status, 'current')
  // A release from before verifier compat (compat 0) never blocks a CLI that has one.
  assert.equal((await check('0.1.231', latest('0.1.230'))).status, 'current')
})

test('an unreachable registry or an odd answer makes the check unavailable', async () => {
  const check = (fetch: typeof globalThis.fetch) => checkVerifierRelease({ localVersion: '0.1.216', localCompat: 1, fetch })
  assert.equal((await check(fakeNpm({}, 503))).status, 'unavailable')
  assert.equal((await check((async () => { throw new Error('offline') }) as typeof fetch)).status, 'unavailable')
  assert.equal((await check(fakeNpm({ version: 'soon' }))).status, 'unavailable')
  assert.equal((await check(fakeNpm({ version: '0.1.217', antseedVerifier: { compat: 'two' } }))).status, 'unavailable')
})

test('an outdated CLI cannot run or submit', async () => {
  const outdated = async () => ({ status: 'outdated' as const, latestVersion: '0.2.0', latestCompat: 9 })
  for (const command of ['run', 'submit'] as const) {
    await assert.rejects(
      requireCurrentVerifier({ command, currentVersion: '0.1.0', skip: false, strictWhenUnavailable: false, warn: () => undefined, check: outdated }),
      /the latest @antseed\/cli 0\.2\.0 changed how audits work \(verifier compat 9; .*Update with `antseed update`/,
    )
  }
})

test('a newer release that audits the same way only warns', async () => {
  const warnings: string[] = []
  const result = await requireCurrentVerifier({
    command: 'submit', currentVersion: '0.1.0', skip: false, strictWhenUnavailable: true,
    warn: (text) => { warnings.push(text) },
    check: async () => ({ status: 'update-available', latestVersion: '0.1.5', latestCompat: 1 }),
  })
  assert.equal(result?.status, 'update-available')
  assert.match(warnings[0]!, /@antseed\/cli 0\.1\.5 is available .* this submit continues/)
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
