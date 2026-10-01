import { toUtf8Bytes } from 'ethers';

export type RoutingPreferences = Record<string, string>;
/** One router setting: a list of string options, with an optional label, description and default. */
export type RoutingPreferenceField = {
  options: string[];
  title?: string;
  description?: string;
  default?: string;
};
/** Router settings advertised by describe, keyed by the name sent back in `preferences`. */
export type RoutingPreferenceSchema = Record<string, RoutingPreferenceField>;
export const MAX_ROUTING_PREFERENCE_BYTES = 16 * 1024;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function canonicalRoutingJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('Routing JSON nesting limit exceeded');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalRoutingJson(entry, depth + 1)).join(',')}]`;
  if (!object(value)) throw new Error('Expected routing JSON value');
  return `{${Object.keys(value).sort().map((key) => {
    if (forbiddenKeys.has(key)) throw new Error(`Forbidden routing key: ${key}`);
    return `${JSON.stringify(key)}:${canonicalRoutingJson(value[key], depth + 1)}`;
  }).join(',')}}`;
}

function bounded(value: unknown): void {
  if (toUtf8Bytes(canonicalRoutingJson(value)).length > MAX_ROUTING_PREFERENCE_BYTES) throw new Error('Routing preferences/schema exceed 16 KiB');
}

export function assertRoutingPreferences(value: unknown): asserts value is RoutingPreferences {
  if (!object(value) || Object.values(value).some(entry => typeof entry !== 'string')) throw new Error('Routing preferences must be a flat object of string choices');
  bounded(value);
}

export function validateRoutingPreferenceSchema(value: unknown): asserts value is RoutingPreferenceSchema {
  bounded(value);
  if (!object(value)) throw new Error('Routing preferences must be an object of settings');
  for (const [key, field] of Object.entries(value)) {
    if (!key.trim() || forbiddenKeys.has(key) || !object(field)
      || Object.keys(field).some(name => !['options', 'title', 'description', 'default'].includes(name))
      || !Array.isArray(field.options) || field.options.length === 0
      || field.options.some(choice => typeof choice !== 'string' || !choice.trim())
      || new Set(field.options).size !== field.options.length) throw new Error('preferences.' + key + ': expected unique nonempty string options');
    if (own(field, 'title') && (typeof field.title !== 'string' || !field.title.trim())) throw new Error('Preference title must be a nonempty string');
    if (own(field, 'description') && typeof field.description !== 'string') throw new Error('Preference description must be a string');
    if (own(field, 'default') && !field.options.includes(field.default as string)) throw new Error('Preference default must be one of its options');
  }
}

export function resolveRoutingPreferences(schema: RoutingPreferenceSchema, values: unknown = {}): RoutingPreferences {
  validateRoutingPreferenceSchema(schema);
  assertRoutingPreferences(values);
  const result: RoutingPreferences = {};
  for (const key of Object.keys(values)) if (!own(schema, key)) throw new Error('preferences.' + key + ': unknown preference');
  for (const [key, field] of Object.entries(schema)) {
    const selected = own(values, key) ? values[key] : field.default;
    if (selected === undefined) continue;
    if (!field.options.includes(selected)) throw new Error('preferences.' + key + ': invalid option');
    result[key] = selected;
  }
  assertRoutingPreferences(result);
  return result;
}
