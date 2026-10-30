import assert from 'node:assert/strict'
import test from 'node:test'
import type { GatewayUpdate } from '../gateway/console-api/types.js'
import type { GatewayUpdates } from '../gateway/updates.js'
import { inContainer, sellerUpdates } from './updates.js'

function stub(update: Partial<GatewayUpdate> = {}) {
  const calls: string[] = []
  const value: GatewayUpdate = {
    product: 'cli', current: '0.1.200', latest: '0.1.208', available: true, checkedAt: 1, checkError: null, checksDisabled: false,
    apply: 'console', install: 'installer', command: 'antseed update', note: 'Installed by the gateway installer.',
    progress: { state: 'ready', action: 'download', to: '0.1.208' } as GatewayUpdate['progress'], downloaded: '0.1.208',
    ...update,
  }
  const inner: GatewayUpdates = {
    info: () => { calls.push('info'); return value },
    check: async () => { calls.push('check'); return value },
    apply: () => { calls.push('apply'); return value },
    watch: () => { calls.push('watch') },
    stop: () => { calls.push('stop') },
  }
  return { inner, calls }
}

test('a seller outside a container is shown the command, never the installer\'s one-click update', async () => {
  const { inner, calls } = stub()
  const updates = sellerUpdates(inner, false)
  const info = updates.info()
  assert.equal(info.apply, 'command')
  assert.equal(info.command, 'antseed update')
  assert.equal(info.available, true)
  assert.equal(info.progress, null)
  assert.equal(info.downloaded, null)
  assert.match(info.note, /Restart the seller after updating\.$/)
  assert.equal((await updates.check()).apply, 'command')
  assert.throws(() => updates.apply('seller', 'install'), /does not install updates/)
  updates.stop()
  assert.deepEqual(calls, ['info', 'check', 'stop'])
})

test('an install with nothing to run says how it updates', () => {
  const { inner } = stub({ apply: 'none', install: 'desktop', command: null, note: 'Bundled with the desktop app, which updates it.' })
  const info = sellerUpdates(inner, false).info()
  assert.equal(info.apply, 'none')
  assert.equal(info.command, null)
  assert.equal(info.note, 'Bundled with the desktop app, which updates it. Restart the seller after updating.')
})

test('a seller in a container updates by a new image', () => {
  const { inner } = stub({ install: 'npm', apply: 'command', command: 'npm install -g @antseed/cli@latest' })
  const info = sellerUpdates(inner, true).info()
  assert.equal(info.apply, 'none')
  assert.equal(info.command, null)
  assert.equal(info.latest, '0.1.208')
  assert.match(info.note, /@antseed\/cli 0\.1\.208/)
})

test('kubernetes counts as a container', () => {
  assert.equal(inContainer({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }), true)
})
