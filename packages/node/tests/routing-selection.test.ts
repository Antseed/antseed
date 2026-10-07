import { describe, expect, it } from 'vitest';
import { isRoutingSelection } from '../src/routing/selection.js';

describe('explicit routing selection', () => {
  it('accepts model selection and an IRP cost/quality tradeoff alongside the selected service', () => {
    expect(isRoutingSelection({ kind: 'model', model: 'model-a' })).toBe(true);
    expect(isRoutingSelection({ kind: 'model', model: null })).toBe(true);
    expect(isRoutingSelection({ kind: 'router' })).toBe(true);
    expect(isRoutingSelection({ kind: 'router', service: { peerId: 'a'.repeat(40), provider: 'alpha', serviceId: 'alpha-route' }, costQualityTradeoff: 5 })).toBe(true);
    for (const costQualityTradeoff of [0, 10]) expect(isRoutingSelection({ kind: 'router', costQualityTradeoff })).toBe(true);
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

  it.each([null, [], { kind: 'other' }, { kind: 'model', model: '' }, { kind: 'model', model: null, preferences: {} }, { kind: 'router', preferences: { tradeoff: '5' } }, { kind: 'router', costQualityTradeoff: 11 }, { kind: 'router', costQualityTradeoff: 2.5 }, { kind: 'router', costQualityTradeoff: '5' }, { kind: 'router', service: { peerId: 'bad', provider: 'alpha', serviceId: 'route' } }])('rejects invalid selection %j', value => {
    expect(isRoutingSelection(value)).toBe(false);
  });
});
