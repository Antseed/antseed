// The seller-blind relay when the buyer cannot reveal the usage: an upstream that puts the usage on the event with
// the answer's last words leaves the buyer nothing to show but the status line, so the seller bills an estimate
// within the request it checked (the body's length, and the answer's length up to the request's output limit). The
// buyer prices the answer by the same estimate from its own request and answer, signs every charge, and the seller
// admits the next request, for more requests than the buyer's overdraft window covers.
//
// It needs the local TLS upstream in `fixtures/seller-blind/`, which answers `[[usage-with-answer]]` that way (the
// README's scenario list has the command), so it runs with --live only and spends nothing.
import { usageCost } from '../../lib/mock.mjs';

const CONTROL_SECRET = 'testbench-control-secret';
const POLICY = Buffer.from(JSON.stringify({ requireZeroDataAccess: true })).toString('base64url');
const PROMPT = 'Reply with a long answer. [[usage-with-answer]]';
/** The output limit of each request: the answer is longer, so the estimate bills exactly this many output tokens. */
const MAX_TOKENS = 400;
/** The buyer's overdraft window, and the seller's first-sign minimum (it may not exceed the window). */
const WINDOW_USDC = '0.01';
const WINDOW_MICROS = 10_000n;
/** Relayed chats in a row: worth more than three overdraft windows at the fixture's prices. */
const RUN = 10;

const relayBin = process.env.TESTBENCH_KEYED_RELAY_BIN;
const relayEnv = relayBin ? { ANTSEED_KEYED_RELAY_BIN: relayBin } : {};

export const meta = {
  description: 'Seller-blind relay with usage the buyer cannot reveal: a run of relayed chats worth more than the buyer\'s overdraft window is answered in full, the buyer signs the seller\'s estimate for each, and settlement equals what was signed.',
  targets: ['local', 'fork'],
  requires: ['liveUpstream'],
  covers: [
    'billing a relayed answer the buyer reveals no usage of (packages/node/src/keyed-relay-billing.ts, packages/node/src/blind-relay-billing.ts)',
    'the buyer signs for it, and the seller admits the next relayed request',
  ],
};

export const topology = {
  mode: 'cli',
  sellers: [{ id: 'seller', ...(relayBin ? { env: relayEnv } : {}) }],
  buyer: { maxPerRequestUsdc: WINDOW_USDC, env: { ANTSEED_GATEWAY_CONTROL_SECRET: CONTROL_SECRET, ...relayEnv } },
  payments: { minBudgetPerRequestUsdc: WINDOW_USDC },
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

/** The text of a streamed answer, its usage, and whether the usage came on an event that also carried text. */
function streamed(text) {
  let content = '';
  let usage = null;
  let usageWithText = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const event = JSON.parse(line.slice(6));
    const delta = event.choices?.[0]?.delta?.content ?? '';
    content += delta;
    if (event.usage) { usage = event.usage; usageWithText = delta.length > 0; }
  }
  return { content, usage, usageWithText };
}

export async function run(tb) {
  const [seller] = tb.sellers;
  const service = blindService(tb, seller.id);
  tb.check('the seller offers a seller-blind service', service !== null, tb.manifest.topology.sellers[0].providers);
  if (!service) return;

  const messages = [{ role: 'user', content: PROMPT }];
  const answers = [];
  for (let index = 0; index < RUN; index += 1) {
    const response = await tb.request('/v1/chat/completions', {
      stream: true,
      timeoutMs: 120_000,
      headers: { 'x-antseed-gateway-auth': CONTROL_SECRET, 'x-antseed-routing-policy': POLICY },
      body: { model: `${seller.peerId}@${service.id}`, messages, max_tokens: MAX_TOKENS, stream: true, stream_options: { include_usage: true } },
    });
    answers.push({ status: response.status, text: response.text, ...(response.status === 200 ? streamed(response.text) : {}) });
    // A seller that is not signed for refuses the next relayed request, so stop at the first one refused.
    if (response.status !== 200) break;
  }
  const answered = answers.filter((answer) => answer.status === 200);
  const last = answers.at(-1);
  tb.check(`all ${RUN} relayed chats in a row are answered`, answered.length === RUN, { answered: answered.length, lastStatus: last.status, lastBody: last.text.slice(0, 300) });
  const [first] = answered;
  const upstreamFits = Boolean(first?.usageWithText) && Buffer.byteLength(first.content) >= MAX_TOKENS * 4;
  tb.check('the upstream reports the usage on an event with the answer\'s text, after a long answer (the local TLS upstream does)', upstreamFits, { usage: first?.usage, usageWithText: first?.usageWithText, answerBytes: Buffer.byteLength(first?.content ?? '') });
  if (answered.length !== RUN || !upstreamFits) return;

  // The estimate: the request body at four bytes a token, and the output limit, since the answer is longer than it.
  // The buyer rewrites the body (the checked fields go last), so the input is known here only within bounds.
  const price = (bodyBytes) => usageCost(service.pricing, { prompt: Math.ceil(bodyBytes / 4), completion: MAX_TOKENS });
  const least = BigInt(RUN) * price(Buffer.byteLength(JSON.stringify(messages)));
  const most = BigInt(RUN) * price(Buffer.byteLength(JSON.stringify(messages)) + 400);
  const reported = answered.reduce((total, answer) => total + usageCost(service.pricing, { prompt: answer.usage.prompt_tokens, completion: answer.usage.completion_tokens }), 0n);

  const open = await tb.waitForPaidChannels(seller.id, { requests: RUN, signed: least });
  const signed = open.reduce((total, channel) => total + BigInt(channel.cumulativeSigned ?? '0'), 0n);
  tb.check('the buyer signed the estimate for every answer', signed >= least && signed <= most, { signed: String(signed), least: String(least), most: String(most) });
  tb.check('which is more than the usage the answers reported plus the overdraft window: each charge was verified, none signed on trust', signed > reported + WINDOW_MICROS, { signed: String(signed), reported: String(reported), window: String(WINDOW_MICROS) });
  tb.check('receipts cover every request', open.reduce((total, channel) => total + (channel.requestCount ?? 0), 0) === RUN, open.map((channel) => channel.requestCount));

  await tb.closeAll();
  const settlement = await tb.assertSettlementMatchesSigned(await tb.signedBySeller());
  tb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
  tb.check('settlement equals what the buyer signed', BigInt(settlement.totalPaidMicroUsdc) === signed, { settled: settlement.totalPaidMicroUsdc, signed: String(signed) });
}
