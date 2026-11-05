import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chainReader, verifySettlement } from './chain.mjs';
import { launchDesktop } from './desktop.mjs';
import { assertLocalUrl } from './env.mjs';
import { MOCK_USAGE } from './mock.mjs';
import { analyzePayments, analyzeRecordedCosts, channelRows, CRASH_PATTERN, GATES, gateProblems, logOffsets, mergeDeliveries, runLoad, scanLogs } from './stress.mjs';

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
export function createSandboxApi({ manifest, control, eventsPath, chain, strict = false, repo, reportDir, trace = false }) {
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
  const desktops = [];
  const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
  const sellerDir = (id) => join(manifest.dir, 'sellers', id);
  const sellerLogs = manifest.dir ? manifest.sellers.map((seller) => join(manifest.dir, 'logs', `seller-${seller.id}.log`)) : [];
  const peerLogs = manifest.dir ? [join(manifest.dir, 'logs', 'supervisor.log'), ...sellerLogs] : [];
  // Crash scans and the seller's cost log cover only what this run appends.
  const logStart = logOffsets(peerLogs);
  /** Records several named checks at once, then fails the run if any failed. */
  const checkAll = (entries) => {
    for (const entry of entries) checks.push({ name: entry.name, ok: Boolean(entry.ok), ...(entry.detail !== undefined ? { detail: entry.detail } : {}) });
    const failed = entries.filter((entry) => !entry.ok);
    assert(failed.length === 0, failed.map((entry) => `${entry.name}${entry.detail !== undefined ? `: ${JSON.stringify(entry.detail)}` : ''}`).join('; '));
  };

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
    /** Launches the attach-only desktop on this sandbox's buyer under Playwright (closed automatically after the run). */
    async desktop() {
      assert(repo && reportDir, 'desktop() needs the repo and report directory');
      const ui = await launchDesktop({ repo, manifest, reportDir, event, trace });
      desktops.push(ui);
      return ui;
    },
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
    /** Stops the buyer node and proxy, like a user quitting: sellers see the disconnect and settle on their own. */
    stopBuyer: async () => { await event('buyer-stop'); return control.stopBuyer(); },
    /** Restarts the buyer node and proxy on the same proxy URL and rediscovers online sellers. */
    startBuyer: async () => { await event('buyer-start'); return control.startBuyer(); },
    /** Polls until the predicate returns a truthy value (default 60s); returns it. */
    async waitFor(predicate, label, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    },
    /** Fault injection. Use only to reach a state no public path produces; say why in the scenario. */
    faults: {
      /** The buyer drops the next `count` NeedAuth frames from sellers, as if lost on the wire (0 disarms). Clears lostNeedAuths(). */
      loseNeedAuths: async (count) => { await event('fault-lose-need-auths', { count }); return control.loseNeedAuths(count); },
      /** The NeedAuth payloads dropped since the fault was last armed, oldest first (`lastRequestCost` is absent on a 402 catch-up). */
      lostNeedAuths: async () => (await control.needAuthLoss()).lost,
    },
    setMockLatency: async (id, latencyMs) => { await event('mock-latency', { id, latencyMs }); return control.setMockLatency(id, latencyMs); },
    /** Upstream faults on a seller's mock from now on: { fault500Rate, disconnectRate } (0..1 each; 0 turns one off). */
    setMockFaults: async (id, faults) => { await event('mock-faults', { id, ...faults }); return control.setMockFaults(id, faults); },
    /** A seller mock's delivery ledger: per `[req:TAG]` what reached the wire and its cost, plus totals. */
    deliveries: (id) => control.deliveries(id),
    /** Crashes, unexpected seller exits, stops that needed SIGKILL, and Base-like RPC counters, since `up`. */
    health: () => control.health(),
    /** The ok-share and failure-kind gates of the stress CI (e2e/stress/ci.mjs), by name. */
    gates: GATES,

    /**
     * Concurrent paid load through the buyer proxy, as in the payment stress harness. Shape: { concurrency,
     * requests, streamRatio, abortRatio, imageRatio, minInTokens, maxInTokens }. `model` defaults to the first
     * seller's first model, `sellerId` pins it, `imageModel` serves the image share. `restart: { who: 'buyer' |
     * 'seller', sellerId, atFraction }` restarts a peer once that share is done. `gate` (a GATES entry) records the
     * ok-share check. Returns { results, client, restart, loadMs }.
     */
    async load({ model, imageModel, sellerId, restart, gate, ...shape } = {}) {
      const pin = (name) => (name && sellerId ? `${sb.seller(sellerId).peerId}@${name}` : name);
      const chosen = model ?? (sellerId ? sb.seller(sellerId) : sb.sellers[0]).models[0];
      const restartSpec = restart ? {
        atFraction: restart.atFraction,
        run: async () => {
          if (restart.who === 'buyer') { await sb.stopBuyer(); await sb.startBuyer(); }
          else if (restart.who === 'seller') {
            const id = restart.sellerId ?? sellerId ?? sb.sellers[0].id;
            await sb.stopSeller(id);
            await sb.startSeller(id);
          } else throw new Error(`restart.who must be buyer or seller, got ${restart.who}`);
          return { who: restart.who };
        },
      } : null;
      await event('load-start', { model: chosen, sellerId: sellerId ?? null, ...shape, restart: restart ?? null });
      const run = await runLoad({ proxyUrl: manifest.proxyUrl, model: pin(chosen), imageModel: pin(imageModel), load: { ...shape, restart: restartSpec } });
      metrics.load = [...(metrics.load ?? []), { ...run.client, loadMs: run.loadMs, restart: run.restart }];
      await event('load', { client: run.client, restart: run.restart, loadMs: run.loadMs });
      if (gate) {
        const problems = gateProblems(run.client, gate);
        sb.check(`load gate: at least ${Math.round(gate.minOk * 100)}% ok${gate.allowedFailures ? ', only injected failures' : ''}${gate.restart ? ', no failures outside the restart window' : ''}`, problems.length === 0, problems.length ? problems : run.client);
      }
      return run;
    },

    /**
     * What the payment oracle compares against later: chain balances (the buyer's deposit, the sellers' and the
     * fee recipient's USDC), the channels both stores already know (closed ones are left out of the next
     * judgement, open ones make it refuse) and the mock deliveries already recorded. Lets the oracle run on a
     * reused sandbox (run --keep) and judge only what happened after the snapshot.
     */
    async paymentSnapshot() {
      const chainBalances = await reader.paymentSnapshot(manifest.buyer.address, manifest.sellers.map((seller) => seller.address));
      const ids = [...new Set([...manifest.sellers.flatMap((seller) => channelRows(sellerDir(seller.id), 'seller')), ...channelRows(manifest.buyerDir, 'buyer')].map((row) => row.session_id))];
      const channels = { closed: [], open: [] };
      for (const id of ids) channels[(await reader.channelState(id)).status === 1 ? 'open' : 'closed'].push(id);
      const deliveredTags = [];
      for (const seller of manifest.sellers) if (seller.mockUrl) deliveredTags.push(...Object.keys((await control.deliveries(seller.id)).byTag));
      return { chain: chainBalances, channels, deliveredTags };
    },

    /**
     * The payment stress oracle (e2e/stress/analysis.mjs) on this sandbox: waits `quiesceMs` for in-flight
     * auths, closes every channel cooperatively, then compares the sellers' and buyer's channel stores, the
     * chain and the mock ledgers. The mock is the judge: every response the client received in full was
     * delivered and paid, nothing settled beyond what reached the wire, each channel settled exactly what the
     * buyer signed and the seller accepted, the deposit decrease equals the sum settled and seller plus fee
     * income equals it, no reserve or open channel is left. With no faults, aborts or restarts the seller's
     * recorded spend must equal the delivered cost exactly. `before` is a paymentSnapshot taken before the load;
     * `results` are load results; `injected` names what the run injected ({ fault500Rate, disconnectRate,
     * abortRatio, restart }) so the fault-free rule applies only when nothing was.
     */
    async assertDeliveredWorkPaid({ before, results = [], injected = {}, quiesceMs = 10_000 } = {}) {
      assert(before?.chain, 'assertDeliveredWorkPaid needs the paymentSnapshot taken before the load');
      assert(before.channels.open.length === 0, `The oracle needs every earlier channel closed before the snapshot; ${before.channels.open.length} were open (close them with sb.closeAll() first)`);
      const earlier = new Set(before.channels.closed);
      await sleep(quiesceMs);
      const sellerRows = () => manifest.sellers.flatMap((seller) => channelRows(sellerDir(seller.id), 'seller'));
      const sellerRowsPre = sellerRows();
      const buyerRowsPre = channelRows(manifest.buyerDir, 'buyer');
      const closed = await sb.closeAll();
      const allIds = [...new Set([...sellerRowsPre, ...buyerRowsPre].map((row) => row.session_id))].filter((id) => !earlier.has(id));
      const onchain = {};
      const readAll = async () => {
        for (const id of allIds) {
          const row = await reader.channelState(id);
          onchain[id] = { settled: BigInt(row.settled), deposit: BigInt(row.deposit), status: row.status };
        }
        return Object.values(onchain).every((row) => row.status !== 1);
      };
      const notes = [];
      await sb.waitFor(readAll, 'every channel closed on-chain', { timeoutMs: 60_000, intervalMs: 1000 }).catch((error) => notes.push(error.message));
      await readAll();
      await sleep(1500);
      const fresh = (rows) => rows.filter((row) => !earlier.has(row.session_id));
      const sellerRowsPost = fresh(sellerRows());
      const buyerRowsPost = fresh(channelRows(manifest.buyerDir, 'buyer'));
      const after = await sb.paymentSnapshot();
      const ledgers = [];
      for (const seller of manifest.sellers) if (seller.mockUrl) ledgers.push(await control.deliveries(seller.id));
      const sc = { fault500Rate: injected.fault500Rate ?? 0, disconnectRate: injected.disconnectRate ?? 0, abortRatio: injected.abortRatio ?? 0, restart: injected.restart ?? null };
      const analysis = analyzePayments({ sellerRowsPre: fresh(sellerRowsPre), sellerRowsPost, buyerRowsPost, chain0: before.chain, chain1: after.chain, allIds, onchain, mockStats: mergeDeliveries(ledgers, new Set(before.deliveredTags)), results, sc });
      // Second opinion from the seller's own per-request cost lines, when it logs them (ANTSEED_DEBUG).
      const costLines = await scanLogs(sellerLogs, await logStart, /Cost recorded: .*?cost=(\d+)/, Infinity);
      const recordedLines = Object.values(costLines).flatMap((hit) => hit.examples);
      if (recordedLines.length) {
        const recordedCost = recordedLines.reduce((sum, line) => sum + BigInt(line.match(/cost=(\d+)/)[1]), 0n);
        const recorded = analyzeRecordedCosts({ recordedCost, recordedCount: recordedLines.length, settled: BigInt(analysis.money.onchainSettled) });
        Object.assign(analysis.money, recorded.money);
        analysis.violations.push(...recorded.violations);
      }
      analysis.notes.push(...notes);
      metrics.money = analysis.money;
      metrics.channels = analysis.channels.length;
      await event('payment-oracle', { closed, ...analysis });
      checkAll(analysis.violations.length
        ? analysis.violations.map((violation) => ({ name: `payment oracle: ${violation.kind}`, ok: false, detail: violation }))
        : [{ name: `payment oracle: delivered work paid exactly across ${analysis.channels.length} channel(s), deposits conserved`, ok: true, detail: analysis.money }]);
      return analysis;
    },

    /** No crash lines in peer logs, no unexpected seller exit, no stop that needed SIGKILL, no unhandled rejection. */
    async assertNoCrashes() {
      const health = await control.health();
      const crashes = await scanLogs(peerLogs, await logStart, CRASH_PATTERN);
      checkAll([
        { name: 'no crash lines in peer logs', ok: Object.keys(crashes).length === 0, detail: crashes },
        { name: 'no seller exited unexpectedly', ok: health.unexpectedExits.length === 0, detail: health.unexpectedExits },
        { name: 'every stop finished without SIGKILL', ok: health.forcedStops.length === 0, detail: health.forcedStops },
        { name: 'no unhandled rejections', ok: health.unhandledRejections.length === 0, detail: health.unhandledRejections },
      ]);
      if (Object.keys(health.rpc ?? {}).length) metrics.rpc = health.rpc;
      return health;
    },
    buyerBalance: () => reader.buyerBalance(manifest.buyer.address),
    /** On-chain state of a channel: { status (1 Active, 2 Settled, 3 TimedOut), deposit, settled, closeRequestedAt }. */
    channelState: (channelId) => reader.channelState(channelId),
    /**
     * The buyer's unilateral exit, sent on-chain behind the buyer node's back (like another device or a
     * recovery tool would): requestClose now, withdraw after the 15 min grace (warp first).
     */
    async buyerRequestClose(channelId) {
      await event('buyer-request-close', { channelId });
      return reader.sendAs(manifest.buyer.address, 'requestClose', [channelId]);
    },
    async buyerWithdraw(channelId) {
      await event('buyer-withdraw', { channelId });
      return reader.sendAs(manifest.buyer.address, 'withdraw', [channelId]);
    },
    usdcBalance: (address) => reader.usdcBalance(address),
    /** On-chain ChannelSettled events between the buyer and a seller since the sandbox started. */
    settledEvents: (sellerId) => reader.settledEvents(manifest.buyer.address, sb.seller(sellerId).address, manifest.chainStartBlock),
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
    async dispose() {
      for (const ui of desktops.splice(0)) await ui.close();
      reader.close();
    },
  };
  return sb;
}
