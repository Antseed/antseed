import { sha256, toUtf8Bytes } from 'ethers';

export type RoutingPreferences = Record<string, string>;
export type RoutingPreferenceField = {
  type: 'string';
  enum: string[];
  title?: string;
  description?: string;
  default?: string;
};
export type RoutingPreferenceSchema = {
  type: 'object';
  properties: Record<string, RoutingPreferenceField>;
  additionalProperties: false;
  required?: string[];
};
export type RoutingServiceMetadataV1 = {
  version: 1;
  preferencesSchema: RoutingPreferenceSchema;
  preferencesSchemaHash: string;
};
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
  if (!object(value) || value.type !== 'object' || !object(value.properties) || value.additionalProperties !== false
    || Object.keys(value).some(key => !['type', 'properties', 'additionalProperties', 'required'].includes(key))) throw new Error('Routing preferences require a flat object schema with additionalProperties: false');
  for (const [key, field] of Object.entries(value.properties)) {
    if (!key.trim() || forbiddenKeys.has(key) || !object(field) || field.type !== 'string'
      || Object.keys(field).some(name => !['type', 'enum', 'title', 'description', 'default'].includes(name))
      || !Array.isArray(field.enum) || field.enum.length === 0
      || field.enum.some(choice => typeof choice !== 'string' || !choice.trim())
      || new Set(field.enum).size !== field.enum.length) throw new Error('preferences.' + key + ': expected unique nonempty string choices');
    if (own(field, 'title') && (typeof field.title !== 'string' || !field.title.trim())) throw new Error('Preference title must be a nonempty string');
    if (own(field, 'description') && typeof field.description !== 'string') throw new Error('Preference description must be a string');
    if (own(field, 'default') && !field.enum.includes(field.default)) throw new Error('Preference default must be an enum choice');
  }
  if (value.required !== undefined && (!Array.isArray(value.required) || new Set(value.required).size !== value.required.length
    || value.required.some(key => typeof key !== 'string' || !own(value.properties as object, key)))) throw new Error('Required preferences must be unique declared fields');
}

export function resolveRoutingPreferences(schema: RoutingPreferenceSchema, values: unknown = {}): RoutingPreferences {
  validateRoutingPreferenceSchema(schema);
  assertRoutingPreferences(values);
  const result: RoutingPreferences = {};
  for (const key of Object.keys(values)) if (!own(schema.properties, key)) throw new Error('preferences.' + key + ': unknown preference');
  for (const [key, field] of Object.entries(schema.properties)) {
    const selected = own(values, key) ? values[key] : field.default;
    if (selected !== undefined) {
      if (!field.enum.includes(selected)) throw new Error('preferences.' + key + ': invalid enum choice');
      result[key] = selected;
    } else if (schema.required?.includes(key)) throw new Error('Required routing preference: ' + key);
  }
  assertRoutingPreferences(result);
  return result;
}

export function createRoutingServiceMetadata(preferencesSchema: RoutingPreferenceSchema): RoutingServiceMetadataV1 {
  validateRoutingPreferenceSchema(preferencesSchema);
  return { version: 1, preferencesSchema: structuredClone(preferencesSchema), preferencesSchemaHash: sha256(toUtf8Bytes(canonicalRoutingJson(preferencesSchema))) };
}

export function validateRoutingServiceMetadata(value: unknown): asserts value is RoutingServiceMetadataV1 {
  if (!object(value) || value.version !== 1 || Object.keys(value).some((key) => !['version', 'preferencesSchema', 'preferencesSchemaHash'].includes(key))) throw new Error('Invalid routing service metadata');
  validateRoutingPreferenceSchema(value.preferencesSchema);
  if (createRoutingServiceMetadata(value.preferencesSchema).preferencesSchemaHash !== value.preferencesSchemaHash) throw new Error('Routing preferences schema hash mismatch');
}
