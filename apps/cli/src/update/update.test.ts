import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { detectInstallMethod } from './install-method.js'
import { notifyIfUpdateAvailable } from './notifier.js'
import { watchForUpdates } from './watch.js'
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
    assert.deepEqual(done, { state: 'succeeded', action: 'install', from: '0.1.180', to: '0.1.193', startedAt: 1, finishedAt: 2, error: null })
    assert.equal(updateInFlight(done), false)

    writeFileSync(paths.status, JSON.stringify({ state: 'pwned', startedAt: 1 }))
    assert.equal(readRootUpdateProgress(paths), null)
  } finally {
    cleanup()
  }
})

test('readRootUpdateProgress reads the step a running update is on, and only a known one', () => {
  const { dir, cleanup } = tempDir()
  try {
    const paths = { request: join(dir, 'update-request'), status: join(dir, 'status.json') }
    const run = { state: 'running', action: 'install', from: '0.1.201', to: '0.1.202', startedAt: 1_000, finishedAt: null, error: null }
    // What the installer's updater writes while the gateway drains.
    writeFileSync(paths.status, `${JSON.stringify({ ...run, phase: 'draining-gateway', phaseStartedAt: 61_000, phaseMaxMs: 90_000 })}\n`)
    assert.deepEqual(readRootUpdateProgress(paths), { ...run, phase: 'draining-gateway', phaseStartedAt: 61_000, phaseMaxMs: 90_000 })

    // Steps without a bound write null; older updaters write no step at all.
    writeFileSync(paths.status, JSON.stringify({ ...run, phase: 'restarting-buyer', phaseStartedAt: 2_000, phaseMaxMs: null }))
    assert.deepEqual(readRootUpdateProgress(paths), { ...run, phase: 'restarting-buyer', phaseStartedAt: 2_000 })
    writeFileSync(paths.status, JSON.stringify(run))
    assert.deepEqual(readRootUpdateProgress(paths), run)

    // An unknown step is dropped, not passed on.
    writeFileSync(paths.status, JSON.stringify({ ...run, phase: '<script>', phaseStartedAt: 2_000 }))
    assert.deepEqual(readRootUpdateProgress(paths), run)

    // A finished run has no step, whatever the file says.
    const done = { ...run, state: 'succeeded', finishedAt: 150_000 }
    writeFileSync(paths.status, JSON.stringify({ ...done, phase: null, phaseStartedAt: null, phaseMaxMs: null }))
    assert.deepEqual(readRootUpdateProgress(paths), done)

    // A run cut off long ago reads as failed, without its last step.
    writeFileSync(paths.status, JSON.stringify({ ...run, phase: 'checking', phaseStartedAt: 2_000 }))
    const stale = readRootUpdateProgress(paths, { staleAfterMs: 60_000, now: 1_000 + 60_001 })
    assert.equal(stale?.state, 'failed')
    assert.equal(stale?.phase, undefined)
    assert.equal(stale?.phaseStartedAt, undefined)
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

test('root updater: a download request reads as one, and a downloaded version as ready', () => {
  const { dir, cleanup } = tempDir()
  try {
    const paths = { request: join(dir, 'update-request'), status: join(dir, 'status.json') }
    requestRootUpdate(paths, 'owner', 1_000, 'download')
    assert.deepEqual([readRootUpdateProgress(paths)?.state, readRootUpdateProgress(paths)?.action], ['requested', 'download'])
    // Renamed into place whole, so the updater never sees it half written.
    assert.deepEqual(JSON.parse(readFileSync(paths.request, 'utf8')), { requestedAt: 1_000, requestedBy: 'owner', action: 'download' })
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [])
    rmSync(paths.request)
    writeFileSync(paths.status, JSON.stringify({ state: 'ready', action: 'download', from: '0.1.180', to: '0.1.193', startedAt: 1, finishedAt: 2, error: null }))
    const ready = readRootUpdateProgress(paths)
    assert.deepEqual([ready?.state, ready?.action, ready?.to], ['ready', 'download', '0.1.193'])
    assert.equal(updateInFlight(ready), false)
    // A run left "running" (a reboot, a kill) stops blocking updates once it is stale.
    writeFileSync(paths.status, JSON.stringify({ state: 'running', action: 'install', from: '0.1.180', to: '0.1.193', startedAt: 1_000, finishedAt: null, error: null }))
    assert.equal(readRootUpdateProgress(paths, { staleAfterMs: 60_000, now: 30_000 })?.state, 'running')
    const stale = readRootUpdateProgress(paths, { staleAfterMs: 60_000, now: 90_000 })
    assert.deepEqual([stale?.state, stale?.error], ['failed', 'the update service stopped before finishing'])
    assert.equal(updateInFlight(stale), false)
    assert.equal(readRootUpdateProgress(paths)?.state, 'running', 'the desktop app finishes on its next launch, however late')
    // Requests and statuses from before the two steps install.
    writeFileSync(paths.status, JSON.stringify({ state: 'succeeded', from: '0.1.180', to: '0.1.193', startedAt: 1, finishedAt: 2, error: null }))
    assert.equal(readRootUpdateProgress(paths)?.action, 'install')
  } finally {
    cleanup()
  }
})

test('a running seller logs each newer version once and installs nothing', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const npm = detectInstallMethod({ env: {}, scriptPath: '/usr/local/lib/node_modules/@antseed/cli/dist/cli/index.js', electron: false, isWritable: () => true })
    let latest = '0.1.180'
    let clock = 0
    let fetches = 0
    const lines: string[] = []
    const watch = watchForUpdates({
      dataDir: dir, current: '0.1.180', running: 'seller', env: {}, method: npm,
      log: (line) => lines.push(line), now: () => clock,
      fetchLatest: async () => { fetches += 1; return latest },
      intervalMs: 1_000,
    })
    try {
      // It checks once as it starts.
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(fetches, 1)
      assert.deepEqual(lines, [], 'up to date')
      latest = '0.1.193'
      await watch.check()
      assert.equal(fetches, 1, 'a fresh cache answers within the interval')
      clock = 2_000
      await watch.check()
      assert.equal(lines.length, 1)
      assert.match(lines[0]!, /Antseed 0\.1\.193 is available \(this seller runs 0\.1\.180\)\. Run .*antseed update.*, then restart the seller\./)
      clock = 4_000
      await watch.check()
      assert.equal(lines.length, 1, 'once per version')
      latest = '0.1.194'
      clock = 6_000
      await watch.check()
      assert.equal(lines.length, 2)
      // The 30-minute tick asks npm even when the cache it wrote looks fresh.
      latest = '0.1.195'
      const before = fetches
      await watch.check(true)
      assert.equal(fetches, before + 1)
      assert.equal(lines.length, 3)
    } finally {
      watch.stop()
    }

    const quiet: string[] = []
    const off = watchForUpdates({ dataDir: dir, current: '0.1.180', running: 'seller', env: { ANTSEED_NO_UPDATE_CHECK: '1' }, method: npm, log: (line) => quiet.push(line), fetchLatest: async () => '0.1.199' })
    await off.check()
    const desktop = watchForUpdates({ dataDir: dir, current: '0.1.180', running: 'seller', env: {}, method: { ...npm, kind: 'desktop' }, log: (line) => quiet.push(line), fetchLatest: async () => '0.1.199' })
    await desktop.check()
    assert.deepEqual(quiet, [], 'off when disabled, and in the desktop app, which has its own updater')
  } finally {
    cleanup()
  }
})
