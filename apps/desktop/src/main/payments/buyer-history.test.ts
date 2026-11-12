import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BuyerHistory, historicUsage, usdcDecimal } from './buyer-history.js';
import { withUsageOf } from '../gateway/key-info.js';

const CUTOFF = 1_000_000;
const WALLET = '0x00000000000000000000000000000000000000aa';

test('usage counts only channels that ended before the gateway took over', () => {
  const channels = [
    // Used and done before the cutoff: counts.
    { channelKind: 'paid', cumulativeSigned: '2500000', settledAmount: null, requestCount: 10, updatedAt: CUTOFF - 1 },
    // Opened before, still used after: the gateway already counts it, so it is left out.
    { channelKind: 'paid', cumulativeSigned: '9000000', settledAmount: null, requestCount: 40, updatedAt: CUTOFF + 1 },
    // Opened after: the gateway's.
    { channelKind: 'paid', cumulativeSigned: '7000000', settledAmount: null, requestCount: 30, updatedAt: CUTOFF + 50 },
  ];
  const points = [
    { requestCount: 10, updatedAt: CUTOFF - 1 },
    { requestCount: 40, updatedAt: CUTOFF + 1 },
    { requestCount: 30, updatedAt: CUTOFF + 50 },
  ];
  assert.deepEqual(historicUsage(channels, points, CUTOFF), { requests: 10, spentUsd: '2.5' });
});

test('spend is the larger of signed and settled; free requests and one-off requests count', () => {
  const channels = [
    { channelKind: 'paid', cumulativeSigned: '1000000', settledAmount: '1200000', requestCount: 3, updatedAt: 10 },
    { channelKind: 'paid', cumulativeSigned: '500000', settledAmount: '400000', requestCount: 2, updatedAt: 10 },
    { channelKind: 'one_off', cumulativeSigned: '250000', settledAmount: null, requestCount: 1, updatedAt: 10 },
  ];
  // buyer-usage lists the paid and free channels, never the one-off one.
  const points = [
    { requestCount: 3, updatedAt: 10 },
    { requestCount: 2, updatedAt: 10 },
    { requestCount: 6, updatedAt: 10 }, // free
  ];
  assert.deepEqual(historicUsage(channels, points, CUTOFF), { requests: 12, spentUsd: '1.95' });
});

test('malformed entries count as nothing rather than failing', () => {
  const channels = [null, 'x', { cumulativeSigned: 'abc', updatedAt: 10 }, { cumulativeSigned: '-5', updatedAt: 10 }, { cumulativeSigned: '1', updatedAt: 'soon' }];
  assert.deepEqual(historicUsage(channels, [{ requestCount: -3, updatedAt: 10 }, { requestCount: 2 }], CUTOFF), { requests: 0, spentUsd: '0' });
  assert.deepEqual(historicUsage(undefined, undefined, CUTOFF), { requests: 0, spentUsd: '0' });
});

test('USDC base units read as dollars without floats', () => {
  assert.equal(usdcDecimal(0n), '0');
  assert.equal(usdcDecimal(1n), '0.000001');
  assert.equal(usdcDecimal(4_292_340_000n), '4292.34');
  assert.equal(usdcDecimal(123_000_000n), '123');
});

test('Home\'s totals are the gateway\'s plus the history', () => {
  const desktop = { label: 'Desktop', buyerAddress: WALLET, requests: 2417, spentUsd: '58.36', limits: {}, balance: null, createdAt: CUTOFF };
  const history = historicUsage([{ channelKind: 'paid', cumulativeSigned: '4292340000', requestCount: 1, updatedAt: 10 }], [{ requestCount: 187_014, updatedAt: 10 }], CUTOFF);
  assert.deepEqual(withUsageOf(desktop, [history]), { ...desktop, requests: 189_431, spentUsd: '4350.7' });
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
      return send({ ok: true, channels: [{ channelKind: 'paid', cumulativeSigned: '3000000', settledAmount: null, requestCount: 4, updatedAt: 10 }] });
    }
    if (req.url === '/_antseed/buyer-usage') return send({ ok: true, totals: { channels: [{ requestCount: 4, updatedAt: 10 }] } });
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

test('the buyer\'s history is read once for the desktop\'s wallet; a failed read is tried again', async (t) => {
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  const history = new BuyerHistory(() => null);

  buyer.failing.value = true;
  assert.equal(await history.read(buyer.port, WALLET, CUTOFF), null);

  buyer.failing.value = false;
  assert.deepEqual(await history.read(buyer.port, WALLET.toUpperCase().replace('0X', '0x'), CUTOFF), { requests: 4, spentUsd: '3' });
  const reads = buyer.hits.length;
  assert.deepEqual(await history.read(buyer.port, WALLET, CUTOFF), { requests: 4, spentUsd: '3' });
  assert.equal(buyer.hits.length, reads, 'a kept result is not read again');
});

test('a later launch shows the saved history straight away, before the buyer answers', async (t) => {
  const file = savedFile(t);
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  assert.deepEqual(await new BuyerHistory(() => file).read(buyer.port, WALLET, CUTOFF), { requests: 4, spentUsd: '3' });

  // Next launch: the buyer is still starting.
  buyer.failing.value = true;
  const reads = buyer.hits.length;
  assert.deepEqual(await new BuyerHistory(() => file).read(buyer.port, WALLET, CUTOFF), { requests: 4, spentUsd: '3' });
  assert.equal(buyer.hits.length, reads, 'the buyer is not asked');
});

test('saved history for another wallet or cutoff, or a damaged file, is read from the buyer again', async (t) => {
  const file = savedFile(t);
  const buyer = await fakeBuyer(WALLET);
  t.after(() => buyer.server.close());
  await new BuyerHistory(() => file).read(buyer.port, WALLET, CUTOFF);

  buyer.failing.value = true;
  assert.equal(await new BuyerHistory(() => file).read(buyer.port, WALLET, CUTOFF + 1), null, 'a new cutoff');
  assert.equal(await new BuyerHistory(() => file).read(buyer.port, '0x00000000000000000000000000000000000000cc', CUTOFF), null, 'another wallet');

  for (const damaged of ['not json', JSON.stringify({ scope: `${WALLET}|${CUTOFF}`, usage: { requests: -1, spentUsd: '3' } }), JSON.stringify({ scope: `${WALLET}|${CUTOFF}`, usage: { requests: 4, spentUsd: '3e5' } })]) {
    writeFileSync(file, damaged);
    assert.equal(await new BuyerHistory(() => file).read(buyer.port, WALLET, CUTOFF), null, damaged);
  }

  buyer.failing.value = false;
  assert.deepEqual(await new BuyerHistory(() => file).read(buyer.port, WALLET, CUTOFF), { requests: 4, spentUsd: '3' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { scope: `${WALLET}|${CUTOFF}`, usage: { requests: 4, spentUsd: '3' } }, 'a fresh read replaces it');
});

test('a buyer paying from another wallet gives no history', async (t) => {
  const file = savedFile(t);
  const buyer = await fakeBuyer('0x00000000000000000000000000000000000000bb');
  t.after(() => buyer.server.close());
  assert.equal(await new BuyerHistory(() => file).read(buyer.port, WALLET, CUTOFF), null);
  assert.deepEqual(buyer.hits, ['/_antseed/buyer-identities'], 'its channels are never read');
  assert.throws(() => readFileSync(file), 'nothing is saved');
});
