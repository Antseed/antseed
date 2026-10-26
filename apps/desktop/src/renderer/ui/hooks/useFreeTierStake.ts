import { useEffect, useSyncExternalStore } from 'react';
import type { BuyerFreeTierStake } from '../../modules/catalog/free-tier';

/** Stake changes at most once a week; a few minutes of lag is fine. */
const REFRESH_MS = 5 * 60_000;

let current: BuyerFreeTierStake | null = null;
let loadedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
  if (inFlight) return inFlight;
  const read = typeof window === 'undefined' ? undefined : window.antseedDesktop?.freeTierStake;
  if (!read) return Promise.resolve();
  inFlight = read()
    .then((result) => {
      // A failed read keeps what was shown: the stake behind it rarely changes.
      if (result.ok && result.data) current = result.data;
    }, () => {})
    .finally(() => {
      loadedAt = Date.now();
      inFlight = null;
      listeners.forEach((listener) => listener());
    });
  return inFlight;
}

/** Re-read the counted stake, after a code is added or removed. */
export function refreshFreeTierStake(): void {
  loadedAt = 0;
  void load();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * This buyer's counted seller-pool stake (its own plus stake shared with it by
 * code), by pool, shared by every component that shows it. Null until read.
 */
export function useFreeTierStake(): BuyerFreeTierStake | null {
  const view = useSyncExternalStore(subscribe, () => current, () => null);
  useEffect(() => {
    if (Date.now() - loadedAt > REFRESH_MS) void load();
  }, []);
  return view;
}
