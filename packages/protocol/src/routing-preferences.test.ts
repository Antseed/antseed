import { describe, expect, it } from 'vitest';
import { assertRoutingPreferences, resolveRoutingPreferences, validateRoutingPreferenceSchema, type RoutingPreferenceSchema } from './routing-preferences.js';

const schema: RoutingPreferenceSchema = {
  policy: { options: ['quality', 'cost'], default: 'quality', description: 'Routing policy' },
};

describe('router preferences', () => {
  it('preserves router titles and descriptions without renaming wire keys', () => {
    const titled = { policy: { ...schema.policy!, title: 'Routing policy', description: 'Choose how requests are routed.' } };
    expect(() => validateRoutingPreferenceSchema(titled)).not.toThrow();
    expect(resolveRoutingPreferences(titled, { policy: 'cost' })).toEqual({ policy: 'cost' });
  });

  it.each(['', '  ', 5, null, {}])('rejects invalid titles %j', title => {
    expect(() => validateRoutingPreferenceSchema({ policy: { ...schema.policy, title } })).toThrow('title');
  });

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

  it.each([{ policy: 5 }, { policy: true }, { policy: 'other' }, { unknown: 'value' }, { policy: {} }, { policy: ['quality'] }])('rejects invalid preferences %j', values => {
    expect(() => resolveRoutingPreferences(schema, values)).toThrow();
  });

  it('rejects defaults that are not one of the options', () => {
    expect(() => validateRoutingPreferenceSchema({ policy: { ...schema.policy, default: 'unknown' } })).toThrow('default');
  });

  it.each([
    { options: [1, 3] }, { options: [] }, { options: ['cost', 'cost'] }, { options: [' '] }, {},
    { options: ['cost'], type: 'string' }, { options: ['cost'], enum: ['cost'] }, { options: ['cost'], pattern: '.*' },
  ])('rejects malformed or unsupported settings %j', field => {
    expect(() => validateRoutingPreferenceSchema({ policy: field })).toThrow();
  });

  it('rejects non-object preference lists', () => {
    for (const value of [null, [], 'x', { policy: 'cost' }]) expect(() => validateRoutingPreferenceSchema(value)).toThrow();
  });

  it('rejects prototype keys and excessive payloads', () => {
    expect(() => assertRoutingPreferences(JSON.parse('{"__proto__":"cost"}'))).toThrow();
    expect(() => validateRoutingPreferenceSchema(JSON.parse('{"__proto__":{"options":["a"]}}'))).toThrow();
    expect(() => assertRoutingPreferences({ value: 'x'.repeat(17 * 1024) })).toThrow('16 KiB');
  });
});
