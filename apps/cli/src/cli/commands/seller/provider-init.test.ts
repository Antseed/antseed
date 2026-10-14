import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Provider } from '@antseed/node'
import { initializeProvider } from './provider-init.js'

function makeProvider(error?: Error): Provider {
  return {
    name: 'test',
    services: ['test-model'],
    maxConcurrency: 1,
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    async init() {
      if (error) throw error
    },
    getCapacity: () => ({ current: 0, max: 1 }),
    async handleRequest(request) {
      return { requestId: request.requestId, statusCode: 200, headers: {}, body: new Uint8Array() }
    },
  }
}

function authFailure(): Error {
  return Object.assign(new Error('OAuth refresh failed (401)'), { code: 'ANTSEED_OAUTH_REFRESH_FAILED' })
}

describe('provider initialization isolation', () => {
  it('retains an unavailable provider without preventing another provider from initializing', async () => {
    const failed = makeProvider(authFailure())
    const healthy = makeProvider()
    assert.equal(await initializeProvider(failed, true), false)
    assert.equal(failed.healthCheckAvailable, false)
    assert.deepEqual(failed.services, ['test-model'])
    assert.equal(await initializeProvider(healthy, true), true)
    assert.notEqual(healthy.healthCheckAvailable, false)
  })

  it('does not suppress configuration or programming errors', async () => {
    await assert.rejects(initializeProvider(makeProvider(new Error('bad config')), true), /bad config/)
  })

  it('fails explicitly if recovery health checks have been disabled', async () => {
    await assert.rejects(initializeProvider(makeProvider(authFailure()), false), /OAuth refresh failed/)
  })
})
