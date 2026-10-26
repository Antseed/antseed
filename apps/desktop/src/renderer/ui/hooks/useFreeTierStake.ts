import { useSyncExternalStore } from 'react';
import type { BuyerFreeTierStake } from '../../modules/catalog/free-tier';

/** Stake changes at most once a week; a few minutes of lag is fine. */
export const FREE_TIER_STAKE_REFRESH_MS = 5 * 60_000;
/** Returning to the window (say, from staking in the browser) re-reads at most this often. */
const FOCUS_REFRESH_MS = 30_000;

let current: BuyerFreeTierStake | null = null;
let loadedAt = 0;
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
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

function onFocus(): void {
  if (Date.now() - loadedAt >= FOCUS_REFRESH_MS) void load();
}

/** Re-read the counted stake, after a code is added or removed. */
export function refreshFreeTierStake(): void {
  loadedAt = 0;
  void load();
}

/**
 * Subscribe to the counted stake. While anything is subscribed it is re-read
 * every `FREE_TIER_STAKE_REFRESH_MS` and when the window regains focus.
 */
export function subscribeFreeTierStake(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = setInterval(() => { void load(); }, FREE_TIER_STAKE_REFRESH_MS);
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    if (Date.now() - loadedAt >= FREE_TIER_STAKE_REFRESH_MS) void load();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (timer) clearInterval(timer);
    timer = null;
    if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
  };
}

export function getFreeTierStake(): BuyerFreeTierStake | null {
  return current;
}

/**
 * This buyer's counted seller-pool stake (its own plus stake shared with it by
 * code), by pool, shared by every component that shows it. Null until read.
 */
export function useFreeTierStake(): BuyerFreeTierStake | null {
  return useSyncExternalStore(subscribeFreeTierStake, getFreeTierStake, () => null);
}
