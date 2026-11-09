import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  installService,
  launchdPlist,
  serviceFilePath,
  systemdUnit,
  uninstallService,
  type ServiceDeps,
  type ServicePlatform,
  type ServiceSpec,
} from './service.js'

const spec: ServiceSpec = {
  nodePath: '/home/a b/.nvm/versions/node/v24.1.0/bin/node',
  cliPath: '/home/a b/lib/node_modules/@antseed/cli/dist/cli/index.js',
  dataDir: '/home/a b/.antseed',
  configPath: '/home/a b/.antseed/config.json',
  port: 8379,
  buyerPort: 8377,
  pathEnv: '/home/a b/.nvm/versions/node/v24.1.0/bin:/usr/bin:/bin',
  logFile: '/home/a b/.antseed/logs/gateway.log',
}

function fakeDeps(platform: ServicePlatform, answers: boolean[]): ServiceDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    platform,
    home: mkdtempSync(join(tmpdir(), 'antseed-service-')),
    uid: 501,
    calls,
    exec: (file, args) => {
      calls.push([file, ...args].join(' '))
      // launchd reports the agent as gone on the first check after bootout.
      if (file === 'launchctl' && args[0] === 'print') throw new Error('Could not find service')
      return file === 'loginctl' ? 'no\n' : ''
    },
    probe: async () => answers.shift() ?? false,
    sleep: async () => undefined,
  }
}

test('launchd plist runs gateway start with absolute paths and escapes XML', () => {
  const plist = launchdPlist({ ...spec, passphraseFile: '/k/p&q' })
  assert.ok(plist.includes('<string>com.antseed.gateway</string>'))
  assert.ok(plist.includes(`<string>${spec.nodePath}</string>`))
  assert.ok(plist.includes('<string>gateway</string>\n    <string>start</string>\n    <string>--port</string>\n    <string>8379</string>'))
  assert.ok(plist.includes('<key>ANTSEED_PASSPHRASE_FILE</key><string>/k/p&amp;q</string>'))
  assert.ok(plist.includes('<key>KeepAlive</key><true/>'))
})

test('systemd unit quotes paths with spaces and escapes % and $', () => {
  const unit = systemdUnit({ ...spec, dataDir: '/d/100%$x' })
  assert.ok(unit.includes(`ExecStart="${spec.nodePath}" "${spec.cliPath}" "--data-dir" "/d/100%%$$x"`), unit)
  assert.ok(unit.includes(`Environment="PATH=${spec.pathEnv}"`))
  assert.ok(!unit.includes('ANTSEED_PASSPHRASE_FILE'))
  assert.ok(unit.includes('WantedBy=default.target'))
})

test('linux install writes the unit, enables and restarts it, waits for the port, reports lingering', async () => {
  const deps = fakeDeps('linux', [false, false, true, true])
  const result = await installService(spec, deps, { waitMs: 10_000 })
  assert.equal(readFileSync(result.file, 'utf8'), systemdUnit(spec))
  assert.deepEqual(deps.calls.slice(0, 3), [
    'systemctl --user daemon-reload',
    'systemctl --user enable antseed-gateway.service',
    'systemctl --user restart antseed-gateway.service',
  ])
  assert.match(deps.calls[3] ?? '', /^loginctl show-user/)
  assert.equal(result.ready, true)
  assert.equal(result.lingering, false)
})

test('macOS install bootstraps the agent, and unloads an earlier install first', async () => {
  const deps = fakeDeps('darwin', [false, true, true, true, true])
  const logFile = join(deps.home, 'logs', 'gateway.log')
  await installService({ ...spec, logFile }, deps, { waitMs: 5_000 })
  const file = serviceFilePath('darwin', deps.home)
  assert.deepEqual(deps.calls, [`launchctl bootstrap gui/501 ${file}`])
  assert.ok(existsSync(join(deps.home, 'logs')))

  deps.calls.length = 0
  await installService({ ...spec, logFile }, deps, { waitMs: 5_000 })
  assert.deepEqual(deps.calls, [
    'launchctl bootout gui/501/com.antseed.gateway',
    'launchctl print gui/501/com.antseed.gateway',
    `launchctl bootstrap gui/501 ${file}`,
  ])
})

test('install refuses when something else already answers on the port', async () => {
  const deps = fakeDeps('linux', [true])
  await assert.rejects(installService(spec, deps, { waitMs: 0 }), /already answers on port 8379/)
  assert.equal(existsSync(serviceFilePath('linux', deps.home)), false)
  assert.deepEqual(deps.calls, [])
})

test('install reports not ready when the port never answers', async () => {
  const deps = fakeDeps('linux', [])
  assert.equal((await installService(spec, deps, { waitMs: 3_000 })).ready, false)
})

test('install is not ready while the gateway answers but its buyer does not', async () => {
  const deps = fakeDeps('linux', [false, true, false, false, false])
  const result = await installService(spec, deps, { waitMs: 3_000 })
  assert.equal(result.ready, false)
  assert.equal(result.gatewayAnswered, true)
})

test('uninstall disables the unit and removes the file; false when not installed', async () => {
  const deps = fakeDeps('linux', [false])
  assert.equal(await uninstallService(deps), false)
  await installService(spec, deps, { waitMs: 0 })
  deps.calls.length = 0
  assert.equal(await uninstallService(deps), true)
  assert.equal(existsSync(serviceFilePath('linux', deps.home)), false)
  assert.deepEqual(deps.calls, ['systemctl --user disable --now antseed-gateway.service', 'systemctl --user daemon-reload'])
})
