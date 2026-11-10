import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { PARENT_PID_ENV, STOP_ON_STDIN_CLOSE_ENV, stopWhenParentExits, stopWhenStdinCloses } from './stop-on-stdin-close.js'

test('closing stdin asks for a stop when the parent set it up', async () => {
  const stdin = new PassThrough()
  let stops = 0
  stopWhenStdinCloses(stdin, () => { stops += 1 }, { [STOP_ON_STDIN_CLOSE_ENV]: '1' })
  stdin.write('ignored')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(stops, 0)
  stdin.end()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(stops, 1)
})

test('a gateway started by hand ignores stdin', async () => {
  const stdin = new PassThrough()
  let stops = 0
  stopWhenStdinCloses(stdin, () => { stops += 1 }, {})
  stdin.end()
  stdin.resume()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(stops, 0)
})

test('a closed output pipe does not end the gateway before it stops', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let stops = 0
  stopWhenStdinCloses(stdin, () => { stops += 1 }, { [STOP_ON_STDIN_CLOSE_ENV]: '1' }, [stdout])
  // Without a listener this 'error' would be thrown.
  stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  stdin.end()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(stops, 1)
})

test('the gateway stops once its parent process is gone, and only when a parent was named', async () => {
  let alive = true
  let stops = 0
  const stopWatching = stopWhenParentExits(() => { stops += 1 }, { [PARENT_PID_ENV]: '4242' }, { exists: () => alive, intervalMs: 2 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(stops, 0)
  alive = false
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(stops, 1, 'stops once')
  stopWatching?.()
  assert.equal(stopWhenParentExits(() => { stops += 1 }, {}), null)
})
