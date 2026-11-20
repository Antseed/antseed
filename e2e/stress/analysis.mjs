// Payment invariants for one stress run: what the seller's and buyer's stores,
// the chain and the mock upstream say about the money, compared. Pure, so the
// rules can be tested without running peers.

/**
 * @param {object} run
 * @param {object[]} run.sellerRowsPre  seller channel rows before the closes
 * @param {object[]} run.sellerRowsPost seller channel rows after them
 * @param {object[]} run.buyerRowsPost  buyer channel rows after them
 * @param {object} run.chain0 balances before the load; run.chain1 after the closes
 * @param {string[]} run.allIds every channel either side knows
 * @param {Record<string, {settled: bigint, deposit: bigint, status: number}>} run.onchain
 * @param {object} run.mockStats the mock upstream's stats (perRequest: what it delivered)
 * @param {object[]} run.results the client's request records
 * @param {object} run.sc the scenario
 */
export function analyzePayments({ sellerRowsPre, sellerRowsPost, buyerRowsPost, chain0, chain1, allIds, onchain, mockStats, results, sc }) {
  const violations = [];
  const notes = [];
  const big = (v) => BigInt(v ?? '0');
  const sumSpent = sellerRowsPost.reduce((a, r) => a + big(r.tokens_delivered), 0n);
  const sumAccepted = sellerRowsPost.reduce((a, r) => a + big(r.auth_max), 0n);
  const sumSigned = buyerRowsPost.reduce((a, r) => a + big(r.auth_max), 0n);
  const sumSettled = Object.values(onchain).reduce((a, c) => a + c.settled, 0n);
  const buyerDecrease = chain0.buyerBalance - chain1.buyerBalance;
  const sellerGain = chain1.sellerUsdc - chain0.sellerUsdc;
  const feeGain = chain1.reserveUsdc - chain0.reserveUsdc;
  const bySessionId = (rows) => new Map(rows.map((row) => [row.session_id, row]));
  const sellerPostById = bySessionId(sellerRowsPost);
  const sellerPreById = bySessionId(sellerRowsPre);
  const buyerPostById = bySessionId(buyerRowsPost);
  const channels = allIds.map((id) => {
    const s = sellerPostById.get(id); const sPre = sellerPreById.get(id);
    const b = buyerPostById.get(id);
    return {
      id, sellerSpent: s?.tokens_delivered ?? null, sellerAcceptedPreClose: sPre?.auth_max ?? null, sellerAccepted: s?.auth_max ?? null,
      buyerSigned: b?.auth_max ?? null, onchainSettled: onchain[id].settled.toString(), onchainDeposit: onchain[id].deposit.toString(),
      onchainStatus: onchain[id].status, sellerStatus: s?.status ?? null, buyerStatus: b?.status ?? null,
      sellerRequests: s?.request_count ?? null,
    };
  });
  for (const ch of channels) {
    const spent = big(ch.sellerSpent); const acc = big(ch.sellerAcceptedPreClose); const settled = big(ch.onchainSettled);
    if (ch.sellerSpent != null && spent > acc) violations.push({ kind: 'served-unpaid(spent>accepted at drain)', channel: ch.id, spent: spent.toString(), accepted: acc.toString(), gap: (spent - acc).toString() });
    if (ch.sellerSpent != null && spent > settled) violations.push({ kind: 'served-unsettled(spent>onchain settled)', channel: ch.id, spent: spent.toString(), settled: settled.toString(), gap: (spent - settled).toString() });
    if (ch.buyerSigned != null && big(ch.buyerSigned) !== settled) violations.push({ kind: 'buyer-signed!=settled', channel: ch.id, signed: ch.buyerSigned, settled: settled.toString() });
    if (ch.sellerAccepted != null && big(ch.sellerAccepted) !== settled) violations.push({ kind: 'seller-accepted!=settled', channel: ch.id, accepted: ch.sellerAccepted, settled: settled.toString() });
    if (ch.onchainStatus === 1) violations.push({ kind: 'channel-still-active-after-close', channel: ch.id });
    if (big(ch.sellerAccepted ?? '0') > spent + 0n && ch.sellerSpent != null) notes.push(`channel ${ch.id.slice(0, 10)} accepted ${ch.sellerAccepted} > spent ${spent} (buyer paid ${big(ch.sellerAccepted) - spent} beyond seller-recorded spend)`);
  }
  if (buyerDecrease !== sumSettled) violations.push({ kind: 'buyer-deposit-decrease!=sum-settled', buyerDecrease: buyerDecrease.toString(), sumSettled: sumSettled.toString() });
  if (sellerGain + feeGain !== buyerDecrease) violations.push({ kind: 'seller+fee!=buyer-decrease', sellerGain: sellerGain.toString(), feeGain: feeGain.toString(), buyerDecrease: buyerDecrease.toString() });
  if (chain1.buyerReserved !== 0n) violations.push({ kind: 'buyer-reserved-left', reserved: chain1.buyerReserved.toString() });
  // Delivered-cost comparison (mock is ground truth for fully delivered responses).
  const expected = mockStats.expectedCostBaseUnits;
  const overpay = sumSettled - expected;
  const money = {
    mockExpectedDelivered: expected.toString(), sellerSpent: sumSpent.toString(), sellerAccepted: sumAccepted.toString(), buyerSigned: sumSigned.toString(),
    onchainSettled: sumSettled.toString(), buyerDecrease: buyerDecrease.toString(), sellerGain: sellerGain.toString(), feeGain: feeGain.toString(),
    settledMinusExpected: overpay.toString(), spentMinusExpected: (sumSpent - expected).toString(),
  };
  // Mock records: all fully-delivered ok responses were billed? Allow rounding.
  const faultFree = sc.fault500Rate === 0 && sc.disconnectRate === 0 && sc.abortRatio === 0 && !sc.restart;
  if (faultFree && sumSpent !== expected) violations.push({ kind: 'seller-spent!=delivered-cost(fault-free)', spent: sumSpent.toString(), expected: expected.toString() });
  // In every scenario, independent of the seller's own books: each response
  // the client received in full was delivered by the upstream and paid for.
  let receivedCost = 0n;
  const undelivered = [];
  for (const r of results) {
    if (r.error || r.clientAborted) continue;
    const delivered = mockStats.perRequest.get(r.tag);
    if (delivered?.status !== 'ok') { undelivered.push(r.tag); continue; }
    receivedCost += BigInt(delivered.cost);
  }
  money.clientReceivedCost = receivedCost.toString();
  if (undelivered.length) violations.push({ kind: 'client-ok-without-upstream-delivery', n: undelivered.length, tags: undelivered.slice(0, 5) });
  if (sumSettled < receivedCost) violations.push({ kind: 'client-received-work-unpaid', received: receivedCost.toString(), settled: sumSettled.toString(), gap: (receivedCost - sumSettled).toString() });
  // And the most it could owe, also from the upstream: the full cost of every
  // response that reached the wire (a stream cut midway delivered at most
  // that), nothing for an error or a request dropped before any byte.
  let deliveredAtMost = 0n;
  for (const delivered of mockStats.perRequest.values()) {
    if (delivered.started) deliveredAtMost += BigInt(delivered.cost);
  }
  money.upstreamDeliveredAtMost = deliveredAtMost.toString();
  if (sumSettled > deliveredAtMost) violations.push({ kind: 'settled-above-upstream-delivery', settled: sumSettled.toString(), deliveredAtMost: deliveredAtMost.toString(), gap: (sumSettled - deliveredAtMost).toString() });
  if (sumSettled > sumSpent) violations.push({ kind: 'buyer-overpaid(settled>seller-spent)', settled: sumSettled.toString(), spent: sumSpent.toString() });

  const asStrings = (snapshot) => Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, v.toString()]));
  return { money, channels, chain0: asStrings(chain0), chain1: asStrings(chain1), violations, notes };
}

