import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KBF_CALIBRATION_METHOD,
  KBF_DEFAULT_PROMPT_VARIANT_ID,
  aggregateKbfSelfTestOutcomes,
  computeReferenceId,
  kbfCalibrationPower,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import { describe, expect, it } from 'vitest'
import { loadReference } from '../src/reference.js'
import { testReference } from './fixtures.js'

/** `testReference(100)` calibrated in one pass of ten batches, with the first `misses` answers wrong. */
function calibrated(misses: number): KbfReferenceV1 {
  const value = testReference(100)
  const outcomes = value.probes.map((probe, index) => {
    const miss = index < misses
    return { probeId: probe.id, answers: [miss ? probe.consensus + 7 : probe.consensus], matches: [miss ? 0 as const : 1 as const] }
  })
  value.calibration = {
    version: 1,
    method: KBF_CALIBRATION_METHOD,
    passes: 1,
    ...aggregateKbfSelfTestOutcomes(outcomes),
    batches: Array.from({ length: 10 }, (_unused, batchIndex) => ({
      pass: 0,
      batchIndex,
      probeIds: value.probes.slice(batchIndex * 10, (batchIndex + 1) * 10).map((probe) => probe.id),
      promptVariantId: KBF_DEFAULT_PROMPT_VARIANT_ID,
      attempts: 1,
    })),
    calibratedAt: '2026-11-05T00:00:00.000Z',
  }
  value.referenceId = computeReferenceId(value)
  return value
}

async function written(reference: KbfReferenceV1): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'model-verifier-')), 'reference.json')
  await writeFile(path, JSON.stringify(reference))
  return path
}

describe('loadReference', () => {
  it('loads and validates a reference file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'model-verifier-'))
    const path = join(dir, 'reference.json')
    const reference = testReference()
    await writeFile(path, JSON.stringify(reference))
    await expect(loadReference(path)).resolves.toMatchObject({ referenceId: reference.referenceId })
  })

  it('refuses a reference whose calibration missed every question, so no audit on it could be DIFF', async () => {
    const reference = calibrated(100)
    expect(reference.statisticalPower).toBeGreaterThanOrEqual(0.9)
    await expect(loadReference(await written(reference))).rejects.toThrow(/power on the calibration is 0\.000/)
  })

  it('still loads a published epoch set whose calibration gives less than the full power', async () => {
    const reference = calibrated(4)
    expect(kbfCalibrationPower(reference)).toBeLessThan(0.9)
    await expect(loadReference(await written(reference))).resolves.toMatchObject({ referenceId: reference.referenceId })
  })

  it('rejects a reference whose content no longer matches its id', async () => {
    const reference = testReference()
    reference.probes[0]!.consensus = 99
    const fetchImpl = (async () => new Response(JSON.stringify(reference))) as unknown as typeof fetch
    await expect(loadReference('https://refs.example.test/r.json', { fetchImpl })).rejects.toThrow()
  })
})
