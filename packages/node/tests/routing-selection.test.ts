import { describe, expect, it } from 'vitest';
import { isRoutingSelection } from '../src/routing/selection.js';

describe('explicit routing selection', () => {
  it('accepts model selection and generic router preferences alongside the selected service', () => {
    expect(isRoutingSelection({ kind: 'model', model: 'model-a' })).toBe(true);
    expect(isRoutingSelection({ kind: 'model', model: null })).toBe(true);
    expect(isRoutingSelection({ kind: 'router' })).toBe(true);
    expect(isRoutingSelection({ kind: 'router', service: { peerId: 'a'.repeat(40), provider: 'levanto', serviceId: 'levanto-route' }, preferences: { cqt: '5' } })).toBe(true);
  });

  it('validates bounded exact provider/model allowlists including an explicit empty list', () => {
    for (const allowedModels of [undefined, [], [{ provider: 'openai', serviceId: 'model-a' }]]) {
      expect(isRoutingSelection({ kind: 'router', allowedModels })).toBe(true);
    }
    for (const allowedModels of [null, 'all', ['model-a'], [null], [{ provider: '', serviceId: 'model-a' }],
      [{ provider: 'openai', serviceId: '' }], [{ provider: 'openai', serviceId: 'model-a', peerId: 'extra' }],
      Array.from({ length: 513 }, () => ({ provider: 'openai', serviceId: 'model-a' }))]) {
      expect(isRoutingSelection({ kind: 'router', allowedModels })).toBe(false);
    }
  });

  it.each([null, [], { kind: 'other' }, { kind: 'model', model: '' }, { kind: 'model', model: null, preferences: {} }, { kind: 'router', preferences: { cqt: 5 } }, { kind: 'router', service: { peerId: 'bad', provider: 'levanto', serviceId: 'route' } }])('rejects invalid selection %j', value => {
    expect(isRoutingSelection(value)).toBe(false);
  });
});
