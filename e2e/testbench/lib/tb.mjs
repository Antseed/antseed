import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { chainReader, verifySettlement } from './chain.mjs';
import { createRequire } from 'node:module';
import { createCliRunner } from './cli-run.mjs';
import { chainContracts } from './local-deploy.mjs';
import { launchDesktop } from './desktop.mjs';
import { assertLocalUrl } from './env.mjs';
import { MOCK_USAGE } from './mock.mjs';
import { createPrng, derive } from './prng.mjs';
import { analyzePayments, analyzeRecordedCosts, bootstrapCounts, BUYER_PATTERNS, channelRows, costLinesCheck, countPatterns, CRASH_PATTERN, externalHosts, GATES, gateProblems, logOffsets, mergeDeliveries, peerLogs, readLog, runAll, runLoad, scanLogs, SELLER_PATTERNS } from './stress.mjs';

const { keccak256, toUtf8Bytes, Wallet } = createRequire(import.meta.url)('ethers');

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

const SETTLE_WATCH_MS = 90_000;

/**
 * The object every scenario receives. Talks to the buyer proxy like a real client and to the
 * supervisor control API for privileged actions. Records events, checks and metrics for the report.
 */
export function createTestbenchApi({ manifest, control, eventsPath, chain, strict = false, repo, reportDir, trace = false, seed = 0, budgets = {}, enforceBudgets = false }) {
  assertLocalUrl(manifest.proxyUrl, 'proxyUrl');
  const checks = [];
  const knownIssues = [];
  const metrics = {};
  const requests = [];
  // One stream for the whole run: a scenario with several loads must not reuse tags, the ledgers key on them.
  const loadRandom = createPrng(derive(seed, 'load'));
  const sellersById = new Map(manifest.sellers.map((seller) => [seller.id, seller]));
  const reader = chainReader(manifest.rpcUrl, chain);
  const runner = createCliRunner({
    repo: repo ?? join(import.meta.dirname, '../../..'), manifest, event: (type, data) => event(type, data),
    chainNow: async () => Number((await reader.provider.getBlock('latest')).timestamp),
  });
  const stringify = (value) => (typeof value === 'bigint' ? String(value) : value);
  let delegations = 0;
  const event = async (type, data = {}) => {
    await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`);
  };
  const proxy = async (path, init = {}) => fetch(`${manifest.proxyUrl}${path}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) });
  const desktops = [];
  const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
  const sellerDir = (id) => join(manifest.dir, 'sellers', id);
  const logsDir = manifest.dir ? join(manifest.dir, 'logs') : null;
  const sellerLogs = logsDir ? manifest.sellers.map((seller) => join(logsDir, `seller-${seller.id}.log`)) : [];
  // Crash, leak and pattern scans and the seller's cost log cover only what this run appends.
  const logStart = logOffsets(peerLogs(logsDir).all);
  /** Records several named checks at once, then fails the run if any failed. */
  const checkAll = (entries) => {
    for (const entry of entries) checks.push({ name: entry.name, ok: Boolean(entry.ok), ...(entry.detail !== undefined ? { detail: entry.detail } : {}) });
    const failed = entries.filter((entry) => !entry.ok);
    assert(failed.length === 0, failed.map((entry) => `${entry.name}${entry.detail !== undefined ? `: ${JSON.stringify(entry.detail)}` : ''}`).join('; '));
  };

  /**
   * Ms until every channel the buyer holds now is closed on-chain, for a restart that drops them: the seller settles
   * those by itself and the load does not wait for it. Null when it had none, or they stayed open past SETTLE_WATCH_MS.
   */
  const settleAfterDrop = () => {
    const ids = channelRows(manifest.buyerDir, 'buyer').filter((row) => row.status === 'active').map((row) => row.session_id);
    if (ids.length === 0) return Promise.resolve(null);
    const started = Date.now();
    const closed = async () => {
      for (const id of ids) if ((await reader.channelState(id)).status === 1) return false;
      return true;
    };
    return tb.waitFor(closed, 'the dropped channels to settle', { timeoutMs: SETTLE_WATCH_MS }).then(() => Date.now() - started, () => null);
  };

  /** Records a budget in the metrics and returns its check; `value` may be missing when a declared key was not measured. */
  const recordBudget = (name, value, { max, unit = 'ms' }) => {
    assert(Number.isFinite(max) && max > 0, `Budget ${name} needs a positive max`);
    const ok = Number.isFinite(value) && value <= max;
    if (Number.isFinite(value)) metrics[name] = value;
    metrics.budgets = { ...metrics.budgets, [name]: { value: value ?? null, max, unit, ok, enforced: enforceBudgets } };
    return { name: `budget: ${name} <= ${max} ${unit}`, ok, detail: { value: value ?? 'not measured', max, unit } };
  };

  const tb = {
    manifest,
    /** This scenario's `topology.budgets`: the most each named timing may take. */
    budgets,
    proxyUrl: manifest.proxyUrl,
    rpcUrl: manifest.rpcUrl,
    sellers: manifest.sellers.map(({ id, peerId, address, models }) => ({ id, peerId, address, models })),
    /** A seeded `() => number` in [0, 1) for a named stream; use it instead of Math.random so the run stays replayable. */
    prng: (label) => createPrng(derive(seed, label)),
    seller(id) {
      const seller = sellersById.get(id);
      assert(seller, `Unknown seller ${id}`);
      return seller;
    },
    event,
    /** Launches the attach-only desktop on this testbench's buyer under Playwright (closed automatically after the run). */
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
     * fails the run under --strict. Use for bugs outside the testbench that a scenario exposes.
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
    /**
     * A ceiling on a measured value. Records the metric and, with --budgets, a check named `budget: <name> <= <max>
     * <unit>`; without it the value is only reported next to the budget, because CI runners and loaded laptops run
     * slower than the machine the numbers came from.
     */
    budget(name, value, limit) {
      const entry = recordBudget(name, value, limit);
      if (enforceBudgets) checkAll([entry]);
    },
    /**
     * Records measured values as metrics and holds them to `topology.budgets`: every declared key gets a budget, read
     * from `measured` or from a metric already recorded (closeAllMs), and undeclared keys stay metrics. A declared key
     * nothing measured counts as over budget, so a misspelled budget cannot pass unnoticed. Call it after the
     * scenario's other verdicts, because a budget that fails stops the run under --budgets.
     */
    timings(measured = {}) {
      const entries = Object.entries(budgets).map(([name, max]) => recordBudget(name, measured[name] ?? metrics[name], { max }));
      for (const [name, value] of Object.entries(measured)) if (!(name in budgets)) metrics[name] = value;
      if (enforceBudgets) checkAll(entries);
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
    /**
     * Any call through the buyer proxy: POST with a JSON `body` (GET without one) unless `method` says otherwise.
     * Returns { status, headers (lower-case names), json, text, latencyMs }: `text` is the raw body and `json` its
     * parsed form, null with `stream` (read the SSE from `text`) or when the body is not JSON.
     */
    async request(path, { method, body, headers = {}, stream = false, timeoutMs } = {}) {
      const hasBody = body !== undefined;
      const verb = method ?? (hasBody ? 'POST' : 'GET');
      const started = Date.now();
      const response = await proxy(path, {
        method: verb,
        headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(hasBody ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
        timeoutMs,
      });
      const text = await response.text();
      const latencyMs = Date.now() - started;
      let json = null;
      if (!stream) try { json = JSON.parse(text); } catch { /* not JSON */ }
      await event('request', { path, method: verb, stream, status: response.status, latencyMs });
      return { status: response.status, headers: Object.fromEntries(response.headers), json, text, latencyMs };
    },
    /** Chat through the proxy; pins to a seller with <peerId>@<model> when sellerId is given. */
    async chat({ model, prompt = 'Say hello.', stream = false, sellerId } = {}) {
      assert(model, 'chat needs a model');
      const routedModel = sellerId ? `${tb.seller(sellerId).peerId}@${model}` : model;
      const reply = await tb.request('/v1/chat/completions', {
        stream,
        body: { model: routedModel, messages: [{ role: 'user', content: prompt }], stream, ...(stream ? { stream_options: { include_usage: true } } : {}) },
      });
      const record = { model, sellerId: sellerId ?? null, stream, status: reply.status, latencyMs: reply.latencyMs, provider: reply.headers['x-antseed-provider'] ?? null };
      if (reply.status !== 200) {
        requests.push(record);
        await event('chat', { ...record, error: reply.text.slice(0, 500) });
        throw new Error(`chat ${routedModel} failed with ${reply.status}: ${reply.text.slice(0, 500)}`);
      }
      let content;
      let usage;
      if (stream) ({ content, usage } = parseSse(reply.text));
      else {
        assert(reply.json, `chat ${routedModel} answered 200 without JSON: ${reply.text.slice(0, 500)}`);
        content = reply.json.choices?.[0]?.message?.content ?? '';
        usage = reply.json.usage ?? null;
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
      const bySeller = await tb.channels({ all: true });
      const totals = {};
      for (const seller of manifest.sellers) {
        totals[seller.id] = (bySeller[seller.id] ?? []).reduce((sum, channel) => sum + BigInt(channel.cumulativeSigned ?? '0'), 0n);
      }
      return totals;
    },
    async mockRequests(sellerId) {
      return (await control.mockRequests(sellerId)).requests;
    },
    /** Closes every channel; metrics.closeAllMs is how long the last call took. */
    async closeAll() {
      const started = Date.now();
      const result = await control.closeChannels();
      metrics.closeAllMs = Date.now() - started;
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
    /** Crashes, unexpected peer exits, stops that needed SIGKILL, and Base-like RPC counters, since `up`. */
    health: () => control.health(),
    /** The ok-share and failure-kind gates of the stress CI (e2e/stress/ci.mjs), by name. */
    gates: GATES,

    /**
     * Concurrent paid load through the buyer proxy, as in the payment stress harness. Shape: { concurrency,
     * requests, streamRatio, abortRatio, imageRatio, minInTokens, maxInTokens }. `model` defaults to the first
     * seller's first model, `sellerId` pins it, `imageModel` serves the image share. `restart: { who: 'buyer' |
     * 'seller', sellerId, atFraction }` restarts a peer once that share is done. `gate` (a GATES entry) is evaluated
     * but not recorded, so a failed gate cannot hide the money verdict: judge first, then pass the result to
     * checkGate(), or the gate never reaches the report. A buyer restart waits for the channels it dropped to
     * settle (restart settleOnDisconnectMs). Returns { results, client, restart, loadMs, gate, gateProblems }.
     */
    async load({ model, imageModel, sellerId, restart, gate, ...shape } = {}) {
      const pin = (name) => (name && sellerId ? `${tb.seller(sellerId).peerId}@${name}` : name);
      const chosen = model ?? (sellerId ? tb.seller(sellerId) : tb.sellers[0]).models[0];
      let settled = null;
      const restartSpec = restart ? {
        atFraction: restart.atFraction,
        run: async () => {
          // A seller restart leaves the buyer's channel open (it resumes it), so only a buyer restart drops one.
          if (restart.who === 'buyer') settled = settleAfterDrop();
          if (restart.who === 'buyer') { await tb.stopBuyer(); await tb.startBuyer(); }
          else if (restart.who === 'seller') {
            const id = restart.sellerId ?? sellerId ?? tb.sellers[0].id;
            await tb.stopSeller(id);
            await tb.startSeller(id);
          } else throw new Error(`restart.who must be buyer or seller, got ${restart.who}`);
          return { who: restart.who };
        },
      } : null;
      await event('load-start', { model: chosen, sellerId: sellerId ?? null, ...shape, restart: restart ?? null });
      const run = await runLoad({ proxyUrl: manifest.proxyUrl, model: pin(chosen), imageModel: pin(imageModel), load: { ...shape, restart: restartSpec }, random: loadRandom });
      if (settled) run.restart = { ...run.restart, settleOnDisconnectMs: await settled };
      metrics.load = [...(metrics.load ?? []), { ...run.client, loadMs: run.loadMs, restart: run.restart }];
      await event('load', { client: run.client, restart: run.restart, loadMs: run.loadMs });
      return { ...run, gate, gateProblems: gate ? gateProblems(run.client, gate) : [] };
    },

    /** Records a load gate as a check: a load's result, or { client, gate, gateProblems } for several loads judged together. */
    checkGate({ client, gate, gateProblems: problems }) {
      assert(gate, 'checkGate needs a load run with a gate');
      tb.check(`load gate: at least ${Math.round(gate.minOk * 100)}% ok${gate.allowedFailures ? ', only injected failures' : ''}${gate.restart ? ', no failures outside the restart window' : ''}`, problems.length === 0, problems.length ? problems : client);
    },

    /**
     * What the payment oracle compares against later: chain balances (the buyer's deposit, the sellers' and the
     * fee recipient's USDC), the channels both stores already know (closed ones are left out of the next
     * judgement, open ones make it refuse) and the mock deliveries already recorded. Lets the oracle run on a
     * reused testbench (run --keep) and judge only what happened after the snapshot.
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
     * The payment stress oracle (e2e/stress/analysis.mjs) on this testbench: waits `quiesceMs` for in-flight
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
      assert(before.channels.open.length === 0, `The oracle needs every earlier channel closed before the snapshot; ${before.channels.open.length} were open (close them with tb.closeAll() first)`);
      const earlier = new Set(before.channels.closed);
      await sleep(quiesceMs);
      const sellerRows = () => manifest.sellers.flatMap((seller) => channelRows(sellerDir(seller.id), 'seller'));
      const sellerRowsPre = sellerRows();
      const buyerRowsPre = channelRows(manifest.buyerDir, 'buyer');
      const closed = await tb.closeAll();
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
      await tb.waitFor(readAll, 'every channel closed on-chain', { timeoutMs: 60_000, intervalMs: 1000 }).catch((error) => notes.push(error.message));
      await readAll();
      await sleep(1500);
      const fresh = (rows) => rows.filter((row) => !earlier.has(row.session_id));
      const sellerRowsPost = fresh(sellerRows());
      const buyerRowsPost = fresh(channelRows(manifest.buyerDir, 'buyer'));
      const after = await tb.paymentSnapshot();
      const ledgers = [];
      for (const seller of manifest.sellers) if (seller.mockUrl) ledgers.push(await control.deliveries(seller.id));
      const sc = { fault500Rate: injected.fault500Rate ?? 0, disconnectRate: injected.disconnectRate ?? 0, abortRatio: injected.abortRatio ?? 0, restart: injected.restart ?? null };
      const analysis = analyzePayments({ sellerRowsPre: fresh(sellerRowsPre), sellerRowsPost, buyerRowsPost, chain0: before.chain, chain1: after.chain, allIds, onchain, mockStats: mergeDeliveries(ledgers, new Set(before.deliveredTags)), results, sc });
      // Second opinion from the seller's own per-request cost lines (debug lines: stressTopology() sets ANTSEED_DEBUG).
      const costLines = await scanLogs(sellerLogs, logStart, /Cost recorded: .*?cost=(\d+)/, Infinity);
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
      const costCheck = costLinesCheck(results, recordedLines.length);
      checkAll([
        ...(analysis.violations.length
          ? analysis.violations.map((violation) => ({ name: `payment oracle: ${violation.kind}`, ok: false, detail: violation }))
          : [{ name: `payment oracle: delivered work paid exactly across ${analysis.channels.length} channel(s), deposits conserved`, ok: true, detail: analysis.money }]),
        ...(costCheck ? [costCheck] : []),
      ]);
      return analysis;
    },

    /**
     * No crash lines in peer logs, no peer that exited unexpectedly or needed SIGKILL to stop, no unhandled rejection,
     * and assertIsolated(). Records all of them before it fails, and counts SELLER_PATTERNS and BUYER_PATTERNS into
     * metrics.logPatterns.
     */
    async assertNoCrashes() {
      const health = await control.health();
      const logs = peerLogs(logsDir, manifest.logStart);
      const crashes = await scanLogs(logs.all, logStart, CRASH_PATTERN);
      metrics.logPatterns = {
        seller: await countPatterns(sellerLogs, logStart, SELLER_PATTERNS),
        buyer: await countPatterns(logs.buyer ? [logs.buyer] : [], logStart, BUYER_PATTERNS),
      };
      if (Object.keys(health.rpc ?? {}).length) metrics.rpc = health.rpc;
      const byPeer = (entries) => entries.map(({ who, ...entry }) => ({ id: who, ...entry }));
      await runAll([
        () => checkAll([
          { name: 'no crash lines in peer logs', ok: Object.keys(crashes).length === 0, detail: crashes },
          { name: 'no peer exited unexpectedly', ok: health.unexpectedExits.length === 0, detail: byPeer(health.unexpectedExits) },
          { name: 'no peer needed SIGKILL to stop', ok: health.forcedStops.length === 0, detail: byPeer(health.forcedStops) },
          { name: 'no unhandled rejections', ok: health.unhandledRejections.length === 0, detail: health.unhandledRejections },
        ]),
        () => tb.assertIsolated(),
      ]);
      return health;
    },

    /**
     * The stress harness's isolation guard: since the run started no peer log names a non-loopback IPv4 URL, and every
     * node start this testbench's sellers and buyer logged since `up` used exactly 1 bootstrap node. That line is a
     * debug line, so a node without ANTSEED_DEBUG fails here (stressTopology() sets it). Start lines predate the run,
     * so they are read from the offsets the supervisor took at `up`: logs/ outlives a new `up`.
     */
    async assertIsolated() {
      const upStart = manifest.logStart ?? {};
      const logs = peerLogs(logsDir, upStart);
      const leaks = {};
      for (const file of logs.all) {
        const hosts = externalHosts(await readLog(file, logStart[file]));
        if (hosts.length) leaks[basename(file)] = hosts;
      }
      const starts = {};
      for (const file of [...sellerLogs, ...(logs.buyer ? [logs.buyer] : [])]) starts[basename(file)] = bootstrapCounts(await readLog(file, upStart[file]));
      const nodes = Object.values(starts);
      checkAll([
        { name: 'no peer log names a non-loopback IPv4 URL', ok: Object.keys(leaks).length === 0, detail: leaks },
        { name: 'every peer started with exactly 1 bootstrap node', ok: nodes.length > 0 && nodes.every((counts) => counts.length > 0 && counts.every((count) => count === 1)), detail: starts },
      ]);
    },
    /**
     * Every contract address of this testbench's chain, by short name (registry, deposits, channels, usdc, antsToken,
     * sellerPools, sellerRegistry, usageAccounting, emissionsGate, freeUsage, verification, ...): manifest.chain.contracts,
     * which on the local chain also names the layout's contracts no chain-config field covers.
     */
    contracts: Object.freeze({ ...(manifest.chain?.contracts ?? chainContracts(chain)) }),
    /**
     * Runs this worktree's `antseed` CLI once: `antseed --data-dir <buyer dir> --config <buyer config> ...args`, in the
     * testbench's isolated environment. Options: { dataDir, configPath, home, env, timeoutMs = 60000, input, clock }.
     * `clock: 'chain'` runs the command with its clock shifted to the chain's time, for commands that compare chain
     * timestamps with Date.now() after a tb.warp (e.g. `buyer channels withdraw` after the close grace).
     * Returns { code, signal, stdout, stderr, json, durationMs, timedOut } (`json` is stdout parsed, else null) and
     * records a `cli` event with the first 2000 characters of each stream. Never throws for a failing command.
     */
    cli: (args, options) => runner.cli(args, options),
    /** tb.cli on a seller's data dir and config.json. */
    sellerCli: (id, args, options) => runner.sellerCli(id, args, options),
    /** Mints micro-USDC to an address on Anvil (MockUSDC on the local chain, the master minter on the fork). */
    async mintUsdc(address, micros) {
      await event('usdc-mint', { address, micros: String(micros) });
      return reader.mintUsdc(address, micros);
    },
    /** Moves micro-USDC from one wallet to another as the sender, by Anvil impersonation (no key needed). */
    async usdcTransfer(from, to, micros) {
      await event('usdc-transfer', { from, to, micros: String(micros) });
      return reader.usdcTransfer(from, to, micros);
    },
    /**
     * Shares a staker's seller-pool stake with the buyer for the seller's staked free tier: `amount` ANTS (decimal)
     * staked by `from` (a private key; default a staker derived from the run seed) in seller `sellerId`'s pool for
     * `epochs` (default 12), then a signed delegation to `to` (default the testbench buyer) that expires in
     * `expiresInDays` (default 90). Returns { staker, delegation, code, power }: hand `code` to
     * `tb.cli(['buyer', 'free-tier', 'add', code])`. The stake counts from the next epoch (tb.warpToNextEpoch()).
     */
    async delegateFreeTier({ from, to = manifest.buyer.address, amount, sellerId = manifest.sellers[0].id, epochs = 12, expiresInDays = 90 } = {}) {
      assert(amount !== undefined && /^\d+(\.\d{1,18})?$/.test(String(amount)) && Number(amount) > 0, 'delegateFreeTier needs amount: ANTS as a positive decimal');
      const seller = tb.seller(sellerId);
      assert(seller.agentId, `Seller ${sellerId} has no agent id`);
      const staker = from ? new Wallet(from) : new Wallet(keccak256(toUtf8Bytes(`testbench free-tier staker ${seed} ${(delegations += 1)}`)));
      const [whole, fraction = ''] = String(amount).split('.');
      const amountWei = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
      const expiresAt = Math.floor(Date.now() / 1000) + expiresInDays * 86_400;
      const result = await reader.delegateFreeTier({ staker, buyer: to, agentId: seller.agentId, amountWei, epochs, expiresAt });
      const power = String(amountWei * BigInt(epochs));
      await event('free-tier-delegation', { staker: staker.address, buyer: to, sellerId, agentId: seller.agentId, amountWei: String(amountWei), epochs, expiresAt, stakeTransaction: result.stakeTransaction });
      return { staker: staker.address, delegation: result.delegation, code: result.code, power };
    },
    /** The current emissions epoch (the emissions gate's clock on the full stack, legacy emissions' on 'payments'). */
    epoch: async () => (await reader.epochClock()).epoch,
    /** The epoch clock in chain time: { epoch, startsAt, endsAt, now } (unix seconds; endsAt is the next boundary). */
    epochClock: () => reader.epochClock(),
    /** Warps the chain to 1 s past the next epoch boundary (through the supervisor, like tb.warp). { from, to, seconds }. */
    async warpToNextEpoch() {
      const clock = await reader.epochClock();
      const seconds = clock.endsAt - clock.now + 1;
      await tb.warp(seconds);
      const after = await reader.epochClock();
      await event('epoch-warp', { from: clock.epoch, to: after.epoch, seconds });
      return { from: clock.epoch, to: after.epoch, seconds };
    },
    /**
     * A snapshot of the testbench chain (amounts as strings: micro-USDC, ANTS wei): block, epoch clock, the buyer's
     * deposit, USDC and ANTS, each seller's USDC, ANTS, eligibility and seller-pool stake, and the fee recipient's USDC.
     */
    async chainState() {
      const [block, clock, balance] = await Promise.all([reader.provider.getBlockNumber(), reader.epochClock(), reader.buyerBalance(manifest.buyer.address)]);
      const sellers = {};
      for (const seller of manifest.sellers) {
        const standing = await reader.sellerStanding(seller.address).catch((error) => ({ error: error.shortMessage ?? error.message }));
        sellers[seller.id] = {
          address: seller.address,
          usdcMicro: String(await reader.usdcBalance(seller.address)),
          antsWei: stringify(await reader.antsBalance(seller.address)),
          ...Object.fromEntries(Object.entries(standing).map(([key, value]) => [key, stringify(value)])),
        };
      }
      const feeRecipient = await reader.feeRecipient();
      return {
        block, epoch: clock,
        buyer: {
          address: manifest.buyer.address, availableMicroUsdc: String(balance.available), reservedMicroUsdc: String(balance.reserved),
          usdcMicro: String(await reader.usdcBalance(manifest.buyer.address)), antsWei: stringify(await reader.antsBalance(manifest.buyer.address)),
        },
        sellers,
        feeRecipient: { address: feeRecipient, usdcMicro: /^0x0{40}$/i.test(feeRecipient) ? '0' : String(await reader.usdcBalance(feeRecipient)) },
      };
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
    /** On-chain ChannelSettled events between the buyer and a seller since the testbench started. */
    settledEvents: (sellerId) => reader.settledEvents(manifest.buyer.address, tb.seller(sellerId).address, manifest.chainStartBlock),
    /** Exact on-chain settlement against what the buyer signed; call after closeAll(). */
    async assertSettlementMatchesSigned(expectedBySeller) {
      const expected = expectedBySeller ?? await tb.signedBySeller();
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
  return tb;
}
