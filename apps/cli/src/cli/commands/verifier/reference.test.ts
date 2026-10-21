import assert from 'node:assert/strict'
import test from 'node:test'
import { referenceBuildSkipReason } from './reference.js'

test('all-model reference builds skip reusable powered banks', () => {
  const powered = {
    totalProbeCount: 340,
    eligibleProbeCount: 340,
    selectedProbeCount: 100,
    statisticalPower: 0.95,
  }
  assert.equal(
    referenceBuildSkipReason(true, powered),
    'powered bank available: 100/340 probes, power 0.950',
  )
  assert.equal(referenceBuildSkipReason(false, powered), undefined)
  assert.equal(referenceBuildSkipReason(true, { ...powered, selectedProbeCount: null }), undefined)
})
