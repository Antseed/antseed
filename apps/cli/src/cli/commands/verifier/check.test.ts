import assert from 'node:assert/strict'
import test from 'node:test'
import type { ModelAuditedEvent } from '@antseed/node/payments'
import { createCheckEndpoint, latestPublishedAudit } from './check.js'

function event(blockNumber: number, logIndex: number, evidenceUri: string): ModelAuditedEvent {
  return {
    modelHash: `0x${'1'.repeat(64)}`,
    auditor: '0x0000000000000000000000000000000000000001',
    epoch: 1n,
    evidenceHash: `0x${'2'.repeat(64)}`,
    evidenceUri,
    resultCount: 1,
    blockNumber,
    logIndex,
    transactionHash: `0x${'3'.repeat(64)}`,
  }
}

test('latestPublishedAudit picks the newest audit that published evidence to IPFS', () => {
  const latest = latestPublishedAudit([
    event(10, 1, 'ipfs://older'),
    event(12, 0, 'ipfs://newer'),
    event(12, 3, 'ipfs://newest'),
    event(20, 0, ''),
  ])
  assert.equal(latest?.evidenceUri, 'ipfs://newest')
  assert.equal(latestPublishedAudit([event(5, 0, '')]), null)
})

test('createCheckEndpoint supports openai and anthropic protocols only', () => {
  assert.equal(createCheckEndpoint('openai', 'https://api.example.test/v1', 'key').label.includes('api.example.test'), true)
  assert.ok(createCheckEndpoint('anthropic', 'https://api.example.test/v1', undefined))
  assert.throws(() => createCheckEndpoint('grpc', 'https://api.example.test/v1', undefined), /unsupported --protocol/)
})
