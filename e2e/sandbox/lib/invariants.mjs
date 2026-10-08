const big = (value) => BigInt(value ?? 0);

function result(name, ok, detail, extra = {}) {
  return { name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}), ...extra };
}

/**
 * Channel samples are `{ atMs, channels: [{ channelId, peerId, cumulativeSigned, reserveCeiling, status }] }`
 * snapshots of the buyer's /_antseed/channels?all=1. Per channel, the signed cumulative amount must never
 * decrease and must stay within the reserve ceiling whenever the ceiling is known.
 */
export function checkChannelSamples(samples) {
  const last = new Map();
  const regressions = [];
  const overReserve = [];
  for (const sample of samples) {
    for (const channel of sample.channels ?? []) {
      const signed = big(channel.cumulativeSigned);
      const previous = last.get(channel.channelId);
      if (previous !== undefined && signed < previous.signed) {
        regressions.push({ channelId: channel.channelId, atMs: sample.atMs, from: String(previous.signed), to: String(signed) });
      }
      last.set(channel.channelId, { signed, atMs: sample.atMs });
      if (channel.reserveCeiling !== null && channel.reserveCeiling !== undefined && signed > big(channel.reserveCeiling)) {
        overReserve.push({ channelId: channel.channelId, atMs: sample.atMs, signed: String(signed), reserve: String(channel.reserveCeiling) });
      }
    }
  }
  return [
    result('buyer signed cumulative is monotonic per channel', regressions.length === 0, { samples: samples.length, channels: last.size, regressions: regressions.slice(0, 10) }),
    result('buyer signed cumulative stays within the reserve', overReserve.length === 0, { violations: overReserve.slice(0, 10) }),
  ];
}

/** Every request record with a seller attribution names a sandbox seller. */
export function checkAllowedSellers(records, allowedSellerIds) {
  const allowed = new Set(allowedSellerIds);
  const foreign = records.filter((record) => record.sellerId && !allowed.has(record.sellerId));
  const unattributed = records.filter((record) => record.ok && !record.sellerId);
  return result('every request was served by an allowed sandbox seller', foreign.length === 0 && unattributed.length === 0, {
    foreign: foreign.slice(0, 10).map((record) => ({ requestId: record.requestId, sellerId: record.sellerId })),
    unattributedSuccesses: unattributed.length,
  });
}

/**
 * Buyer-side successes vs mock-side completions, matched per request through the x-sandbox-request-id
 * tag the workload sends (mock entries without one of these tags, e.g. from sb.chat or an earlier run,
 * are ignored). Every buyer success
 * must have a completed mock request with the same tag on the seller the proxy reported. The mock may
 * complete more than the buyer saw (a proxy retry after a failed attempt elsewhere, a client abandon
 * after the mock finished, truncation in between); those surplus completions are documented failures,
 * allowed up to the number of buyer-side failures, never more.
 */
export function checkRequestAccounting(records, mockRequestsBySeller) {
  const completedBy = new Map();
  const perSeller = {};
  const ours = new Set(records.map((record) => record.requestId));
  for (const [id, entries] of Object.entries(mockRequestsBySeller)) {
    const tagged = entries.filter((entry) => entry.path === '/v1/chat/completions' && ours.has(entry.requestTag));
    perSeller[id] = { mockReceived: tagged.length, mockCompleted: 0, mockFailed: 0, buyerSucceeded: 0 };
    for (const entry of tagged) {
      if (entry.outcome === 'ok') {
        perSeller[id].mockCompleted += 1;
        const list = completedBy.get(entry.requestTag) ?? [];
        list.push(id);
        completedBy.set(entry.requestTag, list);
      } else if (entry.outcome) perSeller[id].mockFailed += 1;
    }
  }
  const unmatched = [];
  let matched = 0;
  for (const record of records) {
    if (!record.ok) continue;
    if (perSeller[record.sellerId]) perSeller[record.sellerId].buyerSucceeded += 1;
    const sellers = completedBy.get(record.requestId) ?? [];
    if (sellers.includes(record.sellerId)) matched += 1;
    else unmatched.push({ requestId: record.requestId, sellerId: record.sellerId, mockCompletedOn: sellers });
  }
  const completedTotal = [...completedBy.values()].reduce((sum, list) => sum + list.length, 0);
  const surplus = completedTotal - matched;
  const buyerFailed = records.filter((record) => !record.ok && record.errorClass !== 'overload').length;
  return result('buyer successes match mock-served requests', unmatched.length === 0 && surplus <= buyerFailed, {
    perSeller,
    matched,
    buyerFailed,
    surplusMockCompletions: surplus,
    unmatchedBuyerSuccesses: unmatched.slice(0, 10),
    note: 'surplus mock completions (retries, abandons, truncation) are allowed up to the number of buyer-side failures',
  });
}

/**
 * Every buyer channel (open or closed) is with a sandbox seller or router: the buyer never paid a peer
 * outside the sandbox allowlist.
 */
