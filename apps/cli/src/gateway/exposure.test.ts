import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addressScope, detectExposure, detectHostFacts, isPersonalComputer, type HostFacts } from './exposure.js'

const SERVER: HostFacts = { platform: 'linux', systemd: true, container: false }
const MAC: HostFacts = { platform: 'darwin', systemd: false, container: false }

test('addressScope classifies loopback, wildcard, private and public addresses', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'app.localhost', '::1', '[::1]', '::ffff:127.0.0.1']) assert.equal(addressScope(host), 'loopback', host)
  for (const host of ['0.0.0.0', '::', '', null, undefined]) assert.equal(addressScope(host), 'any', String(host))
  for (const host of ['10.0.0.5', '172.16.1.1', '172.31.255.1', '192.168.1.20', '169.254.1.1', '100.100.1.1', 'fd12::1', 'fe80::1', 'nas', 'box.local', 'gw.lan', 'gw.home.arpa']) {
    assert.equal(addressScope(host), 'private', host)
  }
  for (const host of ['203.0.113.7', '172.32.0.1', '100.128.0.1', '2001:db8::1']) assert.equal(addressScope(host), 'public', host)
  assert.equal(addressScope('llm.example.com'), 'name')
})

test('a laptop gateway on loopback without a public URL is local', () => {
  const exposure = detectExposure({ publicUrl: null, listenHost: '127.0.0.1', host: MAC })
  assert.equal(exposure.mode, 'local')
  assert.equal(exposure.reachableFromInternet, false)
  assert.equal(exposure.personalComputer, true)
  assert.equal(exposure.listenHost, '127.0.0.1')
  assert.ok(exposure.reasons.some((reason) => reason.includes('only this computer')))
  assert.ok(exposure.reasons.some((reason) => reason.includes('macOS')))
})

test('listening beyond loopback without a public URL is lan', () => {
  const any = detectExposure({ publicUrl: null, listenHost: '0.0.0.0', host: SERVER })
  assert.equal(any.mode, 'lan')
  assert.equal(any.reachableFromInternet, null)
  assert.equal(any.personalComputer, false)

  const privateIp = detectExposure({ publicUrl: null, listenHost: '192.168.1.20', host: SERVER })
  assert.equal(privateIp.mode, 'lan')
  assert.equal(privateIp.reachableFromInternet, false)

  const publicIp = detectExposure({ publicUrl: null, listenHost: '203.0.113.7', host: SERVER })
  assert.equal(publicIp.mode, 'lan')
  assert.equal(publicIp.reachableFromInternet, true)
  assert.ok(publicIp.reasons.some((reason) => reason.includes('unencrypted')))
})

test('a public URL makes it public, unless it points at this machine or a private network', () => {
  const server = detectExposure({ publicUrl: 'https://llm.example.com', listenHost: '127.0.0.1', host: SERVER })
  assert.equal(server.mode, 'public')
  assert.equal(server.reachableFromInternet, true)
  assert.equal(server.publicUrl, 'https://llm.example.com')
  assert.equal(server.personalComputer, false)

  const tunnelOnLaptop = detectExposure({ publicUrl: 'https://quick.trycloudflare.com', listenHost: '127.0.0.1', host: MAC })
  assert.equal(tunnelOnLaptop.mode, 'public')
  assert.equal(tunnelOnLaptop.personalComputer, true, 'still flagged as a personal computer')

  const plain = detectExposure({ publicUrl: 'http://llm.example.com', listenHost: '127.0.0.1', host: SERVER })
  assert.ok(plain.reasons.some((reason) => reason.includes('plain HTTP')))

  const localhostUrl = detectExposure({ publicUrl: 'http://localhost:8379', listenHost: '127.0.0.1', host: MAC })
  assert.equal(localhostUrl.mode, 'local')
  assert.equal(localhostUrl.publicUrl, null)

  const lanUrl = detectExposure({ publicUrl: 'http://192.168.1.20:8379', listenHost: '0.0.0.0', host: SERVER })
  assert.equal(lanUrl.mode, 'lan')
  assert.equal(lanUrl.reachableFromInternet, false)
})

test('personal computer hint: macOS and Windows always, Linux without systemd outside containers', () => {
  assert.equal(isPersonalComputer({ platform: 'win32', systemd: false, container: false }), true)
  assert.equal(isPersonalComputer({ platform: 'darwin', systemd: false, container: true }), true)
  assert.equal(isPersonalComputer({ platform: 'linux', systemd: false, container: false }), true)
  assert.equal(isPersonalComputer({ platform: 'linux', systemd: false, container: true }), false)
  assert.equal(isPersonalComputer(SERVER), false)
})

test('detectHostFacts reads systemd and container markers without network calls', () => {
  const files = new Set(['/run/systemd/system'])
  assert.deepEqual({ ...detectHostFacts({}, (path) => files.has(path)), platform: 'x' }, { platform: 'x', systemd: true, container: false })
  assert.equal(detectHostFacts({ INVOCATION_ID: 'abc' }, () => false).systemd, true)
  assert.equal(detectHostFacts({}, (path) => path === '/.dockerenv').container, true)
  assert.equal(detectHostFacts({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, () => false).container, true)
})
