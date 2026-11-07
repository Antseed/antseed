import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { STOP_ON_STDIN_CLOSE_ENV, stopWhenStdinCloses } from './stop-on-stdin-close.js'

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
