import {useEffect, useState} from 'react';

/* ── ANTS emission clock ──────────────────────────────────────────
   Weekly epochs, 104-epoch halving. Genesis read from AntseedEmissions
   on Base mainnet (block 44469557): eth_call genesis() on
   0xF13bE52c4A3afC6AE29536f073588d01A0564088. See docs/recognized-usage. */
const EPOCH_DURATION = 604_800; // 1 week in seconds
const GENESIS = 1775728461; // 2026-04-09T09:54:21Z
export const MAX_SUPPLY = 1_040_000_000;
export const INITIAL_EMISSION = 5_000_000;
export const ANTS_TOKEN_ADDRESS = '0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263';
export const ANTS_BASESCAN_URL = `https://basescan.org/token/${ANTS_TOKEN_ADDRESS}`;

/** "3d 4h 5m" while days remain, then "4h 5m 6s", then "5m 6s". */
function formatRemaining(remaining: number): string {
  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export function useEpochCountdown() {
  // Start with a deterministic value so SSR and the first client render match.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  if (now === null) return {epoch: 0, timeLeft: '-', remaining: 0, progress: 0, started: false};

  const elapsed = now - GENESIS;
  const epoch = Math.floor(elapsed / EPOCH_DURATION);
  const epochEnd = GENESIS + (epoch + 1) * EPOCH_DURATION;
  const remaining = Math.max(0, epochEnd - now);
  const progress = 1 - remaining / EPOCH_DURATION;

  return {epoch, timeLeft: formatRemaining(remaining), remaining, progress, started: true};
}
