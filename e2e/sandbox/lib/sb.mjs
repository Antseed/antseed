import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { chainReader, verifySettlement } from './chain.mjs';
import { assertLocalUrl } from './env.mjs';
import { MOCK_USAGE } from './mock.mjs';

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

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/**
 * The object every scenario receives. Talks to the buyer proxy like a real client and to the
 * supervisor control API for privileged actions. Records events, checks and metrics for the report.
 */
export function createSandboxApi({ manifest, control, eventsPath, chain, strict = false }) {
  assertLocalUrl(manifest.proxyUrl, 'proxyUrl');
  const checks = [];
  const knownIssues = [];
  const metrics = {};
  const requests = [];
  const sellersById = new Map(manifest.sellers.map((seller) => [seller.id, seller]));
  const reader = chainReader(manifest.rpcUrl, chain);
  const event = async (type, data = {}) => {
    await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`);
  };
  const proxy = async (path, init = {}) => fetch(`${manifest.proxyUrl}${path}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) });

  const sb = {
    manifest,
    proxyUrl: manifest.proxyUrl,
    rpcUrl: manifest.rpcUrl,
    sellers: manifest.sellers.map(({ id, peerId, address, models }) => ({ id, peerId, address, models })),
    seller(id) {
      const seller = sellersById.get(id);
      assert(seller, `Unknown seller ${id}`);
      return seller;
    },
    event,
    check(name, ok, detail) {
      checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
      assert(ok, `${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
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
    /** Micro-USDC the mock upstream's usage costs at the configured price of a seller's model. */
    mockCostPerChat(sellerId, model) {
      const seller = manifest.topology.sellers.find((entry) => entry.id === sellerId);
      for (const provider of Object.values(seller?.providers ?? {})) {
        const service = provider.services?.[model];
        if (!service) continue;
        const pricing = { ...(provider.defaults ?? {}), ...(service.pricing ?? {}) };
        const usd = (MOCK_USAGE.prompt_tokens * (pricing.inputUsdPerMillion ?? 0) + MOCK_USAGE.completion_tokens * (pricing.outputUsdPerMillion ?? 0)) / 1_000_000;
        return BigInt(Math.max(0, Math.round(usd * 1_000_000)));
      }
      throw new Error(`No pricing for ${sellerId}/${model}`);
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
        const seller = manifest.sellers.find((entry) => entry.peerId === channel.peerId);
        const key = seller?.id ?? channel.peerId;
        (bySeller[key] ??= []).push(channel);
      }
      return bySeller;
    },
    /** Total signed (cumulative SpendingAuth) micro-USDC per seller id across its channels. */
    async signedBySeller() {
      const bySeller = await sb.channels({ all: true });
      const totals = {};
      for (const seller of manifest.sellers) {
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
    buyerBalance: () => reader.buyerBalance(manifest.buyer.address),
    /** Exact on-chain settlement against what the buyer signed; call after closeAll(). */
    async assertSettlementMatchesSigned(expectedBySeller) {
      const expected = expectedBySeller ?? await sb.signedBySeller();
      const observed = await verifySettlement({ reader, manifest, expectedBySeller: expected });
      checks.push({ name: 'exact on-chain settlement with zero reserves', ok: true });
      await event('settlement', observed);
      return observed;
    },
    summary() {
      const latencies = requests.filter((entry) => entry.status === 200).map((entry) => entry.latencyMs);
      return { checks, knownIssues, metrics: { ...metrics, requests: requests.length, latencyP50Ms: percentile(latencies, 50), latencyP95Ms: percentile(latencies, 95) }, requests };
    },
    dispose() { reader.close(); },
  };
  return sb;
}
