/* peer-utils.ts — shared peer display utilities */

export function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export const PEER_GRADIENTS = [
  'linear-gradient(180deg, #ffa66c, #ff7b15)',
  'linear-gradient(180deg, #5ca9e0, #178dd6)',
  'linear-gradient(180deg, #4ece64, #00be2c)',
  'linear-gradient(180deg, #6fc5ff, #38b2ff)',
  'linear-gradient(180deg, #f27796, #ec4b74)',
  'linear-gradient(180deg, #8B5CF6, #7C3AED)',
  'linear-gradient(180deg, #06B6D4, #0891B2)',
  'linear-gradient(180deg, #EAB308, #CA8A04)',
  'linear-gradient(180deg, #0EA5E9, #0284C7)',
  'linear-gradient(180deg, #84CC16, #65A30D)',
  'linear-gradient(180deg, #F97316, #C2410C)',
  'linear-gradient(180deg, #EC4899, #BE185D)',
  'linear-gradient(180deg, #14B8A6, #0F766E)',
  'linear-gradient(180deg, #A855F7, #7E22CE)',
  'linear-gradient(180deg, #F43F5E, #BE123C)',
  'linear-gradient(180deg, #10B981, #047857)',
  'linear-gradient(180deg, #6366F1, #4338CA)',
  'linear-gradient(180deg, #D946EF, #A21CAF)',
  'linear-gradient(180deg, #F59E0B, #B45309)',
  'linear-gradient(180deg, #22D3EE, #0E7490)',
];

export function getPeerGradient(key: string): string {
  return PEER_GRADIENTS[stringHash(key) % PEER_GRADIENTS.length];
}

export function getTagTint(tag: string): { background: string; color: string } {
  const hue = stringHash(tag.toLowerCase()) % 360;
  return {
    background: `hsla(${hue}, 70%, 55%, 0.16)`,
    color: `hsl(${hue}, 65%, 42%)`,
  };
}

export function getTagOutlineTint(tag: string): {
  background: string;
  borderColor: string;
  color: string;
} {
  const hue = stringHash(tag.toLowerCase()) % 360;
  return {
    background: 'transparent',
    borderColor: `hsla(${hue}, 65%, 45%, 0.55)`,
    color: `hsl(${hue}, 65%, 42%)`,
  };
}

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

export type PeerReputationSource = {
  peerId: string;
  onChainReputationScore?: number | null;
  effectiveReputationScore?: number | null;
};

export function normalizeReputationScore(score: unknown): number | null {
  return typeof score === 'number' && Number.isFinite(score) ? score : null;
}

export function formatReputationScore(score: unknown): string {
  const normalized = normalizeReputationScore(score);
  if (normalized === null) return '—';
  return (normalized / 10).toFixed(1);
}

export function buildPeerReputationScoreMap(rows: PeerReputationSource[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const row of rows) {
    const score = normalizeReputationScore(row.effectiveReputationScore ?? row.onChainReputationScore);
    if (score === null) continue;
    const existing = scores.get(row.peerId);
    if (existing === undefined || score > existing) {
      scores.set(row.peerId, score);
    }
  }
  return scores;
}

export function getPeerReputationScore(
  peer: PeerReputationSource,
  scoresByPeerId: ReadonlyMap<string, number>,
): number | null {
  return scoresByPeerId.get(peer.peerId) ?? normalizeReputationScore(peer.effectiveReputationScore ?? peer.onChainReputationScore);
}
