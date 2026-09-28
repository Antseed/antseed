import assert from 'node:assert/strict'
import test from 'node:test'
import { ResourceRoutes } from './resource-routes.js'

test('video routes survive restart and expire after 30 days', () => {
  let now = 1_000
  const routes = new ResourceRoutes(() => now)
  routes.record({ protocol: 'seedance-video', resourceId: 'task-1', sellerPeerId: 'a'.repeat(40), provider: 'seedance', service: 'seedance-2-0' })
  const restored = new ResourceRoutes(() => now)
  restored.hydrate(JSON.parse(JSON.stringify(routes.snapshot())))
  assert.equal(restored.resolve('seedance-video', 'task-1')?.sellerPeerId, 'a'.repeat(40))
  assert.equal(restored.resolve('veo-video', 'task-1'), null)
  now += 31 * 24 * 60 * 60_000
  assert.equal(restored.resolve('seedance-video', 'task-1'), null)
})

test('persisted routes for removed video providers are ignored', () => {
  const routes = new ResourceRoutes(() => 1_000)
  routes.hydrate(['runway', 'minimax', 'wan'].map(provider => ({
    protocol: `${provider}-video`, resourceId: 'task', sellerPeerId: 'a'.repeat(40), provider, service: 'video-model', createdAt: 1_000,
  })))
  assert.deepEqual(routes.snapshot(), [])
})
