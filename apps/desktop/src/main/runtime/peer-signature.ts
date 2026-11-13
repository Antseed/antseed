export type PeerSignatureInput = {
  services: string[];
  onChainReputationScore: number | null;
  cooldownUntil: number | null;
  failureStreak: number;
};

export function computePeerSignature(
  peers: Iterable<readonly [string, PeerSignatureInput]>,
): string {
  const parts: string[] = [];
  for (const [id, peer] of peers) {
    parts.push(
      `${id}:${peer.services.join(',')}:${peer.onChainReputationScore ?? ''}:${peer.cooldownUntil ?? ''}:${peer.failureStreak}`,
    );
  }
  parts.sort();
  return parts.join('|');
}
