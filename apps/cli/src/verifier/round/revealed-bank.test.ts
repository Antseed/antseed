import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { referenceFixture } from '../model-audit-fixtures.test-support.js'
import { ZERO_HASH, type KbfEpochInfo } from '@antseed/node/payments'
import { loadRevealedBankReference } from './revealed-bank.js'
import { contentHash, sealBank } from './sealing.js'
import { DirectoryRoundStorage } from './storage.js'
import type { EpochBankV1 } from './types.js'
import { encodeRoundFile } from './encoding.js'

test('check reads the newest revealed bank that includes the model, verified against its on-chain hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'revealed-bank-'))
  try {
    const storage = new DirectoryRoundStorage(dir)
    const banks = new Map<bigint, { info: Partial<KbfEpochInfo>; uri: string }>()
    const publish = async (epoch: bigint, models: string[], reveal: boolean) => {
      const bank: EpochBankV1 = {
        kind: 'antseed-kbf-epoch-bank', version: 1, epoch: epoch.toString(),
        models: Object.fromEntries(models.map((model) => [model, referenceFixture(model, 40)])),
      }
      const sealed = sealBank(encodeRoundFile(bank))
      const uri = await storage.put(sealed.blob)
      banks.set(epoch, { uri, info: { bankHash: contentHash(sealed.blob), bankKey: reveal ? sealed.key : ZERO_HASH } })
    }
    await publish(10n, ['model-a', 'model-b'], true)
    await publish(11n, ['model-a'], true)
    await publish(12n, ['model-a', 'model-b'], false) // collection still running: key not revealed
    const client = {
      currentEpoch: async () => 12n,
      epochInfo: async (epoch: bigint) => ({ bankHash: ZERO_HASH, bankKey: ZERO_HASH, ...banks.get(epoch)?.info }) as KbfEpochInfo,
      bankCommits: async (epoch: bigint) => {
        const entry = banks.get(epoch)
        return entry ? [{ epoch, bankHash: entry.info.bankHash!, bankKeyHash: ZERO_HASH, bankUri: entry.uri, blockNumber: 1 }] : []
      },
    }

    const latestA = await loadRevealedBankReference({ client, storage, model: 'MODEL-A' })
    assert.equal(latestA.epoch, 11n)
    assert.equal(latestA.reference.referenceId, referenceFixture('model-a', 40).referenceId)
    const latestB = await loadRevealedBankReference({ client, storage, model: 'model-b' })
    assert.equal(latestB.epoch, 10n)
    await assert.rejects(loadRevealedBankReference({ client, storage, model: 'model-b', epoch: 12n }), /epoch 12 has no revealed/)
    await assert.rejects(loadRevealedBankReference({ client, storage, model: 'model-z' }), /no revealed question bank/)

    // A revealed key that does not open its bank is skipped, not fatal.
    banks.get(11n)!.info.bankKey = `0x${'11'.repeat(32)}`
    assert.equal((await loadRevealedBankReference({ client, storage, model: 'model-a' })).epoch, 10n)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
