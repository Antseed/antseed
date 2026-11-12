import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BuyerHistory, buyerLifetimeUsage, usageBeforeGateway } from './buyer-history.js';
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

type Buyer = { server: Server; port: number; hits: string[]; failing: { value: boolean } };

async function fakeBuyer(address: string): Promise<Buyer> {
  const hits: string[] = [];
  const failing = { value: false };
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (failing.value) {
      res.writeHead(503).end();
      return;
    }
    const send = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/_antseed/buyer-identities') return send({ ok: true, identities: [{ name: 'default', address }] });
    if (req.url === '/_antseed/channels?all=1') {
      return send({ ok: true, channels: [{ channelKind: 'paid', cumulativeSigned: '3000000', settledAmount: null, requestCount: 7 }] });
    }
    if (req.url === '/_antseed/buyer-usage') return send({ ok: true, totals: { channels: [{ requestCount: 7 }] } });
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, hits, failing };
}

function savedFile(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'buyer-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'desktop-usage-history.json');
}

const GATEWAY: KeyUsage = { requests: 3, spentUsd: '1' };
const gatewayUsage = async () => GATEWAY;
const HISTORY = { requests: 4, spentUsd: '2' };

test('history is worked out once for the desktop\'s wallet; a failed read on either side is tried again', async (t) => {
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  const history = new BuyerHistory(() => null);

  buyer.failing.value = true;
  assert.equal(await history.read(buyer.port, WALLET, gatewayUsage), null);
  buyer.failing.value = false;
  assert.equal(await history.read(buyer.port, WALLET, async () => null), null, 'gateway totals unreadable');
  assert.equal(await history.read(buyer.port, WALLET, async () => { throw new Error('gateway CLI failed'); }), null);

  assert.deepEqual(await history.read(buyer.port, WALLET.toUpperCase().replace('0X', '0x'), gatewayUsage), HISTORY);
  const reads = buyer.hits.length;
  assert.deepEqual(await history.read(buyer.port, WALLET, async () => ({ requests: 99, spentUsd: '99' })), HISTORY, 'kept, not worked out again');
  assert.equal(buyer.hits.length, reads);
});

test('a later launch shows the saved history straight away, before the buyer answers', async (t) => {
  const file = savedFile(t);
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  assert.deepEqual(await new BuyerHistory(() => file).read(buyer.port, WALLET, gatewayUsage), HISTORY);

  // Next launch: the buyer is still starting.
  buyer.failing.value = true;
  const reads = buyer.hits.length;
  assert.deepEqual(await new BuyerHistory(() => file).read(buyer.port, WALLET, async () => null), HISTORY);
  assert.equal(buyer.hits.length, reads, 'the buyer is not asked');
});

test('saved history for another wallet, or a damaged file, is worked out again', async (t) => {
  const file = savedFile(t);
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  await new BuyerHistory(() => file).read(buyer.port, WALLET, gatewayUsage);

  buyer.failing.value = true;
  assert.equal(await new BuyerHistory(() => file).read(buyer.port, '0x00000000000000000000000000000000000000cc', gatewayUsage), null, 'another wallet');
  for (const damaged of ['not json', JSON.stringify({ wallet: WALLET, usage: { requests: -1, spentUsd: '3' } }), JSON.stringify({ wallet: WALLET, usage: { requests: 4, spentUsd: '3e5' } })]) {
    writeFileSync(file, damaged);
    assert.equal(await new BuyerHistory(() => file).read(buyer.port, WALLET, gatewayUsage), null, damaged);
  }

  buyer.failing.value = false;
  assert.deepEqual(await new BuyerHistory(() => file).read(buyer.port, WALLET, gatewayUsage), HISTORY);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { wallet: WALLET, usage: HISTORY }, 'a fresh result replaces it');
});

test('a buyer paying from another wallet gives no history', async (t) => {
  const file = savedFile(t);
  const buyer = await fakeBuyer('0x00000000000000000000000000000000000000bb');
  t.after(() => buyer.server.close());
  assert.equal(await new BuyerHistory(() => file).read(buyer.port, WALLET, gatewayUsage), null);
  assert.deepEqual(buyer.hits, ['/_antseed/buyer-identities'], 'its channels are never read');
  assert.throws(() => readFileSync(file), 'nothing is saved');
});
