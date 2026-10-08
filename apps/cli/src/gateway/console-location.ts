import type { GatewayStore } from './store.js'

/**
 * Where the running gateway's console is reachable, saved in the store so
 * `antseed gateway console-link` and `member invite` print working links.
 */
export const CONSOLE_LOCATION_SETTING = 'console.location'

export interface ConsoleLocation {
  publicUrl: string | null
  port: number
  /** Listen address of the gateway that saved it; absent in rows saved before it was recorded. */
  host?: string
}

export function readConsoleLocation(store: Pick<GatewayStore, 'getSetting'>): ConsoleLocation | null {
  const saved = store.getSetting<Partial<ConsoleLocation>>(CONSOLE_LOCATION_SETTING)
  if (!saved || typeof saved.port !== 'number') return null
  return {
    publicUrl: typeof saved.publicUrl === 'string' ? saved.publicUrl : null,
    port: saved.port,
    ...(typeof saved.host === 'string' ? { host: saved.host } : {}),
  }
}

/**
 * The console's origin as typed by an operator: an http(s) URL, reduced to
 * its origin. Throws on anything else so a typo fails at start-up.
 */
export function normalizePublicUrl(value: string | null | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Public URL "${raw}" is not a valid URL.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The public URL must start with https:// (or http://).')
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('The public URL must be an origin such as https://llm.example.com, without a path.')
  return url.origin
}

/** Base URL for console links: the public URL, else localhost (never 127.0.0.1, which passkeys refuse). */
export function consoleBaseUrl(location: ConsoleLocation): string {
  return location.publicUrl ?? `http://localhost:${location.port}`
}
