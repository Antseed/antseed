/** Field errors for the buyer settings form; blank required fields are rejected, not read as 0. */
export function buyerSettingsErrors(values: { input: string; output: string; cached: string; reputation: string }): Partial<Record<keyof typeof values, string>> {
  const errors: Partial<Record<keyof typeof values, string>> = {}
  const check = (key: keyof typeof values, required: boolean, max?: number) => {
    const raw = values[key].trim()
    if (raw === '') { if (required) errors[key] = 'Required.'; return }
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) errors[key] = 'Use a number of 0 or more.'
    else if (max !== undefined && value > max) errors[key] = `At most ${max}.`
  }
  check('input', true)
  check('output', true)
  check('cached', false)
  check('reputation', true, 100)
  return errors
}

/** Error for one numeric settings field, or undefined when it is fine. Blank is an error only when required. */
export function numberFieldError(raw: string, opts: { required?: boolean; min?: number; max?: number; integer?: boolean } = {}): string | undefined {
  const text = raw.trim()
  if (text === '') return opts.required ? 'Required.' : undefined
  const value = Number(text)
  const min = opts.min ?? 0
  if (!Number.isFinite(value)) return 'Use a number.'
  if (opts.integer && !Number.isInteger(value)) return 'Use a whole number.'
  if (value < min) return `Use ${min} or more.`
  if (opts.max !== undefined && value > opts.max) return `At most ${opts.max}.`
  return undefined
}

/** Non-empty lines (or comma-separated entries) of a textarea. */
export function splitEntries(text: string): string[] {
  return text.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean)
}

/** Error for a list of seller ids typed one per line, or undefined. */
export function peerIdsError(ids: string[]): string | undefined {
  const bad = ids.find((id) => !/^(?:0x)?[0-9a-f]{40}$/i.test(id))
  return bad ? `"${bad}" is not a 40-character hex seller id.` : undefined
}

/** Error for a list of RPC URLs, or undefined. Masked saved values ("https://host/…") are accepted as they are. */
export function urlsError(urls: string[]): string | undefined {
  const bad = urls.find((url) => !/^https?:\/\/\S+$/.test(url))
  return bad ? `"${bad}" is not an http(s) URL.` : undefined
}

/** Whether the running buyer takes this setting from its environment or start flags. */
export function isOverridden(overrides: readonly string[], path: string): boolean {
  return overrides.some((entry) => entry === path || path.startsWith(`${entry}.`) || entry.startsWith(`${path}.`))
}

/**
 * A dirty form draft rebased onto newly saved values: a field keeps the
 * draft's value only where the person changed it from `base`; every other
 * field takes `next`, so a later save never reverts what changed elsewhere.
 * Keys come from `next` (a field gone from the saved values goes too).
 */
export function rebaseDraft<T extends object>(draft: T, base: T, next: T): T {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  return Object.fromEntries(Object.keys(next).map((key) => {
    const k = key as keyof T
    return [key, k in draft && !same(draft[k], base[k]) ? draft[k] : next[k]]
  })) as T
}
