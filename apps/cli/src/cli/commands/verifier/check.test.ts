import assert from 'node:assert/strict'
import test from 'node:test'
import { createCheckEndpoint } from './check.js'

test('createCheckEndpoint supports openai and anthropic protocols only', () => {
  assert.equal(createCheckEndpoint('openai', 'https://api.example.test/v1', 'key').label.includes('api.example.test'), true)
  assert.ok(createCheckEndpoint('anthropic', 'https://api.example.test/v1', undefined))
  assert.throws(() => createCheckEndpoint('grpc', 'https://api.example.test/v1', undefined), /unsupported --protocol/)
})
