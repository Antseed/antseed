import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { launchProfileDesktop } from './desktop.mjs';

const require = createRequire(import.meta.url);

/** Read-only Base mainnet reads for the test wallet (deposit balance and channel settlements). */
export function mainnetReader(rpcUrl, chain) {
  const { Contract, JsonRpcProvider } = require('ethers');
  const provider = new JsonRpcProvider(rpcUrl, chain.evmChainId ?? 8453, { staticNetwork: true });
  const deposits = new Contract(chain.depositsContractAddress, ['function getBuyerBalance(address) view returns(uint256 available,uint256 reserved,uint256 lastActivityAt)'], provider);
  return {
    async buyerBalance(address) {
      const value = await deposits.getBuyerBalance(address);
      return { available: value.available, reserved: value.reserved };
    },
    close() { provider.destroy(); },
  };
}

const MEDIA_MODEL = /\b(audio|speech|tts|whisper|transcri\w*|image|video|embed\w*)\b/i;
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** A chat model by what it is: text in the catalog, text out, not a media model by name. */
function isChatModel(model) {
  if (model.type !== 'text') return false;
  const outputs = model.architecture?.output_modalities;
  if (outputs && (!outputs.includes('text') || outputs.length > 1)) return false;
  return !MEDIA_MODEL.test(`${model.id ?? ''} ${model.name ?? ''}`.replace(/[-_/.]+/g, ' '));
}

/** Billed per token at nonzero prices, with no free allowance that would serve the first requests without a payment. */
const paidOffer = (offer) => positive(offer.inputUsdPerMillion) && positive(offer.outputUsdPerMillion) && !offer.freeTier && !offer.unitBillingModels;

/** Spend stays small: offers above this many USD per million tokens, input or output, are not tried. */
export const MAX_PAID_USD_PER_MILLION = 5;
/** How many paid models one run tries before it fails. */
export const MAX_PAID_CANDIDATES = 3;

/**
 * The paid chat models of the live `/v1/models` catalog (`peers` are the live offers) worth trying, best first: more
 * than one usable seller, then lowest input + output price of a usable offer, then id.
 * Every offer must be paid: the desktop picks the seller, so one free offer or free allowance can serve the chat with
 * no SpendingAuth. A usable offer is one the buyer will actually route to: `isRoutable` (the buyer's own
 * isModelRouteEligible: trust floor and allow/block lists), within its `maxPricing` caps and at most
 * `maxUsdPerMillion`. Returns { candidates: [{ model, inputUsdPerMillion, outputUsdPerMillion, sellers }], reason }, with
 * `reason` naming what was skipped when there are none.
 */
export function rankPaidChatModels(models, { maxPricing, isRoutable = () => true, maxUsdPerMillion = MAX_PAID_USD_PER_MILLION } = {}) {
  const caps = maxPricing?.defaults ?? {};
  const withinCaps = (offer) => offer.inputUsdPerMillion <= (caps.inputUsdPerMillion ?? Infinity) && offer.outputUsdPerMillion <= (caps.outputUsdPerMillion ?? Infinity);
  const withinLimit = (offer) => offer.inputUsdPerMillion <= maxUsdPerMillion && offer.outputUsdPerMillion <= maxUsdPerMillion;
  const total = (entry) => entry.inputUsdPerMillion + entry.outputUsdPerMillion;
  const skipped = { notChat: 0, noLiveOffer: 0, freeOrUnpriced: 0, noRoutableSeller: 0, overBuyerCaps: 0, overPriceLimit: 0 };
  const candidates = [];
  for (const model of models) {
    if (!isChatModel(model)) { skipped.notChat += 1; continue; }
    const offers = model.peers ?? [];
    if (offers.length === 0) { skipped.noLiveOffer += 1; continue; }
    if (!offers.every(paidOffer)) { skipped.freeOrUnpriced += 1; continue; }
    const routable = offers.filter(isRoutable);
    if (routable.length === 0) { skipped.noRoutableSeller += 1; continue; }
    const capped = routable.filter(withinCaps);
    if (capped.length === 0) { skipped.overBuyerCaps += 1; continue; }
    const usable = capped.filter(withinLimit);
    if (usable.length === 0) { skipped.overPriceLimit += 1; continue; }
    const [cheapest] = usable.sort((a, b) => total(a) - total(b));
    candidates.push({ model, inputUsdPerMillion: cheapest.inputUsdPerMillion, outputUsdPerMillion: cheapest.outputUsdPerMillion, sellers: new Set(usable.map((offer) => offer.peerId)).size });
  }
  candidates.sort((a, b) => Number(b.sellers > 1) - Number(a.sellers > 1) || total(a) - total(b) || a.model.id.localeCompare(b.model.id));
  return { candidates, reason: candidates.length ? null : `no routable paid chat model among ${models.length} catalog entries (skipped: ${Object.entries(skipped).map(([why, count]) => `${count} ${why}`).join(', ')})` };
}

const ROUTE_UNAVAILABLE = /model_not_found|No policy-allowed peer|\b50[23]\b/;

/** True for the on-screen error (ui.sendChat throws it with `banner`) of a model nobody can serve right now. */
export function isRouteUnavailableError(error) {
  return typeof error?.banner === 'string' && ROUTE_UNAVAILABLE.test(error.banner);
}

/**
 * Runs `attempt(candidate)` on up to `max` candidates until one succeeds. Only a routing or availability error moves on
 * to the next; anything else is the run's own failure and is rethrown. Returns { candidate, result, attempts }, with
 * `candidate` null when all failed; `attempts` lists each model and its error, and `onAttempt` hears each one.
 */
