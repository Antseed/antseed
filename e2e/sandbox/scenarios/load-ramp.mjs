import { topology as mixedTopology } from './load-mixed.mjs';

export const meta = {
  description: 'Ramps a workload rate step by step until p95 TTFT degrades past the knee rule (or errors climb); records the knee as a metric.',
  targets: ['fork'],
  requires: ['mockControl'],
};

export const topology = mixedTopology;

const env = process.env;
const WORKLOAD = env.SANDBOX_RAMP_WORKLOAD ?? 'chat-only';
const STEP_MS = Number(env.SANDBOX_RAMP_STEP_MS ?? 40_000);
const MULTIPLIERS = (env.SANDBOX_RAMP_MULTIPLIERS ?? '1,2,4,8,16').split(',').map(Number);
const KNEE_FACTOR = Number(env.SANDBOX_RAMP_KNEE_FACTOR ?? 2);
const MAX_TTFT_P95_MS = Number(env.SANDBOX_RAMP_MAX_TTFT_P95_MS ?? 30_000);
const MIN_SUCCESS_RATE = Number(env.SANDBOX_RAMP_MIN_SUCCESS_RATE ?? 0.9);

/**
 * Knee rule: a step is broken when its p95 TTFT exceeds KNEE_FACTOR x the first step's p95 TTFT
 * (or the absolute MAX_TTFT_P95_MS), or its success rate drops below MIN_SUCCESS_RATE.
 */
export function kneeVerdict(step, baselineTtftP95Ms) {
  const limit = Math.min(MAX_TTFT_P95_MS, baselineTtftP95Ms === null ? MAX_TTFT_P95_MS : baselineTtftP95Ms * KNEE_FACTOR);
  if ((step.successRate ?? 0) < MIN_SUCCESS_RATE) return { broken: true, reason: 'errors', limit };
  if ((step.ttftP95Ms ?? Infinity) > limit) return { broken: true, reason: 'ttft', limit };
  return { broken: false, limit };
}

export async function run(sb) {
  const steps = [];
  let knee = null;
  let baseline = null;
  for (const rateMultiplier of MULTIPLIERS) {
    const result = await sb.runWorkload({ workload: WORKLOAD, durationMs: STEP_MS, rateMultiplier, label: `ramp-x${rateMultiplier}` });
    const o = result.summary.overall;
    const step = { rateMultiplier, requests: o.requests, successRate: o.successRate, ttftP50Ms: o.ttftMs.p50, ttftP95Ms: o.ttftMs.p95, latencyP95Ms: o.latencyMs.p95, requestsPerSec: o.requestsPerSec, outputTokensPerSec: o.outputTokensPerSec, dropped: o.dropped, loadSpreadGini: o.loadSpreadGini };
    if (baseline === null) baseline = step.ttftP95Ms;
    const verdict = kneeVerdict(step, steps.length === 0 ? null : baseline);
    Object.assign(step, { ttftLimitMs: verdict.limit, broken: verdict.broken });
    steps.push(step);
    await sb.event('ramp-step', step);
    if (verdict.broken) {
      knee = { brokeAt: rateMultiplier, lastGood: steps.length > 1 ? steps.at(-2) : null, reason: verdict.reason };
      break;
    }
  }
  const lastGood = knee ? knee.lastGood : steps.at(-1);
  sb.metric('rampWorkload', WORKLOAD);
  sb.metric('rampRule', { kneeFactor: KNEE_FACTOR, maxTtftP95Ms: MAX_TTFT_P95_MS, minSuccessRate: MIN_SUCCESS_RATE, baselineTtftP95Ms: baseline });
  sb.metric('rampSteps', steps);
  sb.metric('kneeReached', Boolean(knee));
  sb.metric('kneeRateMultiplier', lastGood?.rateMultiplier ?? 0);
  sb.metric('kneeBrokeAt', knee?.brokeAt ?? null);
  sb.metric('kneeReason', knee?.reason ?? 'not reached');
  sb.metric('kneeRequestsPerSec', lastGood?.requestsPerSec ?? null);
  sb.check('ramp ran at least one step', steps.length > 0, steps);

  await sb.checkInvariants({ phase: 'during' });
  await sb.closeAll();
  await sb.checkInvariants({ phase: 'final' });
}
