/* peer-utils.ts — shared peer display utilities */
/**
 * Strip parenthesized suffix from peer labels.
 * "Ember Forge (0x1234ab)" → "Ember Forge"
 */
export function getPeerDisplayName(peerLabel: string): string {
  return peerLabel.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function preferredPeerDisplayName(peerDisplayName: unknown, peerLabel: unknown): string {
  return String(peerDisplayName ?? '').trim()
    || getPeerDisplayName(String(peerLabel ?? ''));
}

export function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}

export function formatPerMillionPrice(usdPerMillion: number): string {
  if (usdPerMillion <= 0) return 'Free';
  if (usdPerMillion < 0.01) return `$${usdPerMillion.toFixed(3)}/M`;
  return `$${usdPerMillion.toFixed(2)}/M`;
}
export function normalizeReputationScore(score: unknown): number | null {
  return typeof score === 'number' && Number.isFinite(score) ? score : null;
}
