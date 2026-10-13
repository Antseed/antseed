import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import type { ChildProcess } from 'node:child_process'
import { BUYER_RESTART_EXIT_CODE } from '../proxy/buyer-proxy.js'
import { GatewayBuyer } from './buyer-process.js'

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
