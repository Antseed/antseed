// Steady chat traffic over three sellers; one seller is stopped mid-run and restarted. The other sellers
// must absorb its traffic during the outage, and the restarted seller must get traffic again.

const MODELS = ['sandbox-chat'];
const provider = (inputUsdPerMillion, outputUsdPerMillion) => ({
  chat: { plugin: 'openai', defaults: { inputUsdPerMillion, outputUsdPerMillion }, services: Object.fromEntries(MODELS.map((model) => [model, { categories: ['chat'] }])) },
});
const steady = { rttMs: { type: 'uniform', min: 20, max: 60 }, prefillTokensPerSec: 8000, decodeTokensPerSec: { type: 'lognormal', median: 80, p99: 120 }, outputTokens: { type: 'lognormal', median: 120, p99: 400 }, concurrency: 8 };
const env = process.env;
const phase = (name, fallback) => env[`SANDBOX_CHAOS_${name}`] ?? fallback;

export default {
  meta: {
    description: 'Steady chat traffic over three sellers; the cheapest seller is stopped mid-run and restarted. Others keep serving during the outage, nothing reaches the stopped seller, and it gets traffic again after the restart.',
    requires: ['sellerControl', 'mockControl'],
  },
  topology: {
    sellers: [
      { id: 'victim', mock: steady, providers: provider(0.5, 2) },
      { id: 'steady-a', mock: steady, providers: provider(1, 4) },
      { id: 'steady-b', mock: steady, providers: provider(1, 4) },
    ],
    buyer: { depositUsdc: '20' },
  },
  workload: {
    spec: { name: 'chaos-chat', sessionsPerMinute: 30, personas: [{ name: 'chat', arrival: { perMinute: 30 }, turns: { type: 'uniform', min: 2, max: 6 }, thinkTimeMs: { type: 'lognormal', median: 3000, p99: 10000 }, systemTokens: 200, inputTokens: { median: 60, p99: 400 }, carryContext: true, outputTokens: { median: 120, p99: 400 }, streamRatio: 0.8, abandonAfterMs: 30000 }], maxInFlight: 64 },
  },
  phases: [
    { name: 'baseline', duration: phase('BASELINE', '30s'), expect: { successRate: '>=0.99' } },
    {
      name: 'outage',
      duration: phase('OUTAGE', '30s'),
      faults: [{ stop: 'victim' }],
      expect: { 'servedBy.victim': '==0', successRate: '>=0.8', succeeded: '>=1' },
      known: {
        'servedBy.steady-a': { expect: '>=1', issue: 'buyer pins one of several equal-price sellers instead of spreading load' },
      },
    },
    {
      name: 'recovery',
      duration: phase('RECOVERY', '60s'),
      faults: [{ start: 'victim' }],
      expect: { successRate: '>=0.95', requests: '>=1' },
      known: {
        'recoveryMs.victim': { expect: '<45000', issue: 'buyer does not move traffic back to a restarted cheaper seller' },
      },
    },
  ],
  expect: { successRate: '>=0.9' },
};
