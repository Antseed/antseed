// The seller-blind relay under concurrency: three sellers each offer the `seller-blind` service and four buyer
// wallets (the buyer's own and three buyer identities) use all of them at once. Every wallet runs two relayed chats
// and one ordinary chat at a time against every seller, half of them streamed; then one wallet asks one seller for
// more relayed chats at once than a buyer holds relay credentials for, and every wallet sends unpinned relayed chats
// that the buyer routes itself.
//
// The relay needs a TLS upstream, so this runs with --live only, on a config whose seller offers one `seller-blind`
// chat service priced per token. Each request carries its own tag, which the answer must repeat. It spends nothing
// against the local upstream in `fixtures/seller-blind/` (the README's scenario list has the command).
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Contract, JsonRpcProvider } from 'ethers';
import { AnvilSigner, minedReceipt } from '../../lib/chain.mjs';
import { usageCost } from '../../lib/mock.mjs';

const CONTROL_SECRET = 'testbench-control-secret';
const POLICY = Buffer.from(JSON.stringify({ requireZeroDataAccess: true })).toString('base64url');
const AUTH = { 'x-antseed-gateway-auth': CONTROL_SECRET };
const IDENTITIES = ['team-a', 'team-b', 'team-c'];
const IDENTITY_DEPOSIT_MICROS = 5_000_000n;
/** Requests each worker sends, one after another. */
const ROUNDS = 3;
/** Relayed chats one wallet sends one seller at once in the burst; a buyer holds two relay credentials per seller and service. */
const BURST = 6;
/** Unpinned relayed chats each wallet sends at once: the buyer picks the seller. */
const AUTO = 4;
const BUSY = /every relay credential stayed busy/;

// A local TLS upstream under a test CA needs sidecars that trust it: TESTBENCH_KEYED_RELAY_BIN names such a binary
// (`fixtures/seller-blind/relay-test-ca.mjs`).
const relayBin = process.env.TESTBENCH_KEYED_RELAY_BIN;
const relayEnv = relayBin ? { ANTSEED_KEYED_RELAY_BIN: relayBin } : {};

export const meta = {
  description: 'Seller-blind relay under concurrency: four buyer wallets run relayed and ordinary chats against three sellers at once, every answer belongs to its request, each wallet signs exactly its own usage per seller, and settlement equals what was signed.',
  targets: ['local', 'fork'],
  requires: ['liveUpstream'],
  covers: [
    'seller-blind relay with several buyers and sellers at once (packages/keyed-relay, packages/node/src/seller-blind-relay.ts, apps/cli/src/proxy/blind-relay.ts)',
    'relay credentials per buyer: two streams at a time per seller and service, the rest wait',
    'billing from the revealed usage, per buyer wallet',
  ],
};

export const topology = {
  mode: 'cli',
  sellers: ['north', 'south', 'east'].map((id) => ({ id, ...(relayBin ? { env: relayEnv } : {}) })),
  buyer: { env: { ANTSEED_GATEWAY_CONTROL_SECRET: CONTROL_SECRET, ...relayEnv } },
};

function blindService(tb, sellerId) {
  const { providers } = tb.manifest.topology.sellers.find((entry) => entry.id === sellerId);
  for (const provider of Object.values(providers)) {
    for (const [id, service] of Object.entries(provider.services ?? {})) {
      if (service.categories?.includes('seller-blind')) return { id, pricing: service.pricing ?? provider.defaults };
    }
  }
  return null;
}

