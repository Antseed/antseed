import { request as httpRequest } from 'node:http';
import { estimateTokensFromText } from '@antseed/node';
import { MOCK_USAGE, NO_USAGE_MARKER } from '../../lib/mock.mjs';
import { parseSse } from '../../lib/tb.mjs';

export const meta = {
  description: 'A streamed chat is billed for what it delivered, whatever the request says about usage: asking for no usage still pays the exact cost, a path that does not mean what it says is refused, and an upstream that never reports usage is paid by estimate. Settlement equals what was signed.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

export const topology = {
  sellers: [{ id: 'seller' }],
};

/** POST through the proxy with the path exactly as written: fetch would resolve its dot segments first. */
function postRawPath(proxyUrl, path, body) {
  const { hostname, port } = new URL(proxyUrl);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname, port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

export async function run(tb) {
  const [seller] = tb.sellers;
  const model = seller.models[0];
  const cost = tb.mockCostPerChat(seller.id, model);
  const upstreamChats = async () => (await tb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/chat/completions');
  const channel = async () => ((await tb.channels())[seller.id] ?? [])[0];
  const signed = async () => BigInt((await channel())?.cumulativeSigned ?? '0');
  const chatBody = (content, extra = {}) => ({ model, messages: [{ role: 'user', content }], stream: true, ...extra });
  const streamChat = (content, extra) => tb.request('/v1/chat/completions', { stream: true, body: chatBody(content, extra) });
  tb.metric('costPerChatMicroUsdc', String(cost));

  const fresh = { chats: (await upstreamChats()).length, channel: await channel() };
  tb.check('scenario starts on a fresh testbench (no chats, no open channel)', fresh.chats === 0 && !fresh.channel, fresh);

  // A client asks for no usage on the stream.
  const optedOut = await streamChat('paid request that asks for no usage', { stream_options: { include_usage: false } });
  await tb.waitForPaidChannels(seller.id, { requests: 1, signed: cost, timeoutMs: 15_000 });
  const signedAfterOptOut = await signed();
  const askedUpstream = (await upstreamChats()).at(-1);

  // A path that reaches the chat endpoint only once its dot segments are resolved.
  const chatsBeforeDotPath = (await upstreamChats()).length;
  const dotPath = await postRawPath(tb.proxyUrl, '/v1/models/../chat/completions', {
    model, messages: [{ role: 'user', content: 'paid request on a path with a dot segment' }], stream: true,
  });
  const chatsAfterDotPath = (await upstreamChats()).length;

  // An upstream that reports no usage even when asked.
  const silentPrompt = `${NO_USAGE_MARKER} paid request to an upstream that reports no usage`;
  const silent = await streamChat(silentPrompt);
  await tb.waitForPaidChannels(seller.id, { requests: 1, signed: signedAfterOptOut + 1n, timeoutMs: 15_000 });
  const signedAfterSilent = await signed();
  const estimate = signedAfterSilent - signedAfterOptOut;

  const observed = {
    askedForNoUsage: { status: optedOut.status, upstreamAskedForUsage: askedUpstream?.includeUsage ?? null, signed: String(signedAfterOptOut), delivered: String(cost) },
    pathWithDotSegment: { status: dotPath.status, upstreamChatsServed: chatsAfterDotPath - chatsBeforeDotPath },
    upstreamWithoutUsage: { status: silent.status, signedForIt: String(estimate) },
  };
  // One check first, so a failure shows every case at once.
  tb.check(
    'every chat the upstream served was paid for',
    signedAfterOptOut === cost && chatsAfterDotPath === chatsBeforeDotPath && estimate > 0n,
    observed,
  );

  const optedOutAnswer = parseSse(optedOut.text);
  tb.check('the request that asks for no usage was answered in full, with the closing usage chunk', optedOut.status === 200 && optedOutAnswer.done && optedOutAnswer.content.includes('Hello from') && JSON.stringify(optedOutAnswer.usage) === JSON.stringify(MOCK_USAGE), { status: optedOut.status, ...optedOutAnswer });
  tb.check('the upstream was asked for usage anyway', askedUpstream?.includeUsage === true, askedUpstream);
  tb.check('the path with a dot segment was refused', dotPath.status === 400 && JSON.parse(dotPath.text).error?.code === 'invalid_request_path', { status: dotPath.status, body: dotPath.text.slice(0, 300) });
  const silentAnswer = parseSse(silent.text);
  tb.check('the answer without usage was delivered in full, with no usage in it', silent.status === 200 && silentAnswer.done && silentAnswer.content.includes('Hello from') && silentAnswer.usage === null, { status: silent.status, ...silentAnswer });
  // Worked out here from what was sent and received, at the service's price: the prompt's tokens plus the answer's.
  const provider = Object.values(tb.manifest.topology.sellers.find((entry) => entry.id === seller.id).providers).find((entry) => entry.services?.[model]);
  const price = { ...(provider.defaults ?? {}), ...(provider.services[model].pricing ?? {}) };
  const [promptTokens, answerTokens] = [estimateTokensFromText(JSON.stringify(chatBody(silentPrompt))), estimateTokensFromText(silentAnswer.content)];
  const expectedEstimate = BigInt(Math.round(promptTokens * price.inputUsdPerMillion + answerTokens * price.outputUsdPerMillion));
  tb.check('the charge is the estimate of the prompt and the answer', estimate === expectedEstimate, { estimate: String(estimate), expected: String(expectedEstimate), promptTokens, answerTokens, price });
  tb.metric('estimateMicroUsdc', String(estimate));

  await tb.closeAll();
  const expected = await tb.signedBySeller();
  const settlement = await tb.assertSettlementMatchesSigned(expected);
  tb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
  tb.check(
    'settled amount equals the delivered cost plus the estimate',
    BigInt(settlement.totalPaidMicroUsdc) === cost + estimate,
    { settled: settlement.totalPaidMicroUsdc, delivered: String(cost), estimate: String(estimate) },
  );
}
