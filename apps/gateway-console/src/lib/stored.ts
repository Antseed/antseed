/**
 * A per-browser preference (a filter, a picker's choices) in localStorage, as
 * JSON. Storage may be unavailable (private windows, blocked site data), so
 * reads fall back and writes are best effort.
 */
export function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch { return fallback }
}

export function saveStored(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}