function streamed(text) {
  let content = '';
  let usage = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const event = JSON.parse(line.slice(6));
    content += event.choices?.[0]?.delta?.content ?? '';
    if (event.usage) usage = event.usage;
  }
  return { content, usage };
}

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** Deposits USDC for a buyer identity from another wallet, the way an operator funds it. */
async function deposit(tb, buyer, micros) {
  const funder = '0x00000000000000000000000000000000000F00D5';
  const provider = new JsonRpcProvider(tb.rpcUrl);
  try {
    await tb.mintUsdc(funder, micros);
    await provider.send('anvil_setBalance', [funder, '0x56BC75E2D63100000']);
    await provider.send('anvil_impersonateAccount', [funder]);
    const signer = new AnvilSigner(provider, funder);
    const usdc = new Contract(tb.contracts.usdc, ['function approve(address,uint256) returns(bool)'], signer);
    const deposits = new Contract(tb.contracts.deposits, ['function deposit(address,uint256)'], signer);
    await minedReceipt(await usdc.approve(tb.contracts.deposits, micros), provider);
    await minedReceipt(await deposits.deposit(buyer, micros), provider);
    await provider.send('anvil_stopImpersonatingAccount', [funder]);
  } finally {
    provider.destroy();
  }
}

export async function run(tb) {
  const service = blindService(tb, tb.sellers[0].id);
  tb.check('the sellers offer a seller-blind service', service !== null, tb.manifest.topology.sellers[0].providers);
  if (!service) return;
  // Rounded for each response, like the seller's metering, so a fractional price per million tokens adds up the same.
  const cost = (usage) => usageCost(service.pricing, { prompt: usage?.prompt_tokens ?? 0, completion: usage?.completion_tokens ?? 0 });

  // Seller logs outlive a run, so count this run's lines only.
  const sellerLog = (seller) => join(tb.manifest.dir, 'logs', `seller-${seller.id}.log`);
  const logStart = {};
  for (const seller of tb.sellers) logStart[seller.id] = (await stat(sellerLog(seller)).catch(() => null))?.size ?? 0;

  const buyers = [{ name: 'default', identity: null, address: tb.manifest.buyer.address, deposit: BigInt(tb.manifest.depositMicros) }];
  for (const name of IDENTITIES) {
    const created = await tb.cli(['buyer', 'identity', 'create', name]);
    const address = /Wallet: (0x[0-9a-fA-F]{40})/.exec(created.stdout)?.[1];
    tb.check(`buyer identity ${name} is created`, created.code === 0 && Boolean(address), created.stderr || created.stdout);
    await deposit(tb, address, IDENTITY_DEPOSIT_MICROS);
    buyers.push({ name, identity: name, address, deposit: IDENTITY_DEPOSIT_MICROS });
  }

  const results = [];
  let sequence = 0;
  const ask = async ({ buyer, seller, relayed, stream, phase }) => {
    sequence += 1;
    const tag = `tag-${buyer.name}-${seller?.id ?? 'auto'}-${relayed ? 'r' : 'o'}${sequence}`;
    const started = Date.now();
    let reply;
    try {
      reply = await tb.request('/v1/chat/completions', {
        stream,
        timeoutMs: 180_000,
        headers: { ...AUTH, ...(relayed ? { 'x-antseed-routing-policy': POLICY } : {}), ...(buyer.identity ? { 'x-antseed-buyer-identity': buyer.identity } : {}) },
        body: {
          model: seller ? `${seller.peerId}@${service.id}` : service.id,
          messages: [{ role: 'user', content: `Repeat this tag exactly and nothing else: [[${tag}]]` }],
          max_tokens: 64 + ((sequence * 37) % 192),
          stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
        },
      });
    } catch (error) {
      reply = { status: 0, text: String(error?.message ?? error), json: null, latencyMs: Date.now() - started };
    }
    const ok = reply.status === 200;
    const read = !ok ? { content: '', usage: null } : stream ? streamed(reply.text) : { content: reply.json?.choices?.[0]?.message?.content ?? '', usage: reply.json?.usage ?? null };
    // An unpinned request learns its seller from the answer.
    const servedBy = seller ?? tb.sellers.find((entry) => entry.peerId === reply.headers?.['x-antseed-peer-id']);
    const result = { phase, buyer: buyer.name, seller: servedBy?.id ?? null, relayed, stream, tag, status: reply.status, latencyMs: reply.latencyMs, usage: read.usage, own: read.content.includes(tag), error: ok ? null : reply.text.slice(0, 300) };
    results.push(result);
    return result;
  };

  // Steady load: every wallet, against every seller, two relayed workers (a buyer's two relay credentials) and one ordinary.
  const steadyStarted = Date.now();
  const workers = [];
  for (const buyer of buyers) {
    for (const seller of tb.sellers) {
      for (const [index, relayed] of [true, true, false].entries()) {
        workers.push((async () => {
          for (let round = 0; round < ROUNDS; round += 1) await ask({ buyer, seller, relayed, stream: (round + index) % 2 === 0, phase: 'steady' });
        })());
      }
    }
  }
  await Promise.all(workers);
  const steadyMs = Date.now() - steadyStarted;

  // Burst: more relayed chats at once than the buyer holds credentials for. The extra ones wait for a free credential.
  const burstStarted = Date.now();
  await Promise.all(Array.from({ length: BURST }, (_, index) => ask({ buyer: buyers[0], seller: tb.sellers[0], relayed: true, stream: index % 2 === 0, phase: 'burst' })));
  const burstMs = Date.now() - burstStarted;

  // Unpinned: every wallet sends relayed chats without naming a seller.
  const autoStarted = Date.now();
  await Promise.all(buyers.flatMap((buyer) => Array.from({ length: AUTO }, (_, index) => ask({ buyer, seller: null, relayed: true, stream: index % 2 === 0, phase: 'auto' }))));
  const autoMs = Date.now() - autoStarted;

  const steady = results.filter((result) => result.phase === 'steady');
  const auto = results.filter((result) => result.phase === 'auto');
  const burst = results.filter((result) => result.phase === 'burst');
  const answered = results.filter((result) => result.status === 200);
  const latencies = (list) => list.filter((result) => result.status === 200).map((result) => result.latencyMs);
  const summary = (list) => ({ requests: list.length, answered: list.filter((result) => result.status === 200).length, p50Ms: percentile(latencies(list), 50), p95Ms: percentile(latencies(list), 95), maxMs: percentile(latencies(list), 100) });
  tb.metric('steady', { wallMs: steadyMs, workers: workers.length, relayed: summary(steady.filter((result) => result.relayed)), ordinary: summary(steady.filter((result) => !result.relayed)) });
  tb.metric('burst', { wallMs: burstMs, ...summary(burst), statuses: burst.map((result) => result.status), latenciesMs: burst.map((result) => result.latencyMs) });
  tb.metric('auto', { wallMs: autoMs, ...summary(auto), statuses: auto.map((result) => result.status), bySeller: Object.fromEntries(tb.sellers.map((seller) => [seller.id, auto.filter((result) => result.status === 200 && result.seller === seller.id).length])) });
  tb.metric('failures', results.filter((result) => result.status !== 200).map(({ phase, buyer, seller, relayed, stream, status, latencyMs, error }) => ({ phase, buyer, seller, relayed, stream, status, latencyMs, error })));

  // What each wallet owes each seller, from the usage its own answers reported.
  const expected = {};
  const counts = {};
  for (const result of answered) {
    const key = `${result.buyer}>${result.seller}`;
    expected[key] = (expected[key] ?? 0n) + cost(result.usage);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const channelsOf = async (buyer) => {
    const reply = await tb.request(`/_antseed/channels?all=1${buyer.identity ? `&identity=${buyer.identity}` : ''}`, { headers: AUTH });
    return reply.json?.channels ?? [];
  };
  const ledger = async () => {
    const signed = {};
    const receipts = {};
    const channels = {};
    for (const buyer of buyers) {
      for (const channel of await channelsOf(buyer)) {
        const seller = tb.sellers.find((entry) => entry.peerId === channel.peerId);
        const key = `${buyer.name}>${seller?.id ?? channel.peerId}`;
        signed[key] = (signed[key] ?? 0n) + BigInt(channel.cumulativeSigned ?? '0');
        receipts[key] = (receipts[key] ?? 0) + (channel.requestCount ?? 0);
        (channels[key] ??= []).push(channel);
      }
    }
    return { signed, receipts, channels };
  };
  // The proxy answers before the buyer has stored that request's payment, so read until the books catch up.
  let books = await ledger();
  const settled = () => Object.keys(expected).every((key) => (books.signed[key] ?? 0n) >= expected[key]);
  for (const deadline = Date.now() + 30_000; !settled() && Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    books = await ledger();
  }
  const text = (map) => Object.fromEntries(Object.entries(map).map(([key, value]) => [key, String(value)]));
  tb.metric('signedMicroUsdc', text(books.signed));
  tb.metric('expectedMicroUsdc', text(expected));

  // The sellers' own count of relayed streams they charged for.
  const charged = {};
  for (const seller of tb.sellers) {
    const log = (await readFile(sellerLog(seller)).catch(() => Buffer.alloc(0))).subarray(logStart[seller.id]).toString('utf8');
    charged[seller.id] = (log.match(/\[BlindRelay\] \w+ in=\d+ out=\d+; charging \d+/g) ?? []).length;
  }
  const relayedAnswered = Object.fromEntries(tb.sellers.map((seller) => [seller.id, answered.filter((result) => result.relayed && result.seller === seller.id).length]));
  tb.metric('relayedChargedBySeller', charged);

  const failedSteady = steady.filter((result) => result.status !== 200);
  tb.check(`every steady request is answered (${steady.length}: ${steady.filter((result) => result.relayed).length} relayed, ${steady.filter((result) => !result.relayed).length} ordinary)`, failedSteady.length === 0, failedSteady.slice(0, 5));
  const refusedBusy = (result) => result.status >= 500 && BUSY.test(result.error ?? '');
  const unexpected = burst.filter((result) => result.status !== 200 && !refusedBusy(result));
  tb.check(`a burst of ${BURST} relayed chats from one wallet is answered, or refused only because every credential stayed busy`, unexpected.length === 0 && burst.filter((result) => result.status === 200).length >= 2, burst.map(({ status, latencyMs, error }) => ({ status, latencyMs, error })));
  const lost = auto.filter((result) => (result.status === 200 ? result.seller === null : !refusedBusy(result)));
  tb.check(`unpinned relayed chats from every wallet (${auto.length}) are answered by one of the sellers, or refused only because every credential stayed busy`, lost.length === 0 && auto.some((result) => result.status === 200), lost.slice(0, 5));
  const strangers = answered.filter((result) => !result.own);
  tb.check('every answer carries the tag of its own request', strangers.length === 0, strangers.slice(0, 5));
  const unmetered = answered.filter((result) => !(result.usage?.prompt_tokens > 0 && result.usage?.completion_tokens > 0));
  tb.check('every answer reports the upstream\'s usage', unmetered.length === 0, unmetered.slice(0, 5));
  tb.check('each seller charged one relayed stream per relayed answer, from revealed usage', tb.sellers.every((seller) => charged[seller.id] === relayedAnswered[seller.id]), { charged, relayedAnswered });
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(books.signed)])].sort();
  const off = keys.filter((key) => (books.signed[key] ?? 0n) !== (expected[key] ?? 0n));
  tb.check(`each wallet signed exactly its own usage at each seller's price (${keys.length} wallet and seller pairs)`, off.length === 0 && keys.length === buyers.length * tb.sellers.length, off.map((key) => ({ pair: key, signed: String(books.signed[key] ?? 0n), expected: String(expected[key] ?? 0n) })));
  const miscounted = keys.filter((key) => (books.receipts[key] ?? 0) !== (counts[key] ?? 0));
  tb.check('receipts cover every answered request, per wallet and seller', miscounted.length === 0, miscounted.map((key) => ({ pair: key, receipts: books.receipts[key] ?? 0, answered: counts[key] ?? 0 })));

  // Close everything: the buyer's own channels through the testbench, each identity's through the buyer's close route.
  await tb.closeAll();
  for (const buyer of buyers.filter((entry) => entry.identity)) {
    for (const seller of tb.sellers) {
      await tb.waitFor(async () => {
        const reply = await tb.request('/_antseed/channels/close', { headers: AUTH, body: { peerId: seller.peerId, identity: buyer.identity } });
        return reply.status === 200 && reply.json?.ok !== false;
      }, `${buyer.name}'s channel with ${seller.id} to close`, { timeoutMs: 120_000, intervalMs: 2000 });
    }
  }
  // Settlement across every wallet. `tb.assertSettlementMatchesSigned` reads one buyer, so this reads the chain itself.
  const onchain = [];
  for (const [key, channels] of Object.entries(books.channels)) {
    for (const channel of channels) {
      const state = await tb.waitFor(async () => {
        const row = await tb.channelState(channel.channelId);
        return row.status !== 1 ? row : null;
      }, `channel ${key} to settle on-chain`, { timeoutMs: 120_000, intervalMs: 1000 });
      onchain.push({ pair: key, signed: String(channel.cumulativeSigned ?? '0'), settled: String(state.settled), status: state.status });
    }
  }
  tb.check(`every channel settles on-chain for exactly what its wallet signed (${onchain.length} channels)`, onchain.length >= keys.length && onchain.every((row) => row.settled === row.signed), onchain);

  const provider = new JsonRpcProvider(tb.rpcUrl);
  try {
    const depositsRead = new Contract(tb.contracts.deposits, ['function getBuyerBalance(address) view returns(uint256 available,uint256 reserved,uint256 lastActivityAt)'], provider);
    const channelsRead = new Contract(tb.contracts.channels, ['event ChannelSettled(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 cumulativeAmount,uint128 delta,uint128 totalSettled,uint256 platformFee,bytes metadata)'], provider);
    const wallets = [];
    for (const buyer of buyers) {
      const balance = await depositsRead.getBuyerBalance(buyer.address);
      const spent = tb.sellers.reduce((total, seller) => total + (expected[`${buyer.name}>${seller.id}`] ?? 0n), 0n);
      wallets.push({ wallet: buyer.name, available: String(balance.available), reserved: String(balance.reserved), expectedAvailable: String(buyer.deposit - spent) });
    }
    tb.check('each wallet\'s deposit drops by exactly the cost of its own answered requests, with nothing left reserved', wallets.every((row) => row.reserved === '0' && row.available === row.expectedAvailable), wallets);
    const sellers = [];
    for (const seller of tb.sellers) {
      const events = await channelsRead.queryFilter(channelsRead.filters.ChannelSettled(null, null, seller.address), tb.manifest.chainStartBlock);
      const paid = events.reduce((total, event) => total + event.args.delta, 0n);
      const fees = events.reduce((total, event) => total + event.args.platformFee, 0n);
      const gain = (await tb.usdcBalance(seller.address)) - BigInt(tb.manifest.sellerUsdcBefore[seller.id]);
      const owed = buyers.reduce((total, buyer) => total + (expected[`${buyer.name}>${seller.id}`] ?? 0n), 0n);
      sellers.push({ seller: seller.id, paid: String(paid), owed: String(owed), fees: String(fees), gain: String(gain), buyers: new Set(events.map((event) => event.args.buyer)).size });
    }
    tb.metric('settlement', { wallets, sellers });
    tb.check('each seller is paid exactly what all wallets owe it, less fees', sellers.every((row) => row.paid === row.owed && BigInt(row.gain) === BigInt(row.paid) - BigInt(row.fees) && row.buyers === buyers.length), sellers);
  } finally {
    provider.destroy();
  }
  await tb.assertNoCrashes();
}