/** Settlement against the seller's own per-request "Cost recorded" log lines. */
export function analyzeRecordedCosts({ recordedCost, recordedCount, settled }) {
  const violations = [];
  const money = {
    sellerCostRecordedSum: recordedCost.toString(),
    sellerCostRecordedCount: recordedCount,
    deliveredUnpaid: (recordedCost > settled ? recordedCost - settled : 0n).toString(),
    paidBeyondDelivered: (settled > recordedCost ? settled - recordedCost : 0n).toString(),
  };
  if (settled > recordedCost) violations.push({ kind: 'buyer-paid-more-than-seller-recorded-delivered(double-pay?)', settled: settled.toString(), recorded: recordedCost.toString() });
  if (recordedCost > settled) violations.push({ kind: 'delivered-but-unpaid(cost-recorded>settled)', recorded: recordedCost.toString(), settled: settled.toString(), gap: (recordedCost - settled).toString() });
  return { money, violations };
}

/**
 * Waits for post-response NeedAuth / SpendingAuth round trips to finish, for at most `maxMs` (the fixed wait it
 * replaces), and returns how long it waited. It ends early only once nothing is in flight: no upstream request is
 * open, every channel the seller has (closed ones too) accepted exactly what the buyer signed and at least what it
 * spent, and neither store has changed for `stableMs`. A run with any unpaid or unsigned work waits the full `maxMs`,
 * so the oracle judges it on the same rows as before.
 */
export async function quiesceChannels({ sellerRows, buyerRows, inFlight, maxMs = 10_000, stableMs = 2_000, intervalMs = 250, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const started = now();
  let last = null;
  let since = started;
  while (now() - started < maxMs) {
    const seller = sellerRows();
    const buyer = buyerRows();
    const key = JSON.stringify([seller, buyer]);
    if (key !== last) { last = key; since = now(); }
    const signed = new Map(buyer.map((row) => [row.session_id, BigInt(row.auth_max ?? '0')]));
    const caughtUp = seller.length > 0 && seller.every((row) => {
      const accepted = BigInt(row.auth_max ?? '0');
      return signed.get(row.session_id) === accepted && BigInt(row.tokens_delivered ?? '0') <= accepted;
    });
    if (caughtUp && now() - since >= stableMs && (await inFlight()) === 0) return now() - started;
    await sleep(intervalMs);
  }
  return now() - started;
}

/**
 * Waits for both stores to record the cooperative closes, for at most `maxMs` (the fixed wait it replaces), and
 * returns how long it waited. It ends early only once every row is a channel in `allIds`, settled at exactly its
 * on-chain amount, and neither store has changed for `stableMs`. Any other state waits the full `maxMs`, so the
 * oracle judges it on the same rows as before.
 */
export async function settledRows({ sellerRows, buyerRows, allIds, onchain, maxMs = 1_500, stableMs = 500, intervalMs = 100, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const started = now();
  const ids = new Set(allIds);
  let last = null;
  let since = started;
  while (now() - started < maxMs) {
    const rows = [...sellerRows(), ...buyerRows()];
    const key = JSON.stringify(rows);
    if (key !== last) { last = key; since = now(); }
    const recorded = rows.every((row) => ids.has(row.session_id) && row.status === 'settled'
      && onchain[row.session_id] !== undefined && BigInt(row.auth_max ?? '0') === onchain[row.session_id].settled);
    if (recorded && now() - since >= stableMs) return now() - started;
    await sleep(intervalMs);
  }
  return now() - started;
}
