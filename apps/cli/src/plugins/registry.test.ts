import assert from 'node:assert/strict'
import test from 'node:test'
import { TRUSTED_PLUGINS, TRUSTED_PROVIDER_PLUGINS, TRUSTED_ROUTER_PLUGINS, TRUSTED_VERIFIER_PLUGINS, resolvePluginPackage } from './registry.js'

test('trusted plugin registry keeps typed lists and verifier invariants', () => {
  assert.deepEqual(TRUSTED_PLUGINS, [
    ...TRUSTED_PROVIDER_PLUGINS,
    ...TRUSTED_ROUTER_PLUGINS,
    ...TRUSTED_VERIFIER_PLUGINS,
  ])
  assert.ok(TRUSTED_PROVIDER_PLUGINS.every((p) => p.type === 'provider'))
  assert.ok(TRUSTED_ROUTER_PLUGINS.every((p) => p.type === 'router'))
  assert.ok(TRUSTED_VERIFIER_PLUGINS.every((p) => p.type === 'verifier'))
  const verifiers = TRUSTED_PLUGINS.filter((p) => p.type === 'verifier')
  assert.ok(verifiers.length > 0, 'expected a curated verifier')
  for (const v of verifiers) {
    assert.match(v.version ?? '', /^\d+\.\d+\.\d+/, `verifier ${v.name} must pin a locked binary version`)
  }
  assert.ok(TRUSTED_PLUGINS.filter((p) => p.type === 'provider').every((p) => !p.version))
  assert.equal(TRUSTED_PLUGINS.some((p) => p.name === 'antseed/noop' || p.package === '@antseed/verifier-noop'), false)
  assert.equal(resolvePluginPackage('antseed-verifier'), '@antseed/antseed-verifier')
})
