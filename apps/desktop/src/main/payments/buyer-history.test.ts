import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BuyerHistory, buyerLifetimeUsage, nextHistoryState, switchedHistoryState, usageBeforeGateway } from './buyer-history.js';
import { parseWalletKeyUsage, withUsageOf, type KeyUsage } from '../gateway/key-info.js';

const WALLET = '0x00000000000000000000000000000000000000aa';
const SWITCH = 1_000_000;

test('lifetime usage takes the larger of signed and settled, and counts free and one-off requests', () => {
  const channels = [
    { channelKind: 'paid', cumulativeSigned: '1000000', settledAmount: '1200000', requestCount: 3 },
    { channelKind: 'paid', cumulativeSigned: '500000', settledAmount: '400000', requestCount: 2 },
    { channelKind: 'one_off', cumulativeSigned: '250000', settledAmount: null, requestCount: 1 },
  ];
  // buyer-usage lists the paid and free channels, never the one-off one.
  const points = [{ requestCount: 3 }, { requestCount: 2 }, { requestCount: 6 }];
  assert.deepEqual(buyerLifetimeUsage(channels, points), { requests: 12, spentUsd: '1.95' });
});

test('a channel used before the gateway counts even when it settles or is reconciled after', () => {
  // Every request happened before the switch; the seller settled long after, so the channel was last updated then.
  const settledLater = { channelKind: 'paid', cumulativeSigned: '2500000', settledAmount: '2500000', requestCount: 10, updatedAt: SWITCH + 5_000 };
  const buyer = buyerLifetimeUsage([settledLater], [{ requestCount: 10, updatedAt: SWITCH + 5_000 }]);
  const gateway = { requests: 0, spentUsd: '0' };
  assert.deepEqual(usageBeforeGateway(buyer, gateway), { requests: 10, spentUsd: '2.5' });
});

test('a channel used on both sides of the switch counts each request once', () => {
  // 6 requests ($0.60) before the gateway, then 4 ($0.40) through it, on one channel.
  const buyer = buyerLifetimeUsage([{ channelKind: 'paid', cumulativeSigned: '1000000', requestCount: 10 }], [{ requestCount: 10 }]);
  const gateway = { requests: 4, spentUsd: '0.4' };
  const history = usageBeforeGateway(buyer, gateway);
  assert.deepEqual(history, { requests: 6, spentUsd: '0.6' });
  const desktop = { label: 'Desktop', buyerAddress: WALLET, requests: 4, spentUsd: '0.4', limits: {}, balance: null };
  assert.deepEqual(withUsageOf(desktop, [history]), { ...desktop, requests: 10, spentUsd: '1' });
});

test('a gateway that counted more than the buyer adds no history rather than taking some away', () => {
  assert.deepEqual(usageBeforeGateway({ requests: 3, spentUsd: '0.1' }, { requests: 5, spentUsd: '0.2' }), { requests: 0, spentUsd: '0' });
});

test('malformed entries count as nothing rather than failing', () => {
  const channels = [null, 'x', { cumulativeSigned: 'abc' }, { cumulativeSigned: '-5' }, { channelKind: 'one_off', requestCount: -2 }];
  assert.deepEqual(buyerLifetimeUsage(channels, [{ requestCount: -3 }, { requestCount: 'many' }]), { requests: 0, spentUsd: '0' });
  assert.deepEqual(buyerLifetimeUsage(undefined, undefined), { requests: 0, spentUsd: '0' });
});

test('replacing the earliest key leaves the totals unchanged', () => {
  const buyer = buyerLifetimeUsage([{ channelKind: 'paid', cumulativeSigned: '5000000', requestCount: 50 }], [{ requestCount: 50 }]);
  const desktopKey = { identity: 'default', requests: 12, failedRequests: 2, spentUsd: { total: '1.000000' } };

  // Before: one desktop key.
  const before = withUsageOf(
    { label: 'Desktop', buyerAddress: WALLET, requests: 12, spentUsd: '1', limits: {}, balance: null },
    [usageBeforeGateway(buyer, parseWalletKeyUsage([desktopKey], 'default')!)],
  );

  // After Replace keys: the old key is revoked (its usage comes back as retired usage) and a new one starts empty.
  const keys = [{ ...desktopKey }, { identity: 'default', requests: 0, failedRequests: 0, spentUsd: { total: '0.000000' } }];
  const retired: KeyUsage = { requests: 12, spentUsd: '1' };
  const after = withUsageOf(
    { label: 'Desktop', buyerAddress: WALLET, requests: 0, spentUsd: '0', limits: {}, balance: null },
    [retired, usageBeforeGateway(buyer, parseWalletKeyUsage(keys, 'default')!)],
  );
  assert.equal(after.requests, before.requests);
  assert.equal(after.spentUsd, before.spentUsd);
});

