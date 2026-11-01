import assert from 'node:assert/strict'
import test from 'node:test'
import { Command } from 'commander'
import { parseWatchInterval, registerVerifierWatchCommand, resolveWatchAuditor, runWatchLoop, watchStepArgs, type WatchStep } from './watch.js'

const GLOBALS = { config: '/cfg/config.json', dataDir: '/data', verbose: false }

test('watch runs then submits every tick, keeps going after a failed step, and stops when aborted', async () => {
  const controller = new AbortController()
  const steps: string[] = []
  const sleeps: number[] = []
  const codes: Record<WatchStep, number[]> = { run: [1, 0, 0], submit: [0, 1, 0] }
  const logs: string[] = []
  const ticks = await runWatchLoop({
    intervalMs: 600_000,
    once: false,
    signal: controller.signal,
    log: (line) => logs.push(line),
    step: async (step) => {
      steps.push(step)
      return codes[step].shift() ?? 0
    },
    sleep: async (ms) => {
      sleeps.push(ms)
      if (sleeps.length === 3) controller.abort()
    },
  })
  assert.equal(ticks, 3)
  assert.deepEqual(steps, ['run', 'submit', 'run', 'submit', 'run', 'submit'])
  assert.deepEqual(sleeps, [600_000, 600_000, 600_000])
  assert.equal(logs.filter((line) => /exited with 1/.test(line)).length, 2)
})

test('watch --once runs one tick without sleeping', async () => {
  const steps: string[] = []
  const ticks = await runWatchLoop({
    intervalMs: 60_000,
    once: true,
    signal: new AbortController().signal,
    log: () => {},
    step: async (step) => { steps.push(step); return 0 },
    sleep: async () => { throw new Error('no sleep with --once') },
  })
  assert.equal(ticks, 1)
  assert.deepEqual(steps, ['run', 'submit'])
})

test('an abort during run skips that tick\'s submit', async () => {
  const controller = new AbortController()
  const steps: string[] = []
  await runWatchLoop({
    intervalMs: 60_000,
    once: false,
    signal: controller.signal,
    log: () => {},
    step: async (step) => { steps.push(step); controller.abort(); return 130 },
    sleep: async () => {},
  })
  assert.deepEqual(steps, ['run'])
})

test('each step forwards the global options and only its own flags', () => {
  const options = {
    interval: '10', auditor: '0xabc', keystore: '~/ks', rpcUrl: 'http://rpc', publishIpfs: false,
    maxEnrollmentRequests: '400', skipVersionCheck: true,
  }
  assert.deepEqual(watchStepArgs('run', GLOBALS, options), [
    '--data-dir', '/data', '--config', '/cfg/config.json', 'verifier', 'run',
    '--skip-version-check', '--auditor', '0xabc', '--max-enrollment-requests', '400',
  ])
  assert.deepEqual(watchStepArgs('submit', { ...GLOBALS, verbose: true }, options), [
    '--data-dir', '/data', '--config', '/cfg/config.json', '--verbose', 'verifier', 'submit',
    '--skip-version-check', '--yes', '--no-publish-ipfs', '--keystore', '~/ks', '--rpc-url', 'http://rpc',
  ])
  assert.deepEqual(watchStepArgs('submit', GLOBALS, { interval: '10' }), [
    '--data-dir', '/data', '--config', '/cfg/config.json', 'verifier', 'submit', '--yes',
  ])
})

test('a keystore given to watch decides the auditor the run step plans for', async () => {
  const addressOf = async (keystore: string) => `address-of:${keystore}`
  assert.equal(await resolveWatchAuditor({ keystore: '~/ks' }, addressOf), 'address-of:~/ks')
  assert.equal(await resolveWatchAuditor({ keystore: '~/ks', auditor: '0xabc' }, addressOf), '0xabc', '--auditor wins')
  assert.equal(await resolveWatchAuditor({}, addressOf), undefined, 'run resolves verifier.keystore or the data-dir identity itself')
  const auditor = await resolveWatchAuditor({ keystore: '~/ks' }, addressOf)
  assert.deepEqual(watchStepArgs('run', GLOBALS, { interval: '10', keystore: '~/ks', auditor }).slice(-2), ['--auditor', 'address-of:~/ks'])
})

test('the interval is in minutes and at least one', () => {
  assert.equal(parseWatchInterval('10'), 600_000)
  assert.equal(parseWatchInterval('1.5'), 90_000)
  assert.throws(() => parseWatchInterval('0'), /at least 1 minute/)
  assert.throws(() => parseWatchInterval('soon'), /at least 1 minute/)
})

test('watch registers its options', () => {
  const verifier = new Command('verifier')
  registerVerifierWatchCommand(verifier)
  const watch = verifier.commands.find((command) => command.name() === 'watch')!
  assert.deepEqual(watch.options.map((option) => option.long), [
    '--interval', '--once', '--auditor', '--keystore', '--rpc-url', '--no-publish-ipfs', '--max-enrollment-requests', '--skip-version-check',
  ])
})
