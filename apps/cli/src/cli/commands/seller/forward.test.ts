import assert from 'node:assert/strict'
import net, { createServer } from 'node:net'
import test from 'node:test'
import { parseTlsTarget, startTlsForwarder } from './forward.js'

test('parses the gateway address, defaulting to port 443', () => {
  assert.deepEqual(parseTlsTarget('app-6882.dstack-prod5.phala.network'), { host: 'app-6882.dstack-prod5.phala.network', port: 443 })
  assert.deepEqual(parseTlsTarget('gw.example:8443'), { host: 'gw.example', port: 8443 })
  assert.throws(() => parseTlsTarget('https://gw.example'))
  assert.throws(() => parseTlsTarget('gw.example:70000'))
})

test('carries each buyer connection to the target and back', async () => {
  // Stands in for the gateway: echoes with a prefix, so both directions are checked.
  const upstream = createServer((socket) => socket.on('data', (data) => socket.write(`seller:${data}`)))
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as net.AddressInfo).port
  const forwarder = startTlsForwarder(0, { host: '127.0.0.1', port: upstreamPort }, { connect: ({ host, port }) => net.connect({ host, port }) })
  await new Promise<void>((resolve) => forwarder.once('listening', resolve))
  const port = (forwarder.address() as net.AddressInfo).port
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const buyer = net.connect({ host: '127.0.0.1', port }, () => buyer.write('hello'))
      buyer.once('data', (data) => { resolve(data.toString()); buyer.destroy() })
      buyer.once('error', reject)
    })
    assert.equal(reply, 'seller:hello')
  } finally {
    forwarder.close()
    upstream.close()
  }
})

test('closes idle connections and refuses connections over the cap', async () => {
  const upstream = createServer(() => {})
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as net.AddressInfo).port
  const forwarder = startTlsForwarder(0, { host: '127.0.0.1', port: upstreamPort }, {
    connect: ({ host, port }) => net.connect({ host, port }),
    maxConnections: 1,
    idleTimeoutMs: 100,
  })
  await new Promise<void>((resolve) => forwarder.once('listening', resolve))
  const port = (forwarder.address() as net.AddressInfo).port
  const closed = (socket: net.Socket) => new Promise<void>((resolve) => socket.once('close', () => resolve()))
  try {
    const first = net.connect({ host: '127.0.0.1', port })
    first.on('error', () => {})
    await new Promise<void>((resolve) => first.once('connect', () => resolve()))
    const second = net.connect({ host: '127.0.0.1', port })
    second.on('error', () => {})
    // The second is over the cap and closed at once; the first closes once idle.
    await closed(second)
    const started = Date.now()
    await closed(first)
    assert.ok(Date.now() - started < 2_000)
  } finally {
    forwarder.close()
    upstream.close()
  }
})
