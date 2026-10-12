import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopTeeStatus } from '@antseed/node/tee-status';
import type { DiscoverRow } from '../../core/state';

const peer = { peerId: 'a'.repeat(40), advertisedVerifierIds: ['antseed-verifier'] } as DiscoverRow;
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  vi.stubGlobal('document', { visibilityState: 'visible' });
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup() {
  let status: DesktopTeeStatus = { snapshot: { sessionId: 'buyer', verificationEnabled: true, evidence: [] } };
  const getTeeStatus = vi.fn(async () => status);
  const checkSellerTee = vi.fn(async (peerId: string): Promise<DesktopTeeStatus> => {
    status = { ...status, snapshot: { ...status.snapshot!, evidence: [...status.snapshot!.evidence.filter((entry) => entry.peerId !== peerId), {
      peerId, verifierId: 'antseed-verifier', fingerprint: 'caps', checkedAt: Date.now(), expiresAt: Date.now() + 300_000, sellerNodeVerified: true, claims: [],
    }] } };
    return status;
  });
  vi.stubGlobal('window', { antseedDesktop: { getTeeStatus, checkSellerTee } });
  const { teeVerificationStore: store } = await import('./useTeeVerification');
  dispose = store.subscribe(() => {});
  store.updatePeers([peer]);
  return { store, getTeeStatus, checkSellerTee };
}

describe('background verification lifecycle', () => {
  it('checks at startup and on new discovery without manual actions or routing writes', async () => {
    const { store, checkSellerTee } = await setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(checkSellerTee).toHaveBeenCalledTimes(1);
    expect(checkSellerTee).toHaveBeenCalledWith(peer.peerId);
    expect(store.getSnapshot().status.snapshot?.evidence[0]?.sellerNodeVerified).toBe(true);
    const anotherSubscriber = store.subscribe(() => {});
    store.updatePeers([peer, peer, { ...peer, peerId: 'b'.repeat(40) }]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(checkSellerTee).toHaveBeenCalledTimes(2);
    anotherSubscriber();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(checkSellerTee).toHaveBeenCalledTimes(2);
  });

  it('serializes checks and ignores a late result after teardown', async () => {
    const { store, checkSellerTee } = await setup();
    let finish!: (status: DesktopTeeStatus) => void;
    checkSellerTee.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    store.updatePeers([peer, { ...peer, peerId: 'b'.repeat(40) }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checkSellerTee).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().checking).toEqual([peer.peerId]);
    dispose?.();
    dispose = undefined;
    finish({ snapshot: { sessionId: 'buyer', verificationEnabled: true, evidence: [] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().status.snapshot).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes viewed sellers on expiry and stops refreshing after leaving the view', async () => {
    const { store, checkSellerTee } = await setup();
    const stopViewing = store.observeVisiblePeers([peer]);
    await vi.advanceTimersByTimeAsync(0);
    expect(checkSellerTee).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(checkSellerTee).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkSellerTee).toHaveBeenCalledTimes(2);
    stopViewing();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(checkSellerTee).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a completed check with an older pending status poll', async () => {
    const { store, checkSellerTee, getTeeStatus } = await setup();
    let finishCheck!: (status: DesktopTeeStatus) => void;
    let finishPoll!: (status: DesktopTeeStatus) => void;
    const stale: DesktopTeeStatus = { snapshot: { sessionId: 'buyer', verificationEnabled: true, evidence: [] } };
    checkSellerTee.mockImplementation(() => new Promise((resolve) => { finishCheck = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    getTeeStatus.mockImplementation(() => new Promise((resolve) => { finishPoll = resolve; }));
    await vi.advanceTimersByTimeAsync(2000);
    const fresh: DesktopTeeStatus = { ...stale, snapshot: { ...stale.snapshot!, evidence: [{
      peerId: peer.peerId, verifierId: 'antseed-verifier', fingerprint: 'caps', checkedAt: 3000, expiresAt: 303_000, sellerNodeVerified: true, claims: [],
    }] } };
    finishCheck(fresh);
    await vi.advanceTimersByTimeAsync(0);
    finishPoll(stale);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().status).toEqual(fresh);
  });

  it('pauses hidden-window checks and backs off unavailable checks', async () => {
    const { store, checkSellerTee } = await setup();
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    checkSellerTee.mockRejectedValue(new Error('Verifier unavailable'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checkSellerTee).not.toHaveBeenCalled();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(checkSellerTee).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().peerErrors[peer.peerId]).toBe('Verifier unavailable');
    await vi.advanceTimersByTimeAsync(28_000);
    expect(checkSellerTee).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(checkSellerTee).toHaveBeenCalledTimes(2);
  });
});
