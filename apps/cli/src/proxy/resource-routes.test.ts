import assert from 'node:assert/strict'
import test from 'node:test'
import { ResourceRoutes } from './resource-routes.js'

test('Venice video routes survive restart and expire after 30 days', () => {
  let now = 1_000
  const routes = new ResourceRoutes(() => now)
  routes.record({ protocol: 'venice-video', resourceId: 'task-1', sellerPeerId: 'a'.repeat(40), provider: 'venice', service: 'wan-2.5' })
  const restored = new ResourceRoutes(() => now)
  restored.hydrate(JSON.parse(JSON.stringify(routes.snapshot())))
  assert.equal(restored.resolve('venice-video', 'task-1')?.sellerPeerId, 'a'.repeat(40))
  now += 31 * 24 * 60 * 60_000
  assert.equal(restored.resolve('venice-video', 'task-1'), null)
})

test('persisted routes for removed video providers are ignored', () => {
  const routes = new ResourceRoutes(() => 1_000)
  routes.hydrate(['veo', 'runway', 'minimax', 'wan'].map(provider => ({
    protocol: `${provider}-video`, resourceId: 'task', sellerPeerId: 'a'.repeat(40), provider, service: 'video-model', createdAt: 1_000,
  })))
  assert.deepEqual(routes.snapshot(), [])
})
