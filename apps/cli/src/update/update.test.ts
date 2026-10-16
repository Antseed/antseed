import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { detectInstallMethod } from './install-method.js'
import { notifyIfUpdateAvailable } from './notifier.js'
import { readRootUpdateProgress, requestRootUpdate, rootUpdaterPaths, updateInFlight } from './root-updater.js'
import {
  compareVersions,
  distTagsUrl,
  fetchLatestVersion,
  isNewer,
  readUpdateCache,
  registryUrl,
  updateChecksDisabled,
  writeUpdateCache,
} from './version.js'

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-update-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('compareVersions follows semver precedence', () => {
  assert.equal(compareVersions('0.1.193', '0.1.180'), 1)
  assert.equal(compareVersions('0.1.180', '0.1.193'), -1)
  assert.equal(compareVersions('0.2.0', '0.1.999'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.2'), 1)
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(compareVersions('not-a-version', '1.0.0'), 0)
  assert.equal(isNewer('0.1.193', '0.1.180'), true)
  assert.equal(isNewer('0.1.180', '0.1.180'), false)
  assert.equal(isNewer(null, '0.1.180'), false)
})

test('registryUrl prefers ANTSEED_NPM_REGISTRY, then npm config, and ignores non-http values', () => {
  assert.equal(registryUrl({}), 'https://registry.npmjs.org')
  assert.equal(registryUrl({ npm_config_registry: 'https://npm.example.test/' }), 'https://npm.example.test')
  assert.equal(registryUrl({ ANTSEED_NPM_REGISTRY: 'https://mirror.test//', npm_config_registry: 'https://npm.example.test' }), 'https://mirror.test')
  assert.equal(registryUrl({ ANTSEED_NPM_REGISTRY: 'file:///etc/passwd' }), 'https://registry.npmjs.org')
  assert.equal(distTagsUrl('https://r.test'), 'https://r.test/-/package/@antseed%2fcli/dist-tags')
})

test('fetchLatestVersion reads the latest dist-tag and rejects odd answers', async () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
  assert.equal(await fetchLatestVersion({ registry: 'https://r.test', fetch: answer(200, { latest: '0.1.193', next: '0.2.0-rc.1' }) }), '0.1.193')
  await assert.rejects(fetchLatestVersion({ registry: 'https://r.test', fetch: answer(500, {}) }), /500/)
  await assert.rejects(fetchLatestVersion({ registry: 'https://r.test', fetch: answer(200, { latest: '; rm -rf /' }) }), /no valid latest/)
})

test('the update cache round-trips and ignores a corrupt file', () => {
  const { dir, cleanup } = tempDir()
  try {
    assert.equal(readUpdateCache(dir), null)
    writeUpdateCache(dir, { checkedAt: 123, latest: '0.1.193' })
    assert.deepEqual(readUpdateCache(dir), { checkedAt: 123, latest: '0.1.193' })
    writeFileSync(join(dir, 'update-check.json'), '{"checkedAt":1,"latest":"evil"}')
    assert.equal(readUpdateCache(dir), null)
  } finally {
    cleanup()
  }
})

test('updateChecksDisabled honours NO_UPDATE_NOTIFIER, ANTSEED_NO_UPDATE_CHECK and CI', () => {
  assert.equal(updateChecksDisabled({}), false)
  assert.equal(updateChecksDisabled({ NO_UPDATE_NOTIFIER: '1' }), true)
  assert.equal(updateChecksDisabled({ ANTSEED_NO_UPDATE_CHECK: 'true' }), true)
  assert.equal(updateChecksDisabled({ CI: 'true' }), true)
  assert.equal(updateChecksDisabled({ CI: 'false' }), false)
  assert.equal(updateChecksDisabled({ NO_UPDATE_NOTIFIER: '0' }), false)
})

test('detectInstallMethod picks the package manager from where the CLI lives', () => {
  const detect = (scriptPath: string, env: NodeJS.ProcessEnv = {}, isWritable = () => true) =>
    detectInstallMethod({ scriptPath, env, electron: false, isWritable })
  const npm = detect('/Users/a/.nvm/versions/node/v24.0.0/lib/node_modules/@antseed/cli/dist/cli/index.js')
  assert.equal(npm.kind, 'npm')
  assert.deepEqual(npm.argv?.slice(1), ['install', '-g', '@antseed/cli@latest'])
  const rootNpm = detect('/usr/lib/node_modules/@antseed/cli/dist/cli/index.js', {}, () => false)
  assert.equal(rootNpm.kind, 'npm')
  assert.equal(rootNpm.argv, null)
  assert.equal(rootNpm.command, 'sudo npm install -g @antseed/cli@latest')
  assert.equal(detect('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@antseed\\cli\\dist\\cli\\index.js').kind, 'npm')
  assert.equal(detect('/Users/a/Library/pnpm/global/5/node_modules/@antseed/cli/dist/cli/index.js').kind, 'pnpm')
  assert.equal(detect('/Users/a/.config/yarn/global/node_modules/@antseed/cli/dist/cli/index.js').kind, 'yarn')
  assert.equal(detect('/Users/a/.bun/install/global/node_modules/@antseed/cli/dist/cli/index.js').kind, 'bun')
  assert.equal(detect('/Users/a/.volta/tools/image/packages/@antseed/cli/lib/node_modules/@antseed/cli/dist/cli/index.js').kind, 'volta')
  assert.equal(detect('/Users/a/.npm/_npx/abc/node_modules/@antseed/cli/dist/cli/index.js').kind, 'npx')
  assert.equal(detect('/nix/store/abc-antseed/lib/antseed/bundle.mjs').kind, 'nix')
  assert.equal(detect('/srv/app/node_modules/@antseed/cli/dist/cli/index.js').kind, 'local')
  assert.equal(detect('/Users/a/Development/antseed/apps/cli/dist/cli/index.js').kind, 'source')
  const installer = detect('/opt/antseed/cli/lib/node_modules/@antseed/cli/dist/cli/index.js', { ANTSEED_UPDATER_REQUEST: '/var/lib/antseed/update-request' })
  assert.equal(installer.kind, 'installer')
  assert.equal(detectInstallMethod({ scriptPath: '/x', env: {}, electron: true }).kind, 'desktop')
})

test('root updater: a request reads as requested, then the status file takes over', () => {
  const { dir, cleanup } = tempDir()
  try {
    const env = { ANTSEED_UPDATER_REQUEST: join(dir, 'update-request'), ANTSEED_UPDATER_STATUS: join(dir, 'status.json') }
    const paths = rootUpdaterPaths(env)!
    assert.equal(rootUpdaterPaths({ ANTSEED_UPDATER_REQUEST: 'x' }), null)
    assert.equal(readRootUpdateProgress(paths), null)
    requestRootUpdate(paths, 'tester')
    assert.ok(existsSync(paths.request))
    assert.match(readFileSync(paths.request, 'utf8'), /tester/)
    const requested = readRootUpdateProgress(paths)
    assert.equal(requested?.state, 'requested')
    assert.equal(updateInFlight(requested), true)

    rmSync(paths.request)
    writeFileSync(paths.status, JSON.stringify({ state: 'succeeded', from: '0.1.180', to: '0.1.193', startedAt: 1, finishedAt: 2, error: null }))
    const done = readRootUpdateProgress(paths)
    assert.deepEqual(done, { state: 'succeeded', from: '0.1.180', to: '0.1.193', startedAt: 1, finishedAt: 2, error: null })
    assert.equal(updateInFlight(done), false)

    writeFileSync(paths.status, JSON.stringify({ state: 'pwned', startedAt: 1 }))
    assert.equal(readRootUpdateProgress(paths), null)
  } finally {
    cleanup()
  }
})

function fakeStream(isTTY: boolean) {
  const lines: string[] = []
  return { lines, stream: { isTTY, write: (chunk: string) => { lines.push(chunk); return true } } as unknown as NodeJS.WriteStream }
}

test('the notifier prints from the cache, refreshes when stale, and stays quiet when it should', () => {
  const { dir, cleanup } = tempDir()
  try {
    const env = { ANTSEED_UPDATER_REQUEST: join(dir, 'r'), ANTSEED_UPDATER_STATUS: join(dir, 's') }
    const refreshed: string[] = []
    const run = (overrides: Partial<Parameters<typeof notifyIfUpdateAvailable>[0]> = {}, isTTY = true) => {
      const out = fakeStream(isTTY)
      notifyIfUpdateAvailable({ dataDir: dir, current: '0.1.180', commandName: 'start', argv: [], env, stream: out.stream, now: 10_000, refresh: (d) => refreshed.push(d), ...overrides })
      return out.lines.join('')
    }

    assert.equal(run(), '')
    assert.deepEqual(refreshed, [dir], 'no cache: refresh in the background, print nothing')

    writeUpdateCache(dir, { checkedAt: 9_000, latest: '0.1.193' })
    refreshed.length = 0
    assert.match(run(), /0\.1\.193 is available \(you have 0\.1\.180\).*antseed update/)
    assert.deepEqual(refreshed, [], 'a fresh cache is not refreshed')

    assert.equal(run({ argv: ['--json'] }), '')
    assert.equal(run({ commandName: 'update' }), '')
    assert.equal(run({}, false), '')
    assert.equal(run({ env: { ...env, NO_UPDATE_NOTIFIER: '1' } }), '')
    assert.equal(run({ current: '0.1.193' }), '')
  } finally {
    cleanup()
  }
})
