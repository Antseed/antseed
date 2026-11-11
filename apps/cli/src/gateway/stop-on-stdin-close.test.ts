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

test('a parent that goes away while the buyer is still starting stops the buyer too', { skip: process.platform === 'win32' }, async () => {
  const { spawn } = await import('node:child_process')
  const hooks = new URL('./stop-on-stdin-close.js', import.meta.url).href
  const shutdown = new URL('../cli/shutdown.js', import.meta.url).href
  // The gateway's start order: parent hooks first, then a buyer whose start
  // waits (here forever), with its stop registered as soon as it is spawned.
  const script = `
    const { stopWhenStdinCloses } = await import(${JSON.stringify(hooks)})
    const { requestShutdown, setupShutdownHandler } = await import(${JSON.stringify(shutdown)})
    const { spawn } = await import('node:child_process')
    stopWhenStdinCloses(process.stdin, requestShutdown)
    const buyer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    setupShutdownHandler(async () => { process.kill(buyer.pid, 'SIGKILL') })
    process.stdout.write(String(buyer.pid) + '\\n')
    await new Promise(() => {})
  `
  const gateway = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, [STOP_ON_STDIN_CLOSE_ENV]: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const buyerPid = await new Promise<number>((resolve) => gateway.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim()))))
  const exited = new Promise<number | null>((resolve) => gateway.once('exit', resolve))
  gateway.stdin.end()
  assert.equal(await exited, 0)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.throws(() => process.kill(buyerPid, 0), /ESRCH/)
})

test('a stop asked before anything started just exits', { skip: process.platform === 'win32' }, async () => {
  const { spawn } = await import('node:child_process')
  const shutdown = new URL('../cli/shutdown.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { requestShutdown } = await import(${JSON.stringify(shutdown)})
    requestShutdown()
    await new Promise(() => setTimeout(() => {}, 60_000))
  `], { stdio: 'ignore' })
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
  assert.equal(code, 0)
})
