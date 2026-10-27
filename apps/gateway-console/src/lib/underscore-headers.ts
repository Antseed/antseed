/** Header names typed one per line or comma-separated: trimmed, lower-cased, de-duplicated. The gateway validates them. */
export function parseHeaderNames(text: string): string[] {
  const names: string[] = []
  for (const raw of text.split(/[\s,]+/)) {
    const name = raw.trim().toLowerCase()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** The hyphenated names Caddy drops once these are kept (`x_name` → `x-name`). */
export function hyphenTwins(names: readonly string[]): string[] {
  return names.map((name) => name.replace(/_/g, '-'))
}
