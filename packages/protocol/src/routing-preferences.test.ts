import { describe, expect, it } from 'vitest';
import { assertRoutingPreferences, createRoutingServiceMetadata, resolveRoutingPreferences, validateRoutingPreferenceSchema, validateRoutingServiceMetadata, type RoutingPreferenceSchema } from './routing-preferences.js';

const schema: RoutingPreferenceSchema = {
  type: 'object', additionalProperties: false,
  properties: { policy: { type: 'string', enum: ['quality', 'cost'], default: 'quality', description: 'Routing policy' } },
};

describe('generic router enum preferences', () => {
  it('preserves router titles and descriptions without renaming wire keys', () => {
    const titled = { ...schema, properties: { policy: { ...schema.properties.policy!, title: 'Routing policy', description: 'Choose how requests are routed.' } } };
    const metadata = createRoutingServiceMetadata(titled);
    expect(() => validateRoutingServiceMetadata(metadata)).not.toThrow();
    expect(metadata.preferencesSchema).toEqual(titled);
    expect(resolveRoutingPreferences(titled, { policy: 'cost' })).toEqual({ policy: 'cost' });
    expect(metadata.preferencesSchemaHash).not.toBe(createRoutingServiceMetadata(schema).preferencesSchemaHash);
    metadata.preferencesSchema.properties.policy!.title = 'Changed title';
    expect(() => validateRoutingServiceMetadata(metadata)).toThrow('hash mismatch');
  });

  it.each(['', '  ', 5, null, {}])('rejects invalid titles %j', title => {
    expect(() => validateRoutingPreferenceSchema({ ...schema, properties: { policy: { ...schema.properties.policy, title } } })).toThrow('title');
  });

  it('uses router-defined defaults and choices without modifying caller data', () => {
    const values = {};
    expect(resolveRoutingPreferences(schema, values)).toEqual({ policy: 'quality' });
    expect(values).toEqual({});
    expect(resolveRoutingPreferences(schema, { policy: 'cost' })).toEqual({ policy: 'cost' });
    expect(resolveRoutingPreferences({ ...schema, properties: { cqt: { type: 'string', enum: ['1', '3', '5'], default: '5' } } })).toEqual({ cqt: '5' });
  });

  it.each([{ policy: 5 }, { policy: true }, { policy: 'other' }, { unknown: 'value' }, { policy: {} }, { policy: ['quality'] }])('rejects invalid preferences %j', values => {
    expect(() => resolveRoutingPreferences(schema, values)).toThrow();
  });

  it('validates required fields and schema defaults', () => {
    const required = { ...schema, properties: { policy: { type: 'string' as const, enum: ['quality', 'cost'] } }, required: ['policy'] };
    expect(() => resolveRoutingPreferences(required)).toThrow('Required');
    expect(() => validateRoutingPreferenceSchema({ ...schema, properties: { policy: { ...schema.properties.policy, default: 'unknown' } } })).toThrow();
    expect(() => validateRoutingPreferenceSchema({ ...schema, required: ['missing'] })).toThrow();
  });

  it.each([
    { type: 'number', enum: [1, 3] }, { type: 'string', enum: [] },
    { type: 'string', enum: ['cost', 'cost'] }, { type: 'string', enum: ['cost'], pattern: '.*' },
  ])('rejects unsupported schema fields %j', field => {
    expect(() => validateRoutingPreferenceSchema({ ...schema, properties: { policy: field } })).toThrow();
  });

  it('binds metadata to a canonical schema hash and snapshots the schema', () => {
    const metadata = createRoutingServiceMetadata(schema);
    expect(() => validateRoutingServiceMetadata(metadata)).not.toThrow();
    expect(createRoutingServiceMetadata({ properties: schema.properties, additionalProperties: false, type: 'object' }).preferencesSchemaHash).toBe(metadata.preferencesSchemaHash);
    metadata.preferencesSchema.properties.policy!.enum.push('other');
    expect(schema.properties.policy!.enum).toEqual(['quality', 'cost']);
    expect(() => validateRoutingServiceMetadata(metadata)).toThrow('hash mismatch');
  });

  it('rejects prototype keys and excessive payloads', () => {
    expect(() => assertRoutingPreferences(JSON.parse('{"__proto__":"cost"}'))).toThrow();
    expect(() => assertRoutingPreferences({ value: 'x'.repeat(17 * 1024) })).toThrow('16 KiB');
  });
});
