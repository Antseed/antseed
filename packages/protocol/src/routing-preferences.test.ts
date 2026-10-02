import { describe, expect, it } from 'vitest';
import { assertRoutingPreferences, resolveRoutingPreferences, validateRoutingPreferenceSchema, type RoutingPreferenceSchema } from './routing-preferences.js';

const schema: RoutingPreferenceSchema = {
  policy: { options: ['quality', 'cost'], default: 'quality', title: 'Routing policy', description: 'Choose how requests are routed.' },
};

describe('router preferences', () => {
  it('uses router-defined defaults and options without modifying caller data', () => {
    const values = {};
    expect(resolveRoutingPreferences(schema, values)).toEqual({ policy: 'quality' });
    expect(values).toEqual({});
    expect(resolveRoutingPreferences(schema, { policy: 'cost' })).toEqual({ policy: 'cost' });
    expect(resolveRoutingPreferences({ tradeoff: { options: ['1', '3', '5'], default: '5' } })).toEqual({ tradeoff: '5' });
    expect(resolveRoutingPreferences({})).toEqual({});
  });

  it('leaves out settings with no value and no default', () => {
    expect(resolveRoutingPreferences({ policy: { options: ['quality', 'cost'] } })).toEqual({});
  });

  it.each([{ policy: 5 }, { policy: true }, { policy: 'other' }, { unknown: 'value' }, { policy: {} }, { policy: ['quality'] }, null, []])('rejects invalid preferences %j', values => {
    expect(() => resolveRoutingPreferences(schema, values)).toThrow();
  });

  it('rejects inherited keys as unknown settings', () => {
    expect(() => resolveRoutingPreferences(schema, JSON.parse('{"__proto__":"cost"}'))).toThrow('unknown preference');
    expect(() => resolveRoutingPreferences(schema, { toString: 'cost' })).toThrow('unknown preference');
  });

  it('rejects defaults that are not one of the options', () => {
    expect(() => validateRoutingPreferenceSchema({ policy: { ...schema.policy, default: 'unknown' } })).toThrow('default');
  });

  it.each([{ options: [1, 3] }, { options: [] }, { options: [' '] }, {}, null, 'cost', { options: ['cost'], type: 'string' }])('rejects malformed settings %j', field => {
    expect(() => validateRoutingPreferenceSchema({ policy: field })).toThrow('options');
  });

  it('rejects non-object preference lists', () => {
    for (const value of [null, [], 'x']) expect(() => validateRoutingPreferenceSchema(value)).toThrow();
    for (const value of [null, [], 'x', { policy: 1 }]) expect(() => assertRoutingPreferences(value)).toThrow();
  });
});
