import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEpochList } from './rewards.js'

test('parses epoch lists and ranges into sorted unique epochs', () => {
  assert.deepEqual(parseEpochList('4, 2-3,2'), [2n, 3n, 4n])
  assert.throws(() => parseEpochList('3-1'), /invalid epoch range/)
  assert.throws(() => parseEpochList('x'), /invalid epoch/)
  assert.throws(() => parseEpochList(' , '), /at least one epoch/)
})