type Buyer = { server: Server; port: number; hits: string[]; failing: { value: boolean }; signedMicros: { value: number }; requestCount: { value: number } };

async function fakeBuyer(address: string): Promise<Buyer> {
  const hits: string[] = [];
  const failing = { value: false };
  const signedMicros = { value: 3_000_000 };
  const requestCount = { value: 7 };
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (failing.value) {
      res.writeHead(503).end();
      return;
    }
    const send = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/_antseed/buyer-identities') return send({ ok: true, identities: [{ name: 'default', address }] });
    if (req.url === '/_antseed/channels?all=1') {
      return send({ ok: true, channels: [{ channelKind: 'paid', cumulativeSigned: String(signedMicros.value), settledAmount: null, requestCount: requestCount.value }] });
    }
    if (req.url === '/_antseed/buyer-usage') return send({ ok: true, totals: { channels: [{ requestCount: requestCount.value }] } });
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, hits, failing, signedMicros, requestCount };
}

function savedFile(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'buyer-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'desktop-usage-history.json');
}

const GATEWAY: KeyUsage = { requests: 3, spentUsd: '1' };
const gatewayUsage = async () => GATEWAY;
const HISTORY = { requests: 4, spentUsd: '2' };

/** One read, the background refresh it starts, and the result after it. */
async function readAndSettle(history: BuyerHistory, port: number, wallet: string, usage: () => Promise<KeyUsage | null>): Promise<KeyUsage | null> {
  history.read(port, wallet, usage);
  await history.settled();
  const result = history.read(port, wallet, usage);
  await history.settled();
  return result;
}

test('history never makes Home wait: it is worked out in the background', async (t) => {
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  const history = new BuyerHistory(() => null, 60_000);
  assert.equal(history.read(buyer.port, WALLET, gatewayUsage), null, 'nothing yet');
  await history.settled();
  assert.deepEqual(history.read(buyer.port, WALLET.toUpperCase().replace('0X', '0x'), gatewayUsage), HISTORY);
  const reads = buyer.hits.length;
  assert.deepEqual(history.read(buyer.port, WALLET, gatewayUsage), HISTORY);
  await history.settled();
  assert.equal(buyer.hits.length, reads, 'not worked out again before the refresh interval');
});

test('a charge the gateway takes in late is corrected at the next refresh', async (t) => {
  const file = savedFile(t);
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  const history = new BuyerHistory(() => file, 0);

  // The buyer signed a $0.50 charge ($3 in all) that the gateway hasn't taken in yet ($0.50 before it).
  assert.deepEqual(await readAndSettle(history, buyer.port, WALLET, async () => ({ requests: 3, spentUsd: '0.5' })), { requests: 4, spentUsd: '2.5' });
  // Once it has, the charge is the gateway's, not history; the saved figure follows.
  assert.deepEqual(await readAndSettle(history, buyer.port, WALLET, async () => ({ requests: 3, spentUsd: '1' })), HISTORY);
  buyer.failing.value = true;
  assert.deepEqual(new BuyerHistory(() => file, 60_000).read(buyer.port, WALLET, async () => null), HISTORY, 'saved');
});

test('a request still in flight is corrected once the buyer counts it', async (t) => {
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  const history = new BuyerHistory(() => null, 0);
  // 7 requests before the gateway; one gateway request has started but the buyer hasn't counted it yet.
  const gateway = async () => ({ requests: 1, spentUsd: '0' });
  assert.deepEqual(await readAndSettle(history, buyer.port, WALLET, gateway), { requests: 6, spentUsd: '3' });
  // It completes: the buyer counts it, and the history is 7 again (Home: 1 + 7).
  buyer.requestCount.value = 8;
  assert.deepEqual(await readAndSettle(history, buyer.port, WALLET, gateway), { requests: 7, spentUsd: '3' });
});

