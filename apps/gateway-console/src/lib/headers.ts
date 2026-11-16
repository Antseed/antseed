/** `Name: value` lines ↔ header map, for the OTLP headers field. */
export function headersToText(headers: Record<string, string>): string {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n')
}

export function textToHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue
    const colon = line.indexOf(':')
    if (colon <= 0) throw new Error(`Line ${index + 1}: use "Name: value".`)
    const name = line.slice(0, colon).trim()
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error(`Line ${index + 1}: "${name}" is not a valid header name.`)
    headers[name] = line.slice(colon + 1).trim()
  }
  return headers
}

/** How the gateway shows a saved header value it does not send back. */
export const MASKED_VALUE = '••••'

/** Header names whose value is still the mask, i.e. the saved value the user has not re-entered. */
export function maskedHeaderNames(text: string): string[] {
  return text.split('\n').map((line) => {
    const colon = line.indexOf(':')
    return colon > 0 && line.slice(colon + 1).trim() === MASKED_VALUE ? line.slice(0, colon).trim() : null
  }).filter((name): name is string => !!name)
}

/** Blanks masked values ("Authorization: " stays) so the user types them again. */
export function clearMaskedValues(text: string): string {
  return text.split('\n').map((line) => {
    const colon = line.indexOf(':')
    return colon > 0 && line.slice(colon + 1).trim() === MASKED_VALUE ? `${line.slice(0, colon)}: ` : line
  }).join('\n')
}

/** Saved header values are sent only to the same origin; a new one needs them typed again. */
export function endpointOriginChanged(before: string | null, after: string | null): boolean {
  if (!before || !after) return false
  try { return new URL(before).origin !== new URL(after).origin } catch { return before !== after }
}
