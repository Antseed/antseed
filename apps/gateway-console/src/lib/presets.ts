/** Lowercase, dash-separated slug from a name. */
export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(slug)
}

/** Parses the params JSON field: blank → {}, otherwise a JSON object. */
export function parseParams(text: string): Record<string, unknown> {
  if (!text.trim()) return {}
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Parameters must be valid JSON.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Parameters must be a JSON object, like {"temperature": 0.2}.')
  return value as Record<string, unknown>
}