test('a refresh that can\'t read both sides keeps the last result', async (t) => {
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  const history = new BuyerHistory(() => null, 0);
  buyer.failing.value = true;
  assert.equal(await readAndSettle(history, buyer.port, WALLET, gatewayUsage), null, 'none before a first result');
  buyer.failing.value = false;
  assert.equal(await readAndSettle(history, buyer.port, WALLET, async () => null), null, 'gateway totals unreadable');
  assert.equal(await readAndSettle(history, buyer.port, WALLET, async () => { throw new Error('gateway CLI failed'); }), null);
  assert.deepEqual(await readAndSettle(history, buyer.port, WALLET, gatewayUsage), HISTORY);

  buyer.failing.value = true;
  assert.deepEqual(await readAndSettle(history, buyer.port, WALLET, gatewayUsage), HISTORY);
  buyer.failing.value = false;
  assert.deepEqual(await readAndSettle(history, buyer.port, WALLET, async () => null), HISTORY);
});

test('a later launch shows the saved history straight away, before the buyer answers', async (t) => {
  const file = savedFile(t);
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  assert.deepEqual(await readAndSettle(new BuyerHistory(() => file, 0), buyer.port, WALLET, gatewayUsage), HISTORY);

  // Next launch: the buyer is still starting.
  buyer.failing.value = true;
  const next = new BuyerHistory(() => file, 0);
  assert.deepEqual(next.read(buyer.port, WALLET, async () => null), HISTORY);
  await next.settled();
});

test('saved history for another wallet, or a damaged file, is not shown', async (t) => {
  const file = savedFile(t);
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  await readAndSettle(new BuyerHistory(() => file, 0), buyer.port, WALLET, gatewayUsage);

  buyer.failing.value = true;
  const other = new BuyerHistory(() => file, 0);
  assert.equal(other.read(buyer.port, '0x00000000000000000000000000000000000000cc', gatewayUsage), null, 'another wallet');
  await other.settled();
  const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  for (const damaged of ['not json', JSON.stringify({ wallet: WALLET, usage: HISTORY }), JSON.stringify({ ...state, lastGateway: { requests: -1, spentUsd: '3' } }), JSON.stringify({ ...state, wallets: { [WALLET]: { gateway: GATEWAY, history: { requests: 4, spentUsd: '3e5' } } } })]) {
    writeFileSync(file, damaged);
    const fresh = new BuyerHistory(() => file, 0);
    assert.equal(fresh.read(buyer.port, WALLET, gatewayUsage), null, damaged);
    await fresh.settled();
  }

  buyer.failing.value = false;
  assert.deepEqual(await readAndSettle(new BuyerHistory(() => file, 0), buyer.port, WALLET, gatewayUsage), HISTORY);
  buyer.failing.value = true;
  assert.deepEqual(new BuyerHistory(() => file, 60_000).read(buyer.port, WALLET, async () => null), HISTORY, 'a fresh result replaces it');
});

test('a buyer paying from another wallet gives no history', async (t) => {
  const file = savedFile(t);
  const buyer = await fakeBuyer('0x00000000000000000000000000000000000000bb');
  t.after(() => buyer.server.close());
  assert.equal(await readAndSettle(new BuyerHistory(() => file, 60_000), buyer.port, WALLET, gatewayUsage), null);
  assert.deepEqual(buyer.hits, ['/_antseed/buyer-identities'], 'its channels are never read');
  assert.throws(() => readFileSync(file), 'nothing is saved');
});

const OLD = '0x00000000000000000000000000000000000000a1';
const NEW = '0x00000000000000000000000000000000000000b2';

test('after importing another signer, the old wallet\'s gateway usage is not taken from the new wallet\'s history', () => {
  // The old wallet: 100 requests ($10) through the gateway, nothing before it.
  let state = nextHistoryState(null, OLD, { requests: 100, spentUsd: '10' }, { requests: 100, spentUsd: '10' });
  assert.deepEqual(state.wallets[OLD]?.history, { requests: 0, spentUsd: '0' });

  // The imported wallet brings 20 requests ($2) from before the gateway; the gateway's keys and totals stay.
  state = nextHistoryState(state, NEW, { requests: 20, spentUsd: '2' }, { requests: 100, spentUsd: '10' });
  assert.deepEqual(state.wallets[NEW]?.history, { requests: 20, spentUsd: '2' });

  // It then sends 5 requests ($0.50) through the gateway: they are its own, not history.
  state = nextHistoryState(state, NEW, { requests: 25, spentUsd: '2.5' }, { requests: 105, spentUsd: '10.5' });
  assert.deepEqual(state.wallets[NEW], { gateway: { requests: 5, spentUsd: '0.5' }, history: { requests: 20, spentUsd: '2' } });

  // Switching back: the old wallet's share is still its 100.
  state = nextHistoryState(state, OLD, { requests: 100, spentUsd: '10' }, { requests: 105, spentUsd: '10.5' });
  assert.deepEqual(state.wallets[OLD], { gateway: { requests: 100, spentUsd: '10' }, history: { requests: 0, spentUsd: '0' } });
});

