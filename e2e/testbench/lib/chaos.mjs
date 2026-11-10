// A seeded fault plan for one stress run: which faults fire, how hard and when, all drawn from one stream so a
// seed replays the same plan. Pure, so the plan and its gate can be tested without a testbench.
import { composeGate, GATES } from './stress.mjs';

/** Block time while the chain is slow: spend outruns a top-up, so the seller sits at the ceiling with the next one mining. */
export const CHAOS_SLOW_BLOCK_SEC = 12;
/** How long a slow upstream response takes: longer than the chaos topology's buyer request timeout. */
export const CHAOS_SLOW_MS = 40_000;

const PEER_EVENTS = [
  null,
  { who: 'seller' },
  { who: 'seller', crash: true },
  { who: 'buyer' },
];

/**
 * Draws a plan from `random` (tb.prng('chaos')): { fired, faults, load, blockTimeSec }. `fired` names what the plan
 * injects, `faults` are the mock's rates, `load` the load shape (aborts, chats without max_tokens, a mid-load restart
 * or crash), `blockTimeSec` is set when the chain mines slowly. Every value is drawn whether or not its fault fires,
 * so one fault's presence never shifts the draws of another. A plan always injects at least one thing.
 */
export function drawChaosPlan(random) {
  const rate = (min, max) => Number((min + random() * (max - min)).toFixed(3));
  const draws = {
    upstream500: { on: random() < 0.5, rate: rate(0.02, 0.08) },
    disconnect: { on: random() < 0.5, rate: rate(0.02, 0.08) },
    clientAbort: { on: random() < 0.5, rate: rate(0.05, 0.15) },
    noMaxTokens: { on: random() < 0.5, rate: rate(0.2, 0.6) },
    slowUpstream: { on: random() < 0.35, rate: rate(0.03, 0.08) },
    slowBlocks: { on: random() < 0.4 },
    peer: { event: PEER_EVENTS[Math.floor(random() * PEER_EVENTS.length)], atFraction: Number((0.2 + random() * 0.5).toFixed(2)) },
    concurrency: [16, 32, 48][Math.floor(random() * 3)],
    fallback: Math.floor(random() * 4),
  };
  const names = ['upstream500', 'disconnect', 'clientAbort', 'noMaxTokens'];
  if (!names.some((name) => draws[name].on) && !draws.slowUpstream.on && !draws.slowBlocks.on && !draws.peer.event) draws[names[draws.fallback]].on = true;
  const restart = draws.peer.event ? { ...draws.peer.event, atFraction: draws.peer.atFraction } : null;
  const fired = [
    ...[...names, 'slowUpstream', 'slowBlocks'].filter((name) => draws[name].on),
    ...(restart ? [`${restart.crash ? 'crash' : 'restart'}-${restart.who}`] : []),
  ];
  return {
    fired,
    faults: {
      fault500Rate: draws.upstream500.on ? draws.upstream500.rate : 0,
      disconnectRate: draws.disconnect.on ? draws.disconnect.rate : 0,
      ...(draws.slowUpstream.on ? { slowRate: draws.slowUpstream.rate, slowMs: CHAOS_SLOW_MS } : {}),
    },
    load: {
      concurrency: draws.concurrency, requests: 240,
      ...(draws.clientAbort.on ? { abortRatio: draws.clientAbort.rate } : {}),
      ...(draws.noMaxTokens.on ? { omitMaxTokensRatio: draws.noMaxTokens.rate } : {}),
      ...(restart ? { restart } : {}),
    },
    ...(draws.slowBlocks.on ? { blockTimeSec: CHAOS_SLOW_BLOCK_SEC } : {}),
  };
}

/** The gate a plan is held to: the gates of the shapes that inject each of its faults alone, composed. */
export function chaosGate(plan) {
  const { faults, load } = plan;
  const parts = [];
  if (faults.fault500Rate > 0 || faults.disconnectRate > 0) parts.push(GATES.faults);
  if (faults.slowRate > 0) parts.push(GATES['buyer-timeout']);
  if (plan.blockTimeSec) parts.push(GATES['slow-topups']);
  if (load.restart) parts.push(GATES[load.restart.crash ? 'crash-seller' : `restart-${load.restart.who}`]);
  return composeGate(parts);
}
