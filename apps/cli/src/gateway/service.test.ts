import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  installService,
  launchdPlist,
  SERVICE_STOP_TIMEOUT_S,
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

/** Probe answers queued per port; a port with nothing queued does not answer. */
function fakeDeps(platform: ServicePlatform, answers: Partial<Record<number, boolean[]>>): ServiceDeps & { calls: string[] } {
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
    probe: async (port) => answers[port]?.shift() ?? false,
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
  assert.ok(plist.includes(`<key>ExitTimeOut</key><integer>${SERVICE_STOP_TIMEOUT_S}</integer>`))
})

test('the stop timeout covers the gateway drain followed by the buyer stop', () => {
  // 60 s gateway drain + 90 s buyer stop deadline, plus slack.
  assert.equal(SERVICE_STOP_TIMEOUT_S, 180)
})

test('systemd unit quotes paths with spaces and escapes % and $', () => {
  const unit = systemdUnit({ ...spec, dataDir: '/d/100%$x' })
  assert.ok(unit.includes(`ExecStart="${spec.nodePath}" "${spec.cliPath}" "--data-dir" "/d/100%%$$x"`), unit)
  assert.ok(unit.includes(`Environment="PATH=${spec.pathEnv}"`))
  assert.ok(!unit.includes('ANTSEED_PASSPHRASE_FILE'))
  assert.ok(unit.includes('WantedBy=default.target'))
  assert.ok(unit.includes('KillMode=mixed'))
  assert.ok(unit.includes(`TimeoutStopSec=${SERVICE_STOP_TIMEOUT_S}`))
})

test('systemd Environment= keeps a literal $ (only ExecStart expands variables)', () => {
  const unit = systemdUnit({ ...spec, dataDir: '/d/$x', passphraseFile: '/k/pa$$word%1' })
  assert.ok(unit.includes('Environment="ANTSEED_PASSPHRASE_FILE=/k/pa$$word%%1"'), unit)
  assert.ok(unit.includes('"--data-dir" "/d/$$x"'), unit)
})

test('linux install writes the unit, enables and restarts it, waits for the port, reports lingering', async () => {
  const deps = fakeDeps('linux', { [spec.port]: [false, false, true], [spec.buyerPort]: [true] })
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
  const deps = fakeDeps('darwin', { [spec.port]: [false, true, true], [spec.buyerPort]: [true, true] })
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
  const deps = fakeDeps('linux', { [spec.port]: [true] })
  await assert.rejects(installService(spec, deps, { waitMs: 0 }), /already answers on port 8379/)
  assert.equal(existsSync(serviceFilePath('linux', deps.home)), false)
  assert.deepEqual(deps.calls, [])
})

test('install reports not ready when the port never answers', async () => {
  const deps = fakeDeps('linux', {})
  assert.equal((await installService(spec, deps, { waitMs: 3_000 })).ready, false)
})

test('install is not ready while the gateway answers but its buyer does not', async () => {
  const deps = fakeDeps('linux', { [spec.port]: [false, true] })
  const result = await installService(spec, deps, { waitMs: 3_000 })
  assert.equal(result.ready, false)
  assert.equal(result.gatewayAnswered, true)
})

test('linux uninstall keeps the unit file when stopping it fails', async () => {
  const deps = fakeDeps('linux', { [spec.port]: [false] })
  await installService(spec, deps, { waitMs: 0 })
  const exec = deps.exec
  deps.exec = (file, args) => {
    if (file === 'systemctl' && args.includes('disable')) throw Object.assign(new Error('exit 1'), { stderr: 'Failed to connect to bus' })
    return exec(file, args)
  }
  await assert.rejects(uninstallService(deps), /Could not stop antseed-gateway\.service; it was not removed\. Failed to connect to bus/)
  assert.equal(existsSync(serviceFilePath('linux', deps.home)), true)
})

test('macOS uninstall keeps the plist when launchd fails to unload a loaded agent', async () => {
  const deps = fakeDeps('darwin', { [spec.port]: [false] })
  await installService({ ...spec, logFile: join(deps.home, 'logs', 'gateway.log') }, deps, { waitMs: 0 })
  deps.exec = (file, args) => {
    if (file === 'launchctl' && args[0] === 'bootout') throw new Error('Boot-out failed: 5: Input/output error')
    return '' // print succeeds: still loaded
  }
  await assert.rejects(uninstallService(deps), /could not unload com\.antseed\.gateway; it was not removed/)
  assert.equal(existsSync(serviceFilePath('darwin', deps.home)), true)
})

test('macOS uninstall removes the plist when the agent was not loaded', async () => {
  const deps = fakeDeps('darwin', { [spec.port]: [false] })
  await installService({ ...spec, logFile: join(deps.home, 'logs', 'gateway.log') }, deps, { waitMs: 0 })
  deps.exec = (file, args) => {
    if (file === 'launchctl') throw new Error(args[0] === 'bootout' ? 'Boot-out failed: 3: No such process' : 'Could not find service')
    return ''
  }
  assert.equal(await uninstallService(deps), true)
  assert.equal(existsSync(serviceFilePath('darwin', deps.home)), false)
})

test('uninstall disables the unit and removes the file; false when not installed', async () => {
  const deps = fakeDeps('linux', { [spec.port]: [false] })
  assert.equal(await uninstallService(deps), false)
  await installService(spec, deps, { waitMs: 0 })
  deps.calls.length = 0
  assert.equal(await uninstallService(deps), true)
  assert.equal(existsSync(serviceFilePath('linux', deps.home)), false)
  assert.deepEqual(deps.calls, ['systemctl --user disable --now antseed-gateway.service', 'systemctl --user daemon-reload'])
})
