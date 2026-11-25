// The seller-blind relay end to end: a service in category `seller-blind` is asked for with zero data access, so the
// buyer runs TLS to the upstream through the seller, the seller adds its key without reading the session, and bills
// the usage the buyer reveals. The relay needs a real TLS upstream, so this runs with --live only, on a config whose
// seller offers one `seller-blind` chat service priced per token.
//
// The buyer asks for zero data access the way the gateway does: a routing policy authenticated with the control
// secret, which the topology gives the buyer through its environment.
import { usageCost } from '../../lib/mock.mjs';

const CONTROL_SECRET = 'testbench-control-secret';
const POLICY = Buffer.from(JSON.stringify({ requireZeroDataAccess: true })).toString('base64url');
const CODEWORD = 'giraffe';
// The local mock upstream (`fixtures/seller-blind/mock-upstream.mjs`) echoes what a prompt puts in double brackets.
const PROMPT = `Reply with the single word [[${CODEWORD}]] and nothing else.`;

// A local TLS upstream under a test CA needs sidecars that trust it: TESTBENCH_KEYED_RELAY_BIN names such a binary
// (`fixtures/seller-blind/relay-test-ca.mjs`).
const relayBin = process.env.TESTBENCH_KEYED_RELAY_BIN;
const relayEnv = relayBin ? { ANTSEED_KEYED_RELAY_BIN: relayBin } : {};

export const meta = {
  description: 'Seller-blind relay against a real upstream: a zero-data-access chat on a `seller-blind` service is answered streamed and not streamed, the buyer signs exactly the usage the upstream reported at the seller\'s price, and settlement equals what was signed.',
  targets: ['local', 'fork'],
  requires: ['liveUpstream'],
  covers: [
    'seller-blind relay (packages/keyed-relay, packages/node/src/seller-blind-relay.ts, apps/cli/src/proxy/blind-relay.ts)',
    'billing from the revealed usage',
  ],
};

export const topology = {
  mode: 'cli',
  sellers: [{ id: 'seller', ...(relayBin ? { env: relayEnv } : {}) }],
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

export async function run(tb) {
  const [seller] = tb.sellers;
  const service = blindService(tb, seller.id);
  tb.check('the seller offers a seller-blind service', service !== null, tb.manifest.topology.sellers[0].providers);
  if (!service) return;

  const ask = (stream) => tb.request('/v1/chat/completions', {
    stream,
    timeoutMs: 120_000,
    headers: { 'x-antseed-gateway-auth': CONTROL_SECRET, 'x-antseed-routing-policy': POLICY },
    body: {
      model: `${seller.peerId}@${service.id}`,
      messages: [{ role: 'user', content: PROMPT }],
      max_tokens: 16,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    },
  });
  // Rounded for each response, like the seller's metering, so a fractional price per million tokens adds up the same.
  const cost = (usage) => usageCost(service.pricing, { prompt: usage?.prompt_tokens ?? 0, completion: usage?.completion_tokens ?? 0 });

  const plain = await ask(false);
  const plainText = plain.json?.choices?.[0]?.message?.content ?? '';
  tb.check('a zero-data-access chat is answered through the relay', plain.status === 200 && plainText.toLowerCase().includes(CODEWORD), { status: plain.status, body: plain.text.slice(0, 300) });
  tb.check('it reports the upstream\'s usage', plain.json?.usage?.prompt_tokens > 0 && plain.json?.usage?.completion_tokens > 0, plain.json?.usage);
  tb.metric('relayChatMs', plain.latencyMs);

  const stream = await ask(true);
  const read = stream.status === 200 ? streamed(stream.text) : { content: '', usage: null };
  tb.check('a streamed zero-data-access chat is answered through the relay', stream.status === 200 && read.content.toLowerCase().includes(CODEWORD), { status: stream.status, body: stream.text.slice(0, 300) });
  tb.check('the stream ends with the upstream\'s usage', read.usage?.prompt_tokens > 0 && read.usage?.completion_tokens > 0, read.usage);
  tb.metric('relayStreamChatMs', stream.latencyMs);

  // Without the policy the same service is an ordinary chat: the relay is only for requests that ask for it.
  const ordinary = await tb.request('/v1/chat/completions', { body: { model: `${seller.peerId}@${service.id}`, messages: [{ role: 'user', content: PROMPT }], max_tokens: 16 } });
  tb.check('the same service still answers an ordinary chat', ordinary.status === 200, { status: ordinary.status, body: ordinary.text.slice(0, 300) });

  const expected = cost(plain.json?.usage) + cost(read.usage) + cost(ordinary.json?.usage);
  const open = await tb.waitForPaidChannels(seller.id, { requests: 3, signed: expected });
  const signed = open.reduce((total, channel) => total + BigInt(channel.cumulativeSigned ?? '0'), 0n);
  tb.check('the buyer signed exactly the reported usage at the seller\'s price', signed === expected, {
    signed: String(signed), expected: String(expected),
    relayed: String(cost(plain.json?.usage)), relayedStream: String(cost(read.usage)), ordinary: String(cost(ordinary.json?.usage)),
  });
  tb.check('receipts cover the three requests', open.reduce((total, channel) => total + (channel.requestCount ?? 0), 0) === 3, open.map((channel) => channel.requestCount));

  await tb.closeAll();
  const settlement = await tb.assertSettlementMatchesSigned(await tb.signedBySeller());
  tb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
  tb.check('settlement equals the cost of the three requests', BigInt(settlement.totalPaidMicroUsdc) === expected, { settled: settlement.totalPaidMicroUsdc, expected: String(expected) });
}
