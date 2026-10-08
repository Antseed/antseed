export const meta = {
  description: 'Five sellers with different upstream profiles (fast/expensive, cheap/slow, flaky, degrading, local GPU) under mixed desktop-chat, coding-agent and API traffic; reports latency, reliability and load-spread metrics and checks payment invariants.',
  targets: ['fork'],
  requires: ['mockControl'],
};

const MODELS = ['sandbox-chat', 'sandbox-code'];
const provider = (inputUsdPerMillion, outputUsdPerMillion) => ({
  chat: {
    plugin: 'openai',
    defaults: { inputUsdPerMillion, outputUsdPerMillion },
    services: Object.fromEntries(MODELS.map((model) => [model, { categories: ['chat'] }])),
  },
});

export const topology = {
  sellers: [
    { id: 'premium', mock: { profile: 'fast-premium' }, providers: provider(3, 15) },
    { id: 'budget', mock: { profile: 'cheap-slow' }, providers: provider(0.2, 0.8) },
    { id: 'flaky', mock: { profile: 'flaky' }, providers: provider(1, 4) },
    { id: 'degrading', mock: { profile: 'degrading' }, providers: provider(1.5, 6) },
    { id: 'gpu', mock: { profile: 'local-gpu' }, providers: provider(0.5, 2) },
  ],
  buyer: { depositUsdc: '50' },
};

export const DURATION_MS = Number(process.env.SANDBOX_LOAD_DURATION_MS ?? 150_000);

export async function run(sb) {
  const peers = await sb.peers();
  sb.check('buyer sees every sandbox seller', sb.sellers.every((seller) => peers.some((peer) => peer.peerId === seller.peerId)), peers.map((peer) => peer.peerId));

  const result = await sb.runWorkload({ workload: 'mixed', durationMs: DURATION_MS, rateMultiplier: 1 });
  const overall = result.summary.overall;
  sb.check('every planned session issued requests', overall.requests >= result.plannedSessions && result.plannedSessions > 0, { requests: overall.requests, plannedSessions: result.plannedSessions });
  sb.check('the network keeps serving under mixed load', overall.successRate >= 0.5, { successRate: overall.successRate, errors: overall.errors });
  sb.metric('ttftP95Ms', overall.ttftMs.p95);
  sb.metric('latencyP95Ms', overall.latencyMs.p95);
  sb.metric('successRate', overall.successRate);
  sb.metric('loadSpreadGini', overall.loadSpreadGini);
  sb.metric('costPerMillionTokensUsd', overall.costPerMillionTokensUsd);
  for (const [id, seller] of Object.entries(result.summary.sellers)) {
    sb.metric(`share.${id}`, seller.share);
    sb.metric(`utilisation.${id}`, seller.utilisation ?? null);
  }

  await sb.checkInvariants({ phase: 'during' });
  await sb.closeAll();
  await sb.checkInvariants({ phase: 'final' });
}
