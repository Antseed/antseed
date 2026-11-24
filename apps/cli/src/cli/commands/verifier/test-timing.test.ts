import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Command } from 'commander'
import { registerVerifierCommands } from './index.js'
import { verifierTestTiming } from './run.js'
import type { AntseedConfig } from '../../../config/types.js'

const TIMING = { sellerRetrySpacingSeconds: 60, confirmationMinDelaySeconds: 120 }
const config = (rpcUrl: string, testTiming: object | null = TIMING) => ({
  payments: { crypto: { chainId: 'base-mainnet', rpcUrl } },
  verifier: { ...(testTiming ? { testTiming } : {}) },
}) as unknown as AntseedConfig

test('verifierTestTiming: the config\'s test timing on a local RPC, a stop on any other, nothing without one', () => {
  assert.deepEqual(verifierTestTiming(config('http://127.0.0.1:8545')), TIMING)
  assert.throws(() => verifierTestTiming(config('https://mainnet.base.org')), /local fork only.*not mainnet\.base\.org/)
  // submit's --rpc-url (and watch's, which it passes on) is the one checked when given.
  assert.throws(() => verifierTestTiming(config('http://127.0.0.1:8545'), 'https://mainnet.base.org'), /not mainnet\.base\.org/)
  assert.deepEqual(verifierTestTiming(config('https://mainnet.base.org'), 'http://localhost:8545'), TIMING)
  assert.equal(verifierTestTiming(config('https://mainnet.base.org', null)), null)
})

test('run, watch and submit stop before any work when verifier.testTiming is set and the chain RPC is not on this machine', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-test-timing-'))
  try {
    const configPath = join(directory, 'config.json')
    await writeFile(configPath, JSON.stringify(config('https://mainnet.base.org')))
    const dataDir = join(directory, 'data')
    for (const step of [['run'], ['watch', '--once'], ['submit', '--yes']]) {
      const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
        .option('-c, --config <path>').option('--data-dir <path>')
      registerVerifierCommands(program)
      await assert.rejects(
        program.parseAsync(['--config', configPath, '--data-dir', dataDir, 'verifier', ...step, '--skip-version-check'], { from: 'user' }),
        /verifier\.testTiming is for a dry run on a local fork only.*not mainnet\.base\.org/,
        step[0],
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
