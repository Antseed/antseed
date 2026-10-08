import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { chainReader, verifySettlement } from './chain.mjs';
import { assertLocalUrl } from './env.mjs';
import { checkAllowedSellers, checkChannelPeers, checkChannelSamples, checkDeliveredCost, checkRequestAccounting, checkRouterFees, checkSettlement, channelSampler, usageCostMicros } from './invariants.mjs';
import { keyMetrics, percentile, summarizeWorkload } from './metrics.mjs';
import { MOCK_USAGE } from './mock.mjs';
import { executePlan, normalizeWorkload, planWorkload, proxySender } from './workload.mjs';

/** Parses an OpenAI SSE stream into its text and the final usage chunk. */
export function parseSse(text) {
  let content = '';
  let usage = null;
  let done = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') { done = true; continue; }
    const chunk = JSON.parse(data);
    for (const choice of chunk.choices ?? []) content += choice.delta?.content ?? '';
    if (chunk.usage) usage = chunk.usage;
  }
  return { content, usage, done };
}

/**
 * The object every scenario receives. Talks to the buyer proxy like a real client and to the
 * supervisor control API for privileged actions. Records events, checks and metrics for the report.
 */
export function createSandboxApi({ manifest, control, eventsPath, chain, strict = false, seed = 1 }) {
  assertLocalUrl(manifest.proxyUrl, 'proxyUrl');
  const checks = [];
  const knownIssues = [];
  const metrics = {};
  const requests = [];
  const workloads = [];
  const invariants = [];
  const channelSamples = [];
  let finalChecked = false;
  const baseline = { ranked: {}, signed: {} };
  const big = (value) => BigInt(value ?? 0);
  const runTag = Date.now().toString(36);
  const sellersById = new Map(manifest.sellers.map((seller) => [seller.id, seller]));
  const routersById = new Map((manifest.routers ?? []).map((router) => [router.id, router]));
  const reader = chainReader(manifest.rpcUrl, chain);
  const event = async (type, data = {}) => {
    await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`);
  };
  const proxy = async (path, init = {}) => fetch(`${manifest.proxyUrl}${path}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) });

  const sb = {
    manifest,
    seed,
    proxyUrl: manifest.proxyUrl,
    rpcUrl: manifest.rpcUrl,
    sellers: manifest.sellers.map(({ id, peerId, address, models }) => ({ id, peerId, address, models })),
    routers: (manifest.routers ?? []).map(({ id, peerId, address, provider, serviceId, priceUsd }) => ({ id, peerId, address, provider, serviceId, priceUsd })),
    router(id) {
      const router = routersById.get(id);
      assert(router, `Unknown router ${id}`);
      return router;
    },
    seller(id) {
      const seller = sellersById.get(id);
      assert(seller, `Unknown seller ${id}`);
      return seller;
    },
    event,
    /** Hard check: recorded, and stops the scenario when it fails (use for preconditions later steps need). */
    check(name, ok, detail) {
      checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
      assert(ok, `${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    },
    /** Soft check: recorded and fails the run, but the scenario keeps going so every failure is reported. */
    expect(name, ok, detail) {
      checks.push({ name, ok: Boolean(ok), soft: true, ...(detail !== undefined ? { detail } : {}) });
      return Boolean(ok);
    },
    /**
     * A check that documents a known, tracked defect: recorded in the report (ok true/false) but only
     * fails the run under --strict. Use for bugs outside the sandbox that a scenario exposes.
     */
    knownIssue(name, ok, detail, issue) {
      const entry = { name, ok: Boolean(ok), issue, ...(detail !== undefined ? { detail } : {}) };
      knownIssues.push(entry);
      if (!entry.ok && strict) assert.fail(`${name} (known issue: ${issue}): ${JSON.stringify(detail)}`);
    },
    /** Configured token pricing (USD per million) of a seller's model. */
    pricing(sellerId, model) {
      const seller = manifest.topology.sellers.find((entry) => entry.id === sellerId);
      for (const provider of Object.values(seller?.providers ?? {})) {
        const service = provider.services?.[model];
        if (service) return { ...(provider.defaults ?? {}), ...(service.pricing ?? {}) };
      }
      throw new Error(`No pricing for ${sellerId}/${model}`);
    },
    /** Micro-USDC the mock upstream's fixed usage costs at the configured price of a seller's model. */
    mockCostPerChat(sellerId, model) {
      return usageCostMicros(MOCK_USAGE, sb.pricing(sellerId, model));
    },
    /** Micro-USDC of every chat the seller's mock completed, at the seller's configured prices. */
    async deliveredCost(sellerId) {
      const entries = await sb.mockRequests(sellerId);
      return entries.filter((entry) => entry.outcome === 'ok' && entry.usage && entry.model)
        .reduce((sum, entry) => sum + usageCostMicros(entry.usage, sb.pricing(sellerId, entry.model)), 0n);
    },
    metric(name, value) {
      metrics[name] = value;
    },
    async catalog() {
      const response = await proxy('/v1/models');
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body.data ?? [];
    },
    async peers() {
      const body = await (await proxy('/_antseed/peers')).json();
      return body.peers ?? [];
    },
    async routingServices() {
      const response = await proxy('/_antseed/routing-services');
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body.services ?? [];
    },
    async route(body) {
      const response = await proxy('/_antseed/route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      await event('route', body);
      return result;
    },
    async useRouter(id, { costQualityTradeoff = 5, allowedModels } = {}) {
      const router = sb.router(id);
      return sb.route({ router: { service: { peerId: router.peerId, provider: router.provider, serviceId: router.serviceId }, costQualityTradeoff, ...(allowedModels ? { allowedModels } : {}) } });
    },
    /** Chat through the proxy; pins to a seller with <peerId>@<model> when sellerId is given. */
    async chat({ model, prompt = 'Say hello.', stream = false, sellerId } = {}) {
      assert(model, 'chat needs a model');
      const routedModel = sellerId ? `${sb.seller(sellerId).peerId}@${model}` : model;
      const started = Date.now();
      const response = await proxy('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: routedModel, messages: [{ role: 'user', content: prompt }], stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }),
      });
      const text = await response.text();
      const latencyMs = Date.now() - started;
      const record = { model, sellerId: sellerId ?? null, stream, status: response.status, latencyMs, provider: response.headers.get('x-antseed-provider') };
      if (response.status !== 200) {
        requests.push(record);
        await event('chat', { ...record, error: text.slice(0, 500) });
        throw new Error(`chat ${routedModel} failed with ${response.status}: ${text.slice(0, 500)}`);
      }
      let content;
      let usage;
      if (stream) ({ content, usage } = parseSse(text));
      else {
        const body = JSON.parse(text);
        content = body.choices?.[0]?.message?.content ?? '';
        usage = body.usage ?? null;
      }
      Object.assign(record, { content, usage });
      requests.push(record);
      await event('chat', record);
      return record;
    },
    /** Buyer channels per seller id (signed cumulative amounts and request counts). */
    async channels({ all = false } = {}) {
      const body = await (await proxy(`/_antseed/channels${all ? '?all=1' : ''}`)).json();
      const bySeller = {};
      for (const channel of body.channels ?? []) {
        const seller = [...manifest.sellers, ...(manifest.routers ?? [])].find((entry) => entry.peerId === channel.peerId);
        const key = seller?.id ?? channel.peerId;
        (bySeller[key] ??= []).push(channel);
      }
      return bySeller;
    },
    /** Total signed (cumulative SpendingAuth) micro-USDC per seller id across its channels. */
    async signedBySeller() {
      const bySeller = await sb.channels({ all: true });
      const totals = {};
      for (const seller of [...manifest.sellers, ...(manifest.routers ?? [])]) {
        totals[seller.id] = (bySeller[seller.id] ?? []).reduce((sum, channel) => sum + BigInt(channel.cumulativeSigned ?? '0'), 0n);
      }
      return totals;
    },
    async mockRequests(sellerId) {
      return (await control.mockRequests(sellerId)).requests;
    },
    async closeAll() {
      const result = await control.closeChannels();
      await event('channels-closed', result);
      return result;
    },
    async closeChannel(sellerId) {
      const result = await control.closeChannels(sellerId);
      await event('channel-closed', { sellerId, ...result });
      return result;
    },
    warp: async (seconds) => { await event('warp', { seconds }); return control.warp(seconds); },
    stopSeller: async (id) => { await event('seller-stop', { id }); return control.stopSeller(id); },
    startSeller: async (id) => { await event('seller-start', { id }); return control.startSeller(id); },
    setMockLatency: async (id, latencyMs) => { await event('mock-latency', { id, latencyMs }); return control.setMockLatency(id, latencyMs); },
    /** Patches a seller's mock profile at runtime (same shape as topology sellers[].mock). */
    setMockProfile: async (id, patch, options) => { await event('mock-profile', { id, patch }); return (await control.setMockProfile(id, patch, options)).profile; },
    /** The seller mock's current raw profile (to restore it after a temporary patch). */
    async mockProfileRaw(id) {
      return (await control.mockRequests(id)).raw ?? null;
    },
    /** Sandbox router counters: rankings served and rejected since the router started. */
    routerStats: (id) => control.routerStats(id),
    /** Per-seller mock counters: served, errors, queue peak, slot utilisation. */
    async mockStats(sellerId) {
      return (await control.mockRequests(sellerId)).stats;
    },
    buyerBalance: () => reader.buyerBalance(manifest.buyer.address),
    /** Exact on-chain settlement against what the buyer signed; call after closeAll(). */
    async assertSettlementMatchesSigned(expectedBySeller) {
      const expected = expectedBySeller ?? await sb.signedBySeller();
      const observed = await verifySettlement({ reader, manifest, expectedBySeller: expected });
      checks.push({ name: 'exact on-chain settlement with zero reserves', ok: true });
      await event('settlement', observed);
      return observed;
    },
    /**
     * Runs a workload open-loop through the buyer proxy. Arrivals follow the plan (seeded) regardless of
     * response times; `timeline` actions (e.g. stop a seller) run at their offsets. Samples buyer channels
     * during the run for the invariant checker. Returns { plan, records, events, summary }.
     */
    async runWorkload({ workload = 'mixed', durationMs = 120_000, seed = sb.seed, rateMultiplier = 1, models, maxInFlight, timeline = [], label, sampleIntervalMs = 1000 } = {}) {
      const spec = normalizeWorkload(workload);
      const catalogModels = models ?? [...new Set(sb.sellers.flatMap((seller) => seller.models))];
      const plan = planWorkload({ workload: spec, models: catalogModels, durationMs, seed, rateMultiplier });
      const name = label ?? `${spec.name}${workloads.length ? `-${workloads.length + 1}` : ''}`;
      const signedBefore = await sb.signedBySeller();
      const statsBefore = {};
      for (const seller of sb.sellers) statsBefore[seller.id] = await sb.mockStats(seller.id).catch(() => null);
      await event('workload-start', { name, workload: spec.name, seed, rateMultiplier, durationMs, sessions: plan.sessions.length, turns: plan.sessions.reduce((sum, session) => sum + session.turns.length, 0) });
      const sampler = channelSampler(async () => (await (await proxy('/_antseed/channels?all=1', { timeoutMs: 10_000 })).json()).channels ?? [], { intervalMs: sampleIntervalMs });
      sampler.start();
      const sellersByPeerId = new Map(manifest.sellers.map((seller) => [seller.peerId, seller.id]));
      const result = await executePlan(plan, {
        send: proxySender({ proxyUrl: manifest.proxyUrl, sellersByPeerId }),
        maxInFlight: maxInFlight ?? plan.maxInFlight,
        timeline,
        requestPrefix: `${runTag}-${workloads.length + 1}-`,
      });
      channelSamples.push(...(await sampler.stop()));
      const signedAfter = await sb.signedBySeller();
      const signedDeltaBySeller = Object.fromEntries(Object.keys(signedAfter).map((id) => [id, signedAfter[id] - (signedBefore[id] ?? 0n)]));
      const mockStats = {};
      for (const seller of sb.sellers) {
        const after = await sb.mockStats(seller.id).catch(() => null);
        const before = statsBefore[seller.id];
        if (after && before) {
          const wallMs = Math.max(1, after.wallMs - before.wallMs);
          const slots = after.slots;
          mockStats[seller.id] = {
            served: after.served - before.served,
            rateLimited: after.rateLimited - before.rateLimited,
            peakQueue: after.peakQueue,
            utilisation: slots ? (after.busySlotMs - before.busySlotMs) / (slots * wallMs) : null,
          };
        }
      }
      const summary = summarizeWorkload(result.records, {
        wallMs: result.wallMs, sellers: sb.sellers.map((seller) => seller.id), mockStats, signedDeltaBySeller,
        skippedTurns: result.skippedTurns, peakInFlight: result.peakInFlight,
      });
      const entry = { name, workload: spec.name, seed, rateMultiplier, durationMs, plannedSessions: plan.sessions.length, records: result.records, events: result.events, summary };
      workloads.push(entry);
      await event('workload-end', { name, overall: summary.overall, timeline: result.events });
      return { plan, ...entry };
    },
    /**
     * Global invariants over everything this run recorded. They run after every scenario (the runner calls
     * finish()), so scenarios only check what is specific to them. Never throws: each result is recorded as
     * a check (failing the run) or, when `known`, as a known issue.
     *  - phase 'during' (channels open): signed cumulative is monotonic and within the reserve, workload
     *    requests were served only by sandbox sellers, buyer successes match mock completions, channels are
     *    only with sandbox peers.
     *  - phase 'final' (after closeAll): settled on-chain equals the buyer's final signed amount for every
     *    seller and router, reserves are zero, router fees equal rankings x price, settled vs delivered work.
     */
    async checkInvariants({ phase = 'final', signedBySeller } = {}) {
      const records = workloads.flatMap((entry) => entry.records);
      const results = [];
      const guard = async (name, fn) => {
        try {
          const value = await fn();
          results.push(...(Array.isArray(value) ? value : [value]));
        } catch (error) {
          results.push({ name, ok: false, detail: { error: error.message } });
        }
      };
      const peers = [...manifest.sellers, ...(manifest.routers ?? [])];
      let channelsNow = [];
      await guard('buyer channels readable', async () => {
        channelsNow = (await (await proxy('/_antseed/channels?all=1', { timeoutMs: 10_000 })).json()).channels ?? [];
        channelSamples.push({ atMs: null, channels: channelsNow });
        return [...checkChannelSamples(channelSamples), checkChannelPeers(channelsNow, peers.map((peer) => peer.peerId))];
      });
      if (records.length) {
        results.push(checkAllowedSellers(records, sb.sellers.map((seller) => seller.id)));
        if (manifest.upstream === 'mock') {
          await guard('buyer successes match mock-served requests', async () => {
            const bySeller = {};
            for (const seller of sb.sellers) bySeller[seller.id] = await sb.mockRequests(seller.id);
            return checkRequestAccounting(records, bySeller);
          });
        }
      }
      if (phase === 'final') {
        await guard('on-chain settlement', async () => {
          const signed = signedBySeller ?? await sb.signedBySeller();
          const settledBySeller = {};
          for (const peer of peers) {
            const events = await reader.settledEvents(manifest.buyer.address, peer.address, manifest.chainStartBlock);
            settledBySeller[peer.id] = events.reduce((sum, item) => sum + item.args.delta, 0n);
          }
          const balance = await reader.buyerBalance(manifest.buyer.address);
          const out = checkSettlement({ signedBySeller: signed, settledBySeller, reservedMicroUsdc: balance.reserved });
          if ((manifest.routers ?? []).length) {
            // Per run: rankings served and router fees signed since begin() (a sandbox can run several seeds).
            const rankedByRouter = {};
            const signedDelta = {};
            for (const router of manifest.routers) {
              rankedByRouter[router.id] = (await control.routerStats(router.id)).ranked - (baseline.ranked[router.id] ?? 0);
              signedDelta[router.id] = big(signed[router.id]) - big(baseline.signed[router.id]);
            }
            out.push(checkRouterFees({ routers: manifest.routers, signedBySeller: signedDelta, rankedByRouter }));
          }
          if (manifest.upstream === 'mock') {
            const sellerSettled = Object.fromEntries(sb.sellers.map((seller) => [seller.id, settledBySeller[seller.id]]));
            const deliveredBySeller = {};
            for (const seller of sb.sellers) deliveredBySeller[seller.id] = await sb.deliveredCost(seller.id);
            out.push(checkDeliveredCost({ settledBySeller: sellerSettled, deliveredBySeller }));
          }
          return out;
        });
        finalChecked = true;
      }
      for (const entry of results) {
        const recorded = { phase, ...entry };
        invariants.push(recorded);
        if (entry.known) sb.knownIssue(`invariant: ${entry.name}`, entry.ok, entry.detail, entry.issue);
        else checks.push({ name: `invariant (${phase}): ${entry.name}`, ok: entry.ok, soft: true, detail: entry.detail });
      }
      await event('invariants', { phase, results: results.map(({ name, ok }) => ({ name, ok })) });
      return results;
    },
    /** Start of every scenario run (called by the runner): baselines for per-run invariants. */
    async begin() {
      baseline.signed = await sb.signedBySeller();
      for (const router of manifest.routers ?? []) baseline.ranked[router.id] = (await control.routerStats(router.id)).ranked;
    },
    /**
     * End of every scenario run (called by the runner, also after a failed run): 'during' invariants,
     * close all channels, 'final' invariants. Skipped when the scenario already ran the final phase.
     */
    async finish() {
      if (finalChecked) return;
      await sb.checkInvariants({ phase: 'during' });
      try {
        await sb.closeAll();
      } catch (error) {
        checks.push({ name: 'channels close cooperatively at the end of the run', ok: false, soft: true, detail: { error: error.message } });
        return;
      }
      await sb.checkInvariants({ phase: 'final' });
    },
    /** Names of failed checks (hard or soft); a run passes only when this is empty. */
    failures() {
      return checks.filter((entry) => !entry.ok).map((entry) => entry.name);
    },
    summary() {
      const latencies = requests.filter((entry) => entry.status === 200).map((entry) => entry.latencyMs);
      const workloadSummaries = Object.fromEntries(workloads.map((entry) => [entry.name, { workload: entry.workload, seed: entry.seed, rateMultiplier: entry.rateMultiplier, durationMs: entry.durationMs, plannedSessions: entry.plannedSessions, timeline: entry.events, ...entry.summary }]));
      const last = workloads.at(-1);
      return {
        checks,
        knownIssues,
        metrics: { ...metrics, requests: requests.length, latencyP50Ms: percentile(latencies, 50), latencyP95Ms: percentile(latencies, 95), ...(last ? { workload: keyMetrics(last.summary) } : {}) },
        requests,
        workloads: workloadSummaries,
        workloadRecords: workloads.flatMap((entry) => entry.records.map((record) => ({ workload: entry.name, ...record }))),
        invariants,
      };
    },
    dispose() { reader.close(); },
  };
  return sb;
}
