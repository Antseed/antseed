// Load shapes for harness.mjs and the gates in ci.mjs.
const BASE = {
  concurrency: 8, requests: 100, streamRatio: 0.5, abortRatio: 0, fault500Rate: 0, disconnectRate: 0,
  maxReserveUsdc: '1000000', maxPerRequestUsdc: undefined, minInTokens: 1000, maxInTokens: 20000,
  minOut: 100, maxOut: 4000, minLatencyMs: 50, maxLatencyMs: 3000, restart: null, blockTime: 1,
  imageRatio: 0,
};
export const SCENARIOS = {
  smoke: { ...BASE, concurrency: 2, requests: 6 },
  seq: { ...BASE, concurrency: 1, requests: 30 },
  c8: { ...BASE, concurrency: 8, requests: 120 },
  c32: { ...BASE, concurrency: 32, requests: 256 },
  c64: { ...BASE, concurrency: 64, requests: 384 },
  smallreserve: { ...BASE, concurrency: 32, requests: 256, maxReserveUsdc: '250000', maxPerRequestUsdc: '150000' },
  faults: { ...BASE, concurrency: 32, requests: 256, abortRatio: 0.1, fault500Rate: 0.05, disconnectRate: 0.05 },
  'restart-buyer': { ...BASE, concurrency: 32, requests: 300, restart: { who: 'buyer', atFraction: 0.4 } },
  'restart-seller': { ...BASE, concurrency: 32, requests: 300, restart: { who: 'seller', atFraction: 0.4 } },
  // The seller's RPC keeps its first topUp() back and the seller restarts 3 s
  // later: a verified top-up whose transaction never went out, with work served
  // above the deposit while it was pending. Small reserves top up early.
  'restart-seller-topup': {
    ...BASE, concurrency: 32, requests: 384, maxReserveUsdc: '250000', maxPerRequestUsdc: '150000',
    restart: { who: 'seller', on: 'top-up', settleMs: 3000 },
  },
  mixed: { ...BASE, concurrency: 32, requests: 256 },
  images: { ...BASE, concurrency: 32, requests: 256, imageRatio: 0.3 },
  // #1050: pay, stop the buyer (seller closes on disconnect), restart it, then
  // check every channel count before paying again on a fresh channel.
  'issue-1050': { ...BASE, concurrency: 4, requests: 24, stale1050: { reconcileWaitMs: 90_000 } },
};

// --shard I/N keeps every N-th scenario, starting at the I-th. N jobs with I = 1..N
// run each scenario exactly once between them, including scenarios added later.
export function shardOf(names, spec) {
  if (spec === undefined) return names;
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  const [index, count] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (index < 1 || index > count) throw new Error(`--shard takes I/N with 1 <= I <= N, got ${spec}`);
  return names.filter((_, i) => i % count === index - 1);
}
