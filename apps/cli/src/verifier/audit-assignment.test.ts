import assert from 'node:assert/strict'
import test from 'node:test'
import { assignAuditModels } from './audit-assignment.js'

const AUDITOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'

test('assigns every available model, deduplicated and sorted, with a checksummed auditor', () => {
  const assignment = assignAuditModels({
    auditor: ` ${AUDITOR} `,
    epoch: '42',
    availableModels: ['model-b', 'model-a', 'MODEL-A', ' '],
  })
  assert.deepEqual(assignment, {
    auditor: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    epoch: '42',
    strategy: 'all',
    models: ['model-a', 'model-b'],
  })
})

test('assignment is deterministic for the same auditor and epoch', () => {
  const input = { auditor: AUDITOR, epoch: '7', availableModels: ['c', 'a', 'b'] }
  assert.deepEqual(assignAuditModels(input), assignAuditModels({ ...input, availableModels: ['b', 'c', 'a'] }))
})

test('rejects an invalid auditor address or an empty epoch', () => {
  assert.throws(() => assignAuditModels({ auditor: 'not-an-address', epoch: '1', availableModels: [] }))
  assert.throws(() => assignAuditModels({ auditor: AUDITOR, epoch: ' ', availableModels: [] }), /epoch/)
})
