import assert from 'node:assert/strict'
import test from 'node:test'
import { Command } from 'commander'
import { NEXT_EPOCH_GRACE_SECONDS, nextWatchTickDelayMs, parseWatchInterval, registerVerifierWatchCommand, resolveWatchAuditor, runWatchLoop, unlockWatchKeystore, watchStepArgs, type WatchStep } from './watch.js'

const GLOBALS = { config: '/cfg/config.json', dataDir: '/data', verbose: false }

test('watch runs then submits every tick, keeps going after a failed step, and stops when aborted', async () => {
  const controller = new AbortController()
  const steps: string[] = []
  const sleeps: number[] = []
  const codes: Record<WatchStep, number[]> = { run: [1, 0, 0], submit: [0, 1, 0] }
  const logs: string[] = []
  const { ticks } = await runWatchLoop({
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
  const { ticks, failed } = await runWatchLoop({
    intervalMs: 60_000,
    once: true,
    signal: new AbortController().signal,
    log: () => {},
    step: async (step) => { steps.push(step); return 0 },
    sleep: async () => { throw new Error('no sleep with --once') },
  })
  assert.equal(ticks, 1)
  assert.deepEqual(steps, ['run', 'submit'])
  assert.deepEqual(failed, [])
})

test('watch --once reports a failed submit, so the command exits non-zero', async () => {
  const logs: string[] = []
  const { failed } = await runWatchLoop({
    intervalMs: 60_000,
    once: true,
    signal: new AbortController().signal,
    log: (line) => logs.push(line),
    step: async (step) => (step === 'submit' ? 1 : 0),
    sleep: async () => { throw new Error('no sleep with --once') },
  })
  assert.deepEqual(failed, ['submit'])
  assert.ok(logs.some((line) => /verifier submit exited with 1/.test(line)))
  assert.ok(!logs.some((line) => /next tick/.test(line)), 'there is no next tick to promise')
})

test('a continuous watch reports only the last tick\'s failures', async () => {
  const controller = new AbortController()
  const codes: Record<WatchStep, number[]> = { run: [0, 0], submit: [1, 0] }
  const { ticks, failed } = await runWatchLoop({
    intervalMs: 60_000,
    once: false,
    signal: controller.signal,
    log: () => {},
    step: async (step) => codes[step].shift() ?? 0,
    sleep: async () => { if (codes.submit.length === 1) return; controller.abort() },
  })
  assert.equal(ticks, 2)
  assert.deepEqual(failed, [])
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
  // Nothing given: the tick's run uses run's own defaults (3 rounds, 2000 requests per build).
  assert.deepEqual(watchStepArgs('run', GLOBALS, { interval: '10', enroll: true, confirm: true }), [
    '--data-dir', '/data', '--config', '/cfg/config.json', 'verifier', 'run',
  ])
  assert.deepEqual(watchStepArgs('run', GLOBALS, {
    interval: '10', maxRounds: '5', ignorePreRunChecks: true, enroll: false, confirm: false,
  }), [
    '--data-dir', '/data', '--config', '/cfg/config.json', 'verifier', 'run',
    '--no-enroll', '--ignore-pre-run-checks', '--max-rounds', '5', '--no-confirm',
  ])
  assert.deepEqual(watchStepArgs('submit', { ...GLOBALS, verbose: true }, options), [
    '--data-dir', '/data', '--config', '/cfg/config.json', '--verbose', 'verifier', 'submit',
    '--skip-version-check', '--yes', '--no-publish-ipfs', '--keystore', '~/ks', '--rpc-url', 'http://rpc',
  ])
  assert.deepEqual(watchStepArgs('submit', GLOBALS, { interval: '10' }), [
    '--data-dir', '/data', '--config', '/cfg/config.json', 'verifier', 'submit', '--yes',
  ])
})

test('watch unlocks the keystore at start: a wrong password or another auditor stops it at once', async () => {
  const signer = '0x1000000000000000000000000000000000000001'
  const unlocked = async () => ({ address: signer.toUpperCase().replace('0X', '0x') })
  assert.equal(await unlockWatchKeystore('~/ks', {}, unlocked), signer)
  assert.equal(await unlockWatchKeystore('~/ks', { auditor: signer, configAuditor: signer }, unlocked), signer)
  await assert.rejects(
    unlockWatchKeystore('~/ks', {}, async () => { throw new Error('incorrect password') }),
    /could not unlock the keystore ~\/ks \(incorrect password\); check the password/,
  )
  const other = '0x2000000000000000000000000000000000000002'
  await assert.rejects(unlockWatchKeystore('~/ks', { auditor: other }, unlocked), /--auditor 0x2000.* does not match the keystore ~\/ks, which signs as 0x1000/)
  await assert.rejects(unlockWatchKeystore('~/ks', { configAuditor: other }, unlocked), /verifier\.auditor 0x2000.* does not match/)
})

test('a keystore given to watch decides the auditor the run step plans for', async () => {
  const signer = '0x1000000000000000000000000000000000000001'
  assert.equal(resolveWatchAuditor({ keystore: '~/ks' }, signer), signer)
  assert.equal(resolveWatchAuditor({ keystore: '~/ks', auditor: '0xabc' }, signer), '0xabc', '--auditor wins')
  assert.equal(resolveWatchAuditor({}, undefined), undefined, 'run resolves verifier.keystore or the data-dir identity itself')
  const auditor = resolveWatchAuditor({ keystore: '~/ks' }, signer)
  assert.deepEqual(watchStepArgs('run', GLOBALS, { interval: '10', keystore: '~/ks', auditor }).slice(-2), ['--auditor', signer])
  assert.ok(!watchStepArgs('run', GLOBALS, { interval: '10' }).includes('--max-rounds'), 'run\'s own rounds by default')
})

test('the next tick waits the interval, or until just after the epoch ends when that is sooner', () => {
  const interval = 10 * 60_000
  assert.equal(nextWatchTickDelayMs(interval, 10_000, 10_000 - 3_600), interval)
  assert.equal(nextWatchTickDelayMs(interval, 10_000, 10_000 - 120), (120 + NEXT_EPOCH_GRACE_SECONDS) * 1_000)
  assert.equal(nextWatchTickDelayMs(interval, 10_000, 10_000 + 600), interval, 'an epoch that already ended: the interval')
})

test('watch waits the delay it is given between ticks', async () => {
  const controller = new AbortController()
  const sleeps: number[] = []
  await runWatchLoop({
    intervalMs: 600_000, once: false, signal: controller.signal, log: () => undefined,
    step: async () => 0,
    nextDelayMs: async () => 150_000,
    sleep: async (ms) => { sleeps.push(ms); controller.abort() },
  })
  assert.deepEqual(sleeps, [150_000])
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
    '--interval', '--once', '--auditor', '--keystore', '--rpc-url', '--no-publish-ipfs', '--skip-version-check',
    // run's tuning options, without watch-side defaults, so run's own defaults apply
    '--no-enroll', '--max-enrollment-requests', '--ignore-pre-run-checks', '--max-rounds', '--no-confirm',
  ])
  assert.equal(watch.options.find((option) => option.long === '--max-rounds')!.defaultValue, undefined)
})
