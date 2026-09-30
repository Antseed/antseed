import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultRouteModel, modelDefaultRoute } from './buyer-default-route.js';

test('buyer default routes use typed model selections', () => {
  const peerId = 'a'.repeat(40);
  assert.deepEqual(modelDefaultRoute(peerId, 'model-a'), { kind: 'model', model: `${peerId}@model-a` });
  assert.deepEqual(modelDefaultRoute('', 'model-a'), { kind: 'model', model: 'model-a' });
  assert.equal(defaultRouteModel({ selection: { kind: 'model', model: ' model-a ' } }), 'model-a');
  assert.equal(defaultRouteModel({ selection: { kind: 'router', service: { peerId, provider: 'levanto', serviceId: 'route' } } }), '');
  assert.equal(defaultRouteModel({ model: 'legacy-model' }), '');
});
