/** Peer ids compare case-insensitively, with or without the 0x prefix. */
export function normalizePeerId(id: string): string {
  return id.trim().toLowerCase().replace(/^0x/, '')
}

export function samePeerId(a: string, b: string): boolean {
  return normalizePeerId(a) === normalizePeerId(b)
}