export function checkChannelPeers(channels, allowedPeerIds) {
  const allowed = new Set(allowedPeerIds);
  const foreign = channels.filter((channel) => !allowed.has(channel.peerId));
  return result('buyer channels are only with sandbox peers', foreign.length === 0, {
    channels: channels.length,
    foreign: foreign.slice(0, 10).map((channel) => ({ channelId: channel.channelId, peerId: channel.peerId })),
  });
}

/**
 * Router fees: the buyer signed one ranking price per ranking the router served (completed_requests
 * billing). Exactly one extra ranking price per router is the tracked cooperative-close defect (the same
 * one checkDeliveredCost tracks for sellers) and is reported as a known issue; any other difference fails.
 */
export function checkRouterFees({ routers, signedBySeller, rankedByRouter }) {
  const perRouter = {};
  let exact = true;
  let onlyCloseOverage = true;
  for (const router of routers) {
    const priceMicros = BigInt(Math.round(Number(router.priceUsd) * 1_000_000));
    const ranked = BigInt(rankedByRouter[router.id] ?? 0);
    const signed = big(signedBySeller[router.id]);
    const expected = ranked * priceMicros;
    perRouter[router.id] = { ranked: String(ranked), priceMicros: String(priceMicros), signed: String(signed), expected: String(expected), diff: String(signed - expected) };
    if (signed !== expected) exact = false;
    if (signed !== expected && !(ranked > 0n && signed === expected + priceMicros)) onlyCloseOverage = false;
  }
  if (exact || !onlyCloseOverage) return result('router fees equal rankings served x ranking price', exact, { perRouter });
  return result('router fees equal rankings served x ranking price', false, { perRouter }, {
    known: true,
    issue: 'cooperative close settles one extra request cost (buyer-core close path)',
  });
}

/** On-chain settlement equals the buyer's final signed cumulative per seller and reserves are back to 0. */
export function checkSettlement({ signedBySeller, settledBySeller, reservedMicroUsdc }) {
  const mismatched = [];
  for (const id of new Set([...Object.keys(signedBySeller), ...Object.keys(settledBySeller)])) {
    if (big(signedBySeller[id]) !== big(settledBySeller[id])) mismatched.push({ id, signed: String(big(signedBySeller[id])), settled: String(big(settledBySeller[id])) });
  }
  return [
    result('on-chain settled equals buyer final signed per seller', mismatched.length === 0, { mismatched }),
    result('reserves are zero after close', big(reservedMicroUsdc) === 0n, { reservedMicroUsdc: String(reservedMicroUsdc) }),
  ];
}

/**
 * Settled vs the cost of delivered work (usage the mock reported at the seller's prices). Tracked as a
 * known issue while cooperative close settles one extra request cost (buyer-core close path).
 */
export function checkDeliveredCost({ settledBySeller, deliveredBySeller }) {
  const perSeller = {};
  let ok = true;
  for (const id of new Set([...Object.keys(settledBySeller), ...Object.keys(deliveredBySeller)])) {
    const settled = big(settledBySeller[id]);
    const delivered = big(deliveredBySeller[id]);
    perSeller[id] = { settled: String(settled), delivered: String(delivered), diff: String(settled - delivered) };
    if (settled !== delivered) ok = false;
  }
  return result('settled amount equals the cost of delivered work', ok, { perSeller }, {
    known: true,
    issue: 'cooperative close settles one extra request cost (buyer-core close path)',
  });
}

/** Micro-USDC cost of usage at a pricing (same rounding as buyer-core computeCostUsdc). */
export function usageCostMicros(usage, pricing) {
  const usd = ((usage.prompt_tokens ?? 0) * (pricing.inputUsdPerMillion ?? 0) + (usage.completion_tokens ?? 0) * (pricing.outputUsdPerMillion ?? 0)) / 1_000_000;
  return BigInt(Math.max(0, Math.round(usd * 1_000_000)));
}

/** Samples a channels source on an interval until stopped; used to check monotonicity during a run. */
export function channelSampler(fetchChannels, { intervalMs = 1000, now = () => Date.now(), maxSamples = 10_000 } = {}) {
  const samples = [];
  const startedAt = now();
  let timer = null;
  let running = null;
  const errors = [];
  const take = async () => {
    try {
      const channels = await fetchChannels();
      if (samples.length < maxSamples) samples.push({ atMs: now() - startedAt, channels });
    } catch (error) {
      errors.push(error.message);
    }
  };
  return {
    samples,
    errors,
    start() {
      const tick = async () => {
        running = take();
        await running;
        if (timer !== false) timer = setTimeout(tick, intervalMs);
      };
      timer = setTimeout(tick, 0);
    },
    async stop() {
      if (timer) clearTimeout(timer);
      timer = false;
      await running;
      await take();
      return samples;
    },
  };
}
