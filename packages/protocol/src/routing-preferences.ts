/** The buyer's chosen value for each router setting, by setting name. */
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

const FIELD_KEYS = new Set(['options', 'title', 'description', 'default']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Buyer choices are a flat object of strings. */
export function assertRoutingPreferences(value: unknown): asserts value is RoutingPreferences {
  if (!isRecord(value) || !Object.values(value).every(entry => typeof entry === 'string')) {
    throw new Error('Routing preferences must be a flat object of string choices');
  }
}

/** Every router setting lists nonempty string options (plus optional title, description, default). */
export function validateRoutingPreferenceSchema(value: unknown): asserts value is RoutingPreferenceSchema {
  if (!isRecord(value)) throw new Error('Routing preferences must be an object of settings');
  for (const [key, field] of Object.entries(value)) {
    if (!isRecord(field) || !Object.keys(field).every(name => FIELD_KEYS.has(name))
      || !Array.isArray(field.options) || field.options.length === 0
      || !field.options.every(option => typeof option === 'string' && option.trim())) {
      throw new Error(`preferences.${key}: expected nonempty string options`);
    }
    if (field.default !== undefined && !field.options.includes(field.default)) {
      throw new Error(`preferences.${key}: default must be one of its options`);
    }
  }
}

/**
 * Check the buyer's choices against the router's settings and fill in the router's defaults.
 * Unknown settings and options are rejected, so a bad choice fails before any payment.
 */
export function resolveRoutingPreferences(schema: RoutingPreferenceSchema, values: unknown = {}): RoutingPreferences {
  validateRoutingPreferenceSchema(schema);
  assertRoutingPreferences(values);
  for (const [key, value] of Object.entries(values)) {
    const field = Object.hasOwn(schema, key) ? schema[key] : undefined;
    if (!field) throw new Error(`preferences.${key}: unknown preference`);
    if (!field.options.includes(value)) throw new Error(`preferences.${key}: invalid option`);
  }
  return Object.fromEntries(Object.entries(schema).flatMap(([key, field]) => {
    const value = Object.hasOwn(values, key) ? values[key] : field.default;
    return value === undefined ? [] : [[key, value]];
  }));
}
