import { useEffect, useSyncExternalStore } from 'react';
import type { DesktopTeeStatus } from '@antseed/node/tee-status';
import { advertisesTeeSupport } from '@antseed/node/verifier-capabilities';
import type { DiscoverRow } from '../../core/state';
import { useUiSelector } from './useUiSelector';
import { TeeAutoVerification } from './tee-auto-verification';

type State = { status: DesktopTeeStatus; now: number; checking: readonly string[]; peerErrors: Record<string, string> };
const initial: State = { status: { snapshot: null }, now: 0, checking: [], peerErrors: {} };
let state = initial;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let polling = false;
let generation = 0;
let revision = 0;
let checking = false;
let nextCheckAt = 0;
let automatic = new TeeAutoVerification();
const visibleSellers = new Map<symbol, ReadonlySet<string>>();

function publish(next: Partial<State>): void {
  state = { ...state, ...next, now: Date.now() };
  for (const listener of listeners) listener();
}

async function refresh(): Promise<void> {
  if (polling) return;
  const current = generation;
  const startedAtRevision = revision;
  polling = true;
  try {
    const status = await window.antseedDesktop?.getTeeStatus?.();
    if (current === generation && startedAtRevision === revision) {
      const peerErrors = status?.snapshot?.sessionId === state.status.snapshot?.sessionId ? { ...state.peerErrors } : {};
      for (const evidence of status?.snapshot?.evidence ?? []) {
        if (!evidence.checking && !evidence.unavailable && evidence.expiresAt > Date.now()) delete peerErrors[evidence.peerId];
      }
      publish({ status: status ?? initial.status, peerErrors });
    }
  } catch {
    if (current === generation && startedAtRevision === revision) publish({ status: { ...state.status, snapshot: null } });
  } finally { polling = false; }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    void refresh().then(checkNext);
    timer = setInterval(() => { publish({}); void refresh().then(checkNext); }, 2000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
      generation += 1;
      state = initial;
      automatic = new TeeAutoVerification();
      nextCheckAt = 0;
    }
  };
}

async function checkNext(): Promise<void> {
  if (checking || !listeners.size || !state.status.snapshot
    || Date.now() < nextCheckAt || document.visibilityState === 'hidden' || !window.antseedDesktop?.checkSellerTee) return;
  const interested = new Set([...visibleSellers.values()].flatMap((sellers) => [...sellers]));
  const attempt = automatic.next(state.status.snapshot, interested, Date.now());
  if (!attempt) return;
  const { peerId } = attempt;
  const current = generation;
  checking = true;
  nextCheckAt = Date.now() + 2000;
  publish({ checking: [peerId] });
  try {
    const status = await window.antseedDesktop.checkSellerTee(peerId);
    if (!status?.snapshot) throw new Error(status?.error ?? 'Start the buyer to verify sellers');
    if (current === generation && automatic.current(attempt)
      && state.status.snapshot?.sessionId === attempt.sessionId && status.snapshot?.sessionId === attempt.sessionId) {
      const evidence = status.snapshot.evidence.find((entry) => entry.peerId === peerId);
      automatic.complete(attempt, evidence, Date.now());
      const peerErrors = { ...state.peerErrors };
      if (evidence) delete peerErrors[peerId];
      else peerErrors[peerId] = 'Verification unavailable. Retrying automatically.';
      revision += 1;
      publish({ status, peerErrors });
    }
  } catch (error) {
    if (current === generation && automatic.current(attempt) && state.status.snapshot?.sessionId === attempt.sessionId) {
      automatic.complete(attempt, undefined, Date.now());
      publish({ peerErrors: { ...state.peerErrors, [peerId]: error instanceof Error ? error.message : 'Verification unavailable' } });
    }
  } finally {
    checking = false;
    if (current === generation) publish({ checking: [] });
  }
}

export function useTeeVerification() {
  const snapshot = useSyncExternalStore(subscribe, teeVerificationStore.getSnapshot, () => initial);
  return snapshot;
}

export const teeVerificationStore = {
  subscribe,
  getSnapshot: () => state,
  updatePeers: (rows: readonly DiscoverRow[]) => {
    automatic.update(rows);
    const known = new Set(rows.filter(advertisesTeeSupport).map((row) => row.peerId));
    const peerErrors = Object.fromEntries(Object.entries(state.peerErrors).filter(([peerId]) => known.has(peerId)));
    if (Object.keys(peerErrors).length !== Object.keys(state.peerErrors).length) publish({ peerErrors });
  },
  observeVisiblePeers: (rows: readonly DiscoverRow[]) => {
    const key = Symbol();
    visibleSellers.set(key, new Set(rows.filter(advertisesTeeSupport).map((row) => row.peerId)));
    return () => { visibleSellers.delete(key); };
  },
};

export function useTeeBackgroundVerification(): void {
  const rows = useUiSelector((state) => state.vprRoutableRows);
  useEffect(() => subscribe(() => {}), []);
  useEffect(() => { teeVerificationStore.updatePeers(rows); }, [rows]);
}

export function useTeeVisibleSellers(rows: readonly DiscoverRow[]): void {
  useEffect(() => teeVerificationStore.observeVisiblePeers(rows), [rows]);
}
