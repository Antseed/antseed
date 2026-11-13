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
  // slowRate: an upstream slower than the buyer waits, so the buyer gives up on work the seller may still finish.
  const faultFree = sc.fault500Rate === 0 && sc.disconnectRate === 0 && sc.abortRatio === 0 && !sc.restart && !sc.slowRate;
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
