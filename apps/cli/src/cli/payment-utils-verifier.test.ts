import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { VerifierClient } from '@antseed/node/payments'
import type { AntseedConfig } from '../config/types.js'
import { createVerifierClient, useVerifierEventCache } from './payment-utils.js'

test('the verifier client\'s cache messages go to stderr, so a JSON command\'s stdout stays JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-verifier-client-'))
  const prototype = VerifierClient.prototype as unknown as Record<string, unknown>
  const saved = { latestBlockNumber: prototype['latestBlockNumber'], queryServiceAudits: prototype['queryServiceAudits'] }
  const log = console.log
  const error = console.error
  const stdout: string[] = []
  const stderr: string[] = []
  try {
    // A cold cache over a long history: the first read says it is scanning.
    prototype['latestBlockNumber'] = async () => 500_000
    prototype['queryServiceAudits'] = async () => []
    console.log = (...args: unknown[]) => { stdout.push(args.join(' ')) }
    console.error = (...args: unknown[]) => { stderr.push(args.join(' ')) }
    useVerifierEventCache(dir)
    const client = createVerifierClient({
      payments: {
        crypto: {
          chainId: 'base-local', rpcUrl: 'http://127.0.0.1:1',
          verificationContractAddress: '0x0000000000000000000000000000000000000001', verificationDeployBlock: 1,
        },
      },
    } as unknown as AntseedConfig)
    await client.queryServiceAudits(null, null, 1, 'latest')
  } finally {
    console.log = log
    console.error = error
    Object.assign(prototype, saved)
    await rm(dir, { recursive: true, force: true })
  }
  assert.deepEqual(stdout, [])
  assert.ok(stderr.some((line) => /first read of this data dir/.test(line)), stderr.join('\n'))
})