test('requests sent before a signer import are the old wallet\'s, even when counted at the next refresh', () => {
  let state = nextHistoryState(null, OLD, { requests: 10, spentUsd: '1' }, { requests: 10, spentUsd: '1' });
  // 3 more gateway requests on the old wallet, then the import, then the next refresh.
  state = nextHistoryState(state, NEW, { requests: 0, spentUsd: '0' }, { requests: 13, spentUsd: '1.3' });
  assert.deepEqual(state.wallets[OLD]?.gateway, { requests: 13, spentUsd: '1.3' });
  assert.deepEqual(state.wallets[NEW]?.gateway, { requests: 0, spentUsd: '0' });
});

test('a gateway whose data was reset: what it lost shows as history, from the buyer', () => {
  let state = nextHistoryState(null, OLD, { requests: 50, spentUsd: '5' }, { requests: 30, spentUsd: '3' });
  assert.deepEqual(state.wallets[OLD]?.history, { requests: 20, spentUsd: '2' });
  // Reset: the gateway starts again from 2 requests; the buyer still has them all (Home: 2 + 50).
  state = nextHistoryState(state, OLD, { requests: 52, spentUsd: '5.2' }, { requests: 2, spentUsd: '0.2' });
  assert.deepEqual(state.wallets[OLD], { gateway: { requests: 2, spentUsd: '0.2' }, history: { requests: 50, spentUsd: '5' } });
  state = nextHistoryState(state, OLD, { requests: 55, spentUsd: '5.5' }, { requests: 5, spentUsd: '0.5' });
  assert.deepEqual(state.wallets[OLD], { gateway: { requests: 5, spentUsd: '0.5' }, history: { requests: 50, spentUsd: '5' } });
});

test('requests the new signer sends before the next refresh are its own, with the import checkpointed', () => {
  // The old wallet: 10 gateway requests ($1).
  let state = nextHistoryState(null, OLD, { requests: 10, spentUsd: '1' }, { requests: 10, spentUsd: '1' });
  // Import: the gateway is stopped, its totals read as the checkpoint.
  state = switchedHistoryState(state, NEW, { requests: 10, spentUsd: '1' });
  // An app sends 5 requests ($0.50) with the new signer before Home refreshes.
  state = nextHistoryState(state, NEW, { requests: 5, spentUsd: '0.5' }, { requests: 15, spentUsd: '1.5' });
  assert.deepEqual(state.wallets[NEW], { gateway: { requests: 5, spentUsd: '0.5' }, history: { requests: 0, spentUsd: '0' } });
  assert.deepEqual(state.wallets[OLD]?.gateway, { requests: 10, spentUsd: '1' });
});

test('a checkpoint before any refresh still starts the new wallet\'s share at the import', () => {
  let state = switchedHistoryState(null, NEW, { requests: 40, spentUsd: '4' });
  state = nextHistoryState(state, NEW, { requests: 23, spentUsd: '2.3' }, { requests: 43, spentUsd: '4.3' });
  assert.deepEqual(state.wallets[NEW], { gateway: { requests: 3, spentUsd: '0.3' }, history: { requests: 20, spentUsd: '2' } });
});

test('switching wallets waits for a refresh in progress and is saved', async (t) => {
  const file = savedFile(t);
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  const history = new BuyerHistory(() => file, 0);
  history.read(buyer.port, WALLET, gatewayUsage);
  // The refresh is still running when the signer changes.
  await history.switchWallet(NEW, async () => ({ requests: 5, spentUsd: '1.5' }));
  const state = JSON.parse(readFileSync(file, 'utf8')) as { active: string; lastGateway: KeyUsage; wallets: Record<string, { gateway: KeyUsage }> };
  assert.equal(state.active, NEW);
  assert.deepEqual(state.lastGateway, { requests: 5, spentUsd: '1.5' });
  // The refresh finished first (3 requests, $1 for the old wallet), then the 2 counted since went to it too.
  assert.deepEqual(state.wallets[WALLET.toLowerCase()]?.gateway, { requests: 5, spentUsd: '1.5' });
});
