/**
 * The privacy boundary. Every property of every event passes through here:
 * - keys not on the event's allowlist are dropped;
 * - a key with allowed values or a pattern takes only strings, and a key
 *   with a range only numbers: a value of another type is dropped;
 * - string values with a validator must be one of its values;
 * - strings without one are truncated to 64 characters (and may be pattern-checked);
 * - numbers are rounded and bounded; booleans pass; anything else is dropped.
 */

export const MAX_STRING_LENGTH = 64;

/** What an event may carry: allowed keys, value sets and patterns. */
export type EventSchema = {
  /** Allowed property keys. */
  keys: ReadonlySet<string>;
  /** Allowed values per string property. */
  values?: Readonly<Record<string, ReadonlySet<string>>>;
  /** Required shape per free-form string property. */
  patterns?: Readonly<Record<string, RegExp>>;
  /** Numeric properties that must be integers in [min, max]. */
  ranges?: Readonly<Record<string, readonly [number, number]>>;
};

export type EventCatalog = Readonly<Record<string, EventSchema>>;

export type SanitizedProperties = Record<string, string | number | boolean>;

/** Public model ids: a conservative slug, or the fixed placeholder. */
export const PUBLIC_MODEL_ID_PATTERN = /^(?:custom_or_unknown|[a-z0-9][a-z0-9._:/-]{0,63})$/;
/** Random v4 UUIDs, for correlating two events of one request. */
export const RANDOM_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HTTP_STATUS_RANGE: readonly [number, number] = [100, 599];

/** Returns null when the event is not in the catalog: unknown events are never sent. */
export function sanitizeEventProperties(
  catalog: EventCatalog,
  event: string,
  properties: Readonly<Record<string, unknown>> | null | undefined,
): SanitizedProperties | null {
  const schema = catalog[event];
  if (!schema) return null;
  const out: SanitizedProperties = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (!schema.keys.has(key)) continue;
    const stringOnly = schema.values?.[key] !== undefined || schema.patterns?.[key] !== undefined;
    const numberOnly = schema.ranges?.[key] !== undefined;
    if (stringOnly && typeof value !== 'string') continue;
    if (numberOnly && typeof value !== 'number') continue;
    if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      const range = schema.ranges?.[key];
      if (range) {
        if (!Number.isInteger(value) || value < range[0] || value > range[1]) continue;
        out[key] = value;
        continue;
      }
      out[key] = Math.round(Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value)));
    } else if (typeof value === 'string') {
      const allowed = schema.values?.[key];
      if (allowed && !allowed.has(value)) continue;
      const pattern = schema.patterns?.[key];
      if (pattern && !pattern.test(value)) continue;
      out[key] = value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
    }
    // Objects, arrays, null, undefined and functions are dropped.
  }
  return out;
}
