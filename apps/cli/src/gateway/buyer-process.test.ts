import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import type { ChildProcess } from 'node:child_process'
import { FileIdentityStore } from '@antseed/node'
import { BUYER_RESTART_EXIT_CODE, BUYER_SHUTDOWN_DEADLINE_MS } from '../proxy/buyer-proxy.js'
import { BUYER_STOP_TIMEOUT_MS, GatewayBuyer, spawnCliBuyer } from './buyer-process.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed: string[] = []
  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal)
    this.exit(null, signal)
    return true
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

function harness() {
  const children: FakeChild[] = []
  const argsSeen: string[][] = []
  const logs: string[] = []
  const buyer = new GatewayBuyer({
    buyerPort: 28377,
    dataDir: '/data',
    configPath: '/data/config.json',
    verbose: false,
    onLog: (message) => { logs.push(message) },
    spawnBuyer: (args) => {
      argsSeen.push(args)
      const child = new FakeChild()
      children.push(child)
      return child as unknown as ChildProcess
    },
  })
  return { buyer, children, argsSeen, logs }
}

const waitForRestart = () => new Promise((resolve) => setTimeout(resolve, 1_100))

test('starts `buyer start` on the gateway\'s data dir, config and buyer port', () => {
  const { buyer, argsSeen } = harness()
  buyer.start()
  assert.deepEqual(argsSeen[0], ['--data-dir', '/data', '--config', '/data/config.json', 'buyer', 'start', '--port', '28377'])
})

test('restarts the buyer after a restart request and after a crash', async () => {
  const { buyer, children, logs } = harness()
  buyer.start()
  children[0]!.exit(BUYER_RESTART_EXIT_CODE)
  await waitForRestart()
  assert.equal(children.length, 2)
  assert.equal(logs.length, 0)
  children[1]!.exit(1)
  await waitForRestart()
  assert.equal(children.length, 3)
  assert.match(logs[0]!, /exited \(code 1\); restarting/)
  await buyer.stop()
})

test('gives up on a buyer that keeps exiting right after starting', async () => {
  const { buyer, children, logs } = harness()
  buyer.start()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    children[attempt]!.exit(1)
    if (attempt < 2) await waitForRestart()
  }
  await waitForRestart()
  assert.equal(children.length, 3)
  assert.match(logs.at(-1)!, /not restarting it/)
})

test('stop terminates the buyer and does not restart it', async () => {
  const { buyer, children } = harness()
  buyer.start()
  await buyer.stop()
  assert.deepEqual(children[0]!.killed, ['SIGTERM'])
  await waitForRestart()
  assert.equal(children.length, 1)
})

test('lets a draining buyer finish its own shutdown before killing it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = new FakeChild()
  // A buyer still draining requests ignores SIGTERM until it is done.
  child.kill = (signal) => {
    child.killed.push(signal)
    if (signal === 'SIGKILL') child.exit(null, signal)
    return true
  }
  const buyer = new GatewayBuyer({
    buyerPort: 28377,
    dataDir: '/data',
    configPath: '/data/config.json',
    verbose: false,
    onLog: () => {},
    spawnBuyer: () => child as unknown as ChildProcess,
  })
  buyer.start()
  const stopped = buyer.stop()

  t.mock.timers.tick(BUYER_SHUTDOWN_DEADLINE_MS)
  assert.deepEqual(child.killed, ['SIGTERM'])
  t.mock.timers.tick(BUYER_STOP_TIMEOUT_MS - BUYER_SHUTDOWN_DEADLINE_MS)
  assert.deepEqual(child.killed, ['SIGTERM', 'SIGKILL'])
  await stopped
})

test('hands the wallet passphrase to the buyer on stdin, not in its environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-buyer-process-'))
  try {
    const passphrase = 'correct horse battery'
    await new FileIdentityStore(dir, { passphrase }).save('66'.repeat(32))
    // Stands in for the CLI: what `buyer start` does with the passphrase first.
    const script = join(dir, 'buyer.mjs')
    writeFileSync(script, [
      `const { walletPassphraseForStart } = await import(${JSON.stringify(new URL('../cli/wallet-passphrase.js', import.meta.url).href)})`,
      `const inEnv = Object.entries(process.env).some(([, value]) => value?.includes(${JSON.stringify(passphrase)}))`,
      `const unlocked = await walletPassphraseForStart(process.argv[process.argv.indexOf('--data-dir') + 1])`,
      `console.log(JSON.stringify({ inEnv, unlocked }))`,
    ].join('\n'))
    process.env['ANTSEED_PASSPHRASE'] = passphrase
    const child = spawnCliBuyer(['--data-dir', dir], [script])
    let output = ''
    child.stdout!.on('data', (chunk) => { output += chunk })
    child.stderr!.on('data', (chunk) => { output += chunk })
    const code = await new Promise((resolve) => child.once('exit', resolve))
    assert.equal(code, 0, output)
    assert.deepEqual(JSON.parse(output), { inEnv: false, unlocked: passphrase })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
