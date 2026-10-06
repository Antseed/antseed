import type { TeeEvidence, TeeSnapshot } from '@antseed/node/tee-status';
import { advertisesTeeSupport, normalizeAdvertisedVerifierIds } from '@antseed/node/verifier-capabilities';

type Peer = { peerId: string; advertisedVerifierIds?: string[] };
type Entry = { fingerprint: string; attempted: boolean; failures: number; retryAt: number; observedCheckedAt?: number };
export type TeeAttempt = { peerId: string; sessionId: string; entry: Entry };

export class TeeAutoVerification {
  private entries = new Map<string, Entry>();
  private sessionId: string | undefined;

  update(peers: readonly Peer[]): void {
    const known = new Map(peers.filter(advertisesTeeSupport).map((peer) => [peer.peerId,
      normalizeAdvertisedVerifierIds(peer.advertisedVerifierIds).sort().join('|')]));
    for (const peerId of this.entries.keys()) {
      if (!known.has(peerId)) this.entries.delete(peerId);
    }
    for (const [peerId, fingerprint] of known) {
      if (this.entries.get(peerId)?.fingerprint === fingerprint) continue;
      this.entries.set(peerId, { fingerprint, attempted: false, failures: 0, retryAt: 0 });
    }
  }

  next(snapshot: TeeSnapshot, interested: ReadonlySet<string>, now: number): TeeAttempt | undefined {
    if (this.sessionId !== snapshot.sessionId) {
      this.sessionId = snapshot.sessionId;
      for (const [peerId, entry] of this.entries) {
        this.entries.set(peerId, { fingerprint: entry.fingerprint, attempted: false, failures: 0, retryAt: 0 });
      }
    }
    if (!snapshot.verificationEnabled) return;
    const evidence = new Map(snapshot.evidence.map((entry) => [entry.peerId, entry]));
    const candidates = [...this.entries].sort(([leftId, left], [rightId, right]) =>
      Number(interested.has(rightId)) - Number(interested.has(leftId)) || left.retryAt - right.retryAt);
    for (const [peerId, entry] of candidates) {
      const verdict = evidence.get(peerId);
      if (verdict?.checking) continue;
      if (!verdict && entry.observedCheckedAt !== undefined && entry.failures === 0 && interested.has(peerId)) {
        delete entry.observedCheckedAt;
        entry.attempted = false;
        entry.retryAt = 0;
      }
      if (verdict?.unavailable && entry.observedCheckedAt !== verdict.checkedAt) {
        entry.failures += 1;
        entry.retryAt = now + Math.min(30_000 * 2 ** Math.min(entry.failures - 1, 4), 300_000);
      }
      if (verdict) entry.observedCheckedAt = verdict.checkedAt;
      if (verdict && !verdict.unavailable && verdict.expiresAt > now) {
        entry.attempted = true;
        entry.failures = 0;
        entry.retryAt = verdict.expiresAt;
        continue;
      }
      if (entry.retryAt > now) continue;
      if (entry.attempted && !interested.has(peerId) && !(entry.failures > 0 && entry.failures < 3)) continue;
      entry.attempted = true;
      entry.retryAt = now + 2000;
      return { peerId, sessionId: snapshot.sessionId, entry };
    }
  }

  current(attempt: TeeAttempt): boolean {
    return this.sessionId === attempt.sessionId && this.entries.get(attempt.peerId) === attempt.entry;
  }

  complete(attempt: TeeAttempt, evidence: TeeEvidence | undefined, now: number): void {
    if (!this.current(attempt)) return;
    const entry = attempt.entry;
    if (evidence) entry.observedCheckedAt = evidence.checkedAt;
    if (!evidence || evidence.unavailable) {
      entry.failures += 1;
      entry.retryAt = now + Math.min(30_000 * 2 ** Math.min(entry.failures - 1, 4), 300_000);
    } else {
      entry.failures = 0;
      entry.retryAt = Math.max(evidence.expiresAt, now + 30_000);
    }
  }
}