export async function tryPaidCandidates(candidates, attempt, { max = MAX_PAID_CANDIDATES, onAttempt = async () => {} } = {}) {
  const attempts = [];
  const record = async (entry) => { attempts.push(entry); await onAttempt(entry); };
  for (const candidate of candidates.slice(0, max)) {
    try {
      const result = await attempt(candidate);
      await record({ model: candidate.model.id, ok: true });
      return { candidate, result, attempts };
    } catch (error) {
      if (!isRouteUnavailableError(error)) throw error;
      await record({ model: candidate.model.id, ok: false, error: error.banner });
    }
  }
  return { candidate: null, result: null, attempts };
}

/**
 * Scenario API for the full desktop on the real network. Same shape as the testbench `tb` where it makes sense
 * (check, knownIssue, metric, event, waitFor, desktop), plus real-network helpers. Signed spend is checked against
 * the per-run cap after the chat: spend above `capMicros` fails the run, but nothing stops the signature itself.
 */
export function createMainnetApi({ repo, env, instance, profile, reader, reportDir, eventsPath, capMicros, strict = false, trace = false }) {
  const checks = [];
  const knownIssues = [];
  const metrics = {};
  const desktops = [];
  let proxyUrl = null;
  const event = async (type, data = {}) => {
    await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`);
  };
  const proxy = async (path, init = {}) => {
    assert(proxyUrl, 'The desktop buyer is not running yet; call tb.desktop() first');
    return fetch(`${proxyUrl}${path}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  };

  const tb = {
    target: 'mainnet',
    wallet: profile.address,
    capMicros,
    event,
    get proxyUrl() { return proxyUrl; },
    check(name, ok, detail) {
      checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
      assert(ok, `${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    },
    knownIssue(name, ok, detail, issue) {
      const entry = { name, ok: Boolean(ok), issue, ...(detail !== undefined ? { detail } : {}) };
      knownIssues.push(entry);
      if (!entry.ok && strict) assert.fail(`${name} (known issue: ${issue}): ${JSON.stringify(detail)}`);
    },
    metric(name, value) { metrics[name] = value; },
    async waitFor(predicate, label, { timeoutMs = 60_000, intervalMs = 1000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await predicate().catch(() => null);
        if (value) return value;
        await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    },
    /** Launches the full desktop (its own buyer on the real network) under Playwright; closed after the run. */
    async desktop() {
      const ui = await launchProfileDesktop({ repo, env, instance, reportDir, event, trace });
      desktops.push(ui);
      proxyUrl = `http://127.0.0.1:${profile.buyerProxyPort}`;
      return ui;
    },
    /** Waits until the desktop's buyer answers and has discovered at least `min` sellers. */
    async waitForPeers({ min = 1, timeoutMs = 180_000 } = {}) {
      return tb.waitFor(async () => {
        const body = await (await proxy('/_antseed/peers')).json();
        return (body.peers ?? []).length >= min ? body.peers : null;
      }, `the desktop buyer discovering ${min}+ sellers`, { timeoutMs, intervalMs: 2000 });
    },
    async models() {
      const body = await (await proxy('/v1/models')).json();
      return body.data ?? [];
    },
    /** The buyer's limits on routes, read from its config the way `antseed buyer start` loads them. */
    async buyerRoutingLimits() {
      const { loadConfig } = await import(join(repo, 'apps/cli/dist/config/loader.js'));
      const { isModelRouteEligible } = await import(join(repo, 'packages/node/dist/index.js'));
      const { buyer } = await loadConfig(profile.paths.config);
      return { maxPricing: buyer.maxPricing, isRoutable: (offer) => isModelRouteEligible(offer, buyer.routingPreferences) };
    },
    /** rankPaidChatModels over the live catalog, polled until it has enough to try: seller metadata keeps arriving. */
    async paidChatModels({ timeoutMs = 60_000, intervalMs = 2000 } = {}) {
      const limits = await tb.buyerRoutingLimits();
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const ranked = rankPaidChatModels(await tb.models(), limits);
        if (ranked.candidates.length >= MAX_PAID_CANDIDATES || Date.now() >= deadline) return ranked;
        await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
      }
    },
    async channels({ all = false } = {}) {
      const body = await (await proxy(`/_antseed/channels${all ? '?all=1' : ''}`)).json();
      return body.channels ?? [];
    },
    /** Cumulative signed micro-USDC per channel; pass it to spentSince() later to get this run's spend. */
    async signedSnapshot() {
      return new Map((await tb.channels({ all: true })).map((channel) => [channel.channelId, BigInt(channel.cumulativeSigned ?? '0')]));
    },
    /** Micro-USDC signed since the snapshot, across new and reused channels. */
    async spentSince(snapshot) {
      const now = await tb.signedSnapshot();
      let spent = 0n;
      for (const [channelId, signed] of now) spent += signed - (snapshot.get(channelId) ?? 0n);
      return spent;
    },
    /** Fails the run when spend since the snapshot exceeds the per-run cap; returns the spend. */
    async assertWithinCap(snapshot) {
      const spent = await tb.spentSince(snapshot);
      tb.metric('signedThisRunMicroUsdc', String(spent));
      tb.check(`signed spend within the per-run cap (${capMicros} micro-USDC)`, spent <= capMicros, String(spent));
      return spent;
    },
    buyerBalance: () => reader.buyerBalance(profile.address),
    summary() { return { checks, knownIssues, metrics }; },
    async dispose() {
      for (const ui of desktops.splice(0)) await ui.close().catch(() => {});
      reader.close();
    },
  };
  return tb;
}
