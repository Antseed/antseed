import type { GithubProjectHistory } from '../../src/reputation/identity-history.js';
import type { PeerInfo, PeerVerificationResults } from '../../src/types/peer.js';

export const NOW = Date.parse('2026-09-06T00:00:00Z');
export const YEAR = 365.25 * 86_400_000;
export const PEER_ID = 'a'.repeat(40) as PeerInfo['peerId'];

export function verification(): PeerVerificationResults {
  return { verified: true, checkedAtMs: NOW,
    github: [{ username: 'portfolio', repository: 'proof', peerId: PEER_ID, verified: true, checkedAtMs: NOW }],
    domains: [{ domain: 'portfolio.example', peerId: PEER_ID, verified: true, checkedAtMs: NOW, attempts: [] }] };
}

export function projects(count = 10, stars = 100, age = 4): GithubProjectHistory[] {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `project-${index}`, stars,
    archived: false, createdAtMs: NOW - age * YEAR }));
}

export function peerWithGithub(repos = projects()): PeerInfo {
  const results = verification();
  results.identityHistory = { version: 1, identities: [{ kind: 'github', claim: 'portfolio',
    status: 'available', identityId: 'github:42', createdAtMs: NOW - 10 * YEAR, fetchedAtMs: NOW, projects: repos }] };
  return { peerId: PEER_ID, providers: [], lastSeen: NOW, verificationResults: results };
}

