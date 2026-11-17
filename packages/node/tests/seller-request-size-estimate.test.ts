import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { SellerBuyerLimiter } from '../src/payments/seller-buyer-limiter.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import { VerificationMux } from '../src/verification/index.js';

const encoder = new TextEncoder();
const BUYER = '22'.repeat(20);
const CHANNEL = '0x' + 'ab'.repeat(32);
/** $1 per million tokens: N tokens price to exactly N base units. */
const PRICE = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
/** Far more than the few thousand tokens a short chat with one screenshot is upstream. */
const LIMIT_TOKENS = 50_000;

/** About 2 MB of base64, the size of a screenshot pasted into a coding agent's chat. */
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let seed = 1;
const SCREENSHOT = 'iVBORw0KGgo' + Array.from({ length: 2_000_000 }, () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return BASE64[seed % 64];
}).join('');

const chat = (content: unknown) => encoder.encode(JSON.stringify({
  model: 'test-model',
  max_tokens: 1_000,
  messages: [{ role: 'user', content }],
}));

const withScreenshot = (part: Record<string, unknown>) => chat([{ type: 'text', text: 'What does this screen show?' }, part]);

/** A text-only chat of the same size: its bytes are tokens upstream, so it must still count in full. */
const LONG_TEXT = chat('seed '.repeat(400_000));

function provider(): Provider {
  return {
    name: 'p',
    services: ['test-model'],
    pricing: { defaults: PRICE },
    maxConcurrency: 1,
    handleRequest: vi.fn(async (request: SerializedHttpRequest) => ({
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: encoder.encode(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'A login form.' } }], usage: { prompt_tokens: 1_300, completion_tokens: 4 } })),
    })),
    getCapacity: () => ({ current: 0, max: 1 }),
  };
}

/** A buyer with an open channel whose locked reserve is `reserveMax` base units. */
function paymentManager(reserveMax: bigint) {
  let spent = 0n;
  return {
    hasSession: () => true,
    hasClosingChannel: () => false,
    getChannelByPeer: () => ({ sessionId: CHANNEL, authMax: '0' }),
    waitForPendingAuths: async () => {},
    getAcceptedCumulative: () => spent,
    getCumulativeSpend: () => spent,
    getEffectiveReserveMax: () => reserveMax,
    isChannelBlocked: () => false,
    beginBillableRequest: () => {},
    endBillableRequest: () => {},
    recordSpend: (_channel: string, amount: bigint) => { spent += amount; },
    // No top-up is mining: the reserve is what it is.
    isTopUpRunning: () => false,
    isTopUpPendingFor: () => false,
    waitForTopUp: async () => false,
    refreshReserveMaxFromChain: async () => reserveMax,
    getPaymentRequirements: () => ({ minBudgetPerRequest: '0', suggestedAmount: '0' }),
    closeSessionWhenIdle: async () => {},
  };
}

/** Serves one request and returns the status the buyer is answered. */
async function serve(body: Uint8Array, options: { limiter?: SellerBuyerLimiter; reserveMax?: bigint; reserveEstimateOverdraftUsdc?: bigint }) {
  const handler = new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [provider()],
    sellerPaymentManager: paymentManager(options.reserveMax ?? 1_000_000_000n) as any,
    sessionTracker: null,
    channelsClient: {} as any,
    announcer: null,
    emit: () => false,
    sellerBuyerLimiter: options.limiter ?? null,
    ...(options.reserveEstimateOverdraftUsdc !== undefined ? { reserveEstimateOverdraftUsdc: options.reserveEstimateOverdraftUsdc } : {}),
  });
  const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
  const { mux } = handler.handleConnection(conn as any, BUYER, { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any, new VerificationMux(conn as any));
  await mux.handleFrame({
    type: MessageType.HttpRequest,
    messageId: 1,
    payload: encodeHttpRequest({ requestId: 'req-1', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body }),
  });
  const frame = conn.send.mock.calls.map(([raw]) => decodeFrame(raw)!.message).find((message) => message.type === MessageType.HttpResponse)!;
  return decodeHttpResponse(frame.payload).statusCode;
}

/** A limiter that has already counted one small request from the buyer. */
function limiter(): SellerBuyerLimiter {
  const limiter = new SellerBuyerLimiter({ maxTokensPerBuyer: LIMIT_TOKENS, windowMinutes: 60 }, () => null);
  const admission = limiter.admit(BUYER, 'p', 100, 'test-model');
  if (admission.admitted) admission.reservation.finish(100);
  return limiter;
}

const SCREENSHOT_PARTS: Array<[string, Record<string, unknown>]> = [
  ['an OpenAI Chat image', { type: 'image_url', image_url: { url: `data:image/png;base64,${SCREENSHOT}` } }],
  ['a Responses image', { type: 'input_image', image_url: `data:image/png;base64,${SCREENSHOT}` }],
  ['an Anthropic image', { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SCREENSHOT } }],
];

/** Images inside a tool's result: content the model sees as an image, so the flat allowance applies. */
const TOOL_RESULT_IMAGES: Array<[string, Uint8Array]> = [
  ['an Anthropic tool result', encoder.encode(JSON.stringify({ model: 'test-model', max_tokens: 1_000, messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: SCREENSHOT } }] }] },
  ] }))],
  ['a Responses tool output', encoder.encode(JSON.stringify({ model: 'test-model', max_output_tokens: 1_000, input: [
    { type: 'function_call', call_id: 'c1', name: 'screenshot', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: `data:image/png;base64,${SCREENSHOT}` }] },
  ] }))],
];

/** Text the model reads, in objects shaped like an image but outside a content part: it counts in full. */
const LONG_TEXT_VALUE = 'seed '.repeat(400_000);
const IMAGE_SHAPED_TEXT: Array<[string, Uint8Array]> = [
  ['a tool call input', encoder.encode(JSON.stringify({ model: 'test-model', max_tokens: 1_000, messages: [
    { role: 'user', content: 'Describe it.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'describe', input: { type: 'image', source: { type: 'base64', data: LONG_TEXT_VALUE } } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
  ] }))],
  ['a tool schema', encoder.encode(JSON.stringify({ model: 'test-model', max_tokens: 1_000, messages: [{ role: 'user', content: 'Hi.' }],
    tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { img: { type: 'image_url', image_url: { url: 'x' }, description: LONG_TEXT_VALUE } } } } }] }))],
  ['a message field outside its content', encoder.encode(JSON.stringify({ model: 'test-model', max_tokens: 1_000, messages: [
    { role: 'user', content: 'Hi.', metadata: { type: 'input_image', image_url: LONG_TEXT_VALUE } },
  ] }))],
];

/** Attachments whose tokens grow with their length: they keep counting by their bytes. */
const LONG_ATTACHMENT_PARTS: Array<[string, Record<string, unknown>]> = [
  ['an OpenAI Chat file', { type: 'file', file: { file_data: `data:application/pdf;base64,${SCREENSHOT}`, filename: 'report.pdf' } }],
  ['OpenAI Chat audio', { type: 'input_audio', input_audio: { data: SCREENSHOT, format: 'wav' } }],
  ['a Responses file', { type: 'input_file', file_data: `data:application/pdf;base64,${SCREENSHOT}`, filename: 'report.pdf' }],
  ['an Anthropic document', { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: SCREENSHOT } }],
];

describe('seller pre-request size estimate', () => {
  describe('buyer limits', () => {
    it.each(SCREENSHOT_PARTS)('admits a short chat with %s, counting the image as an attachment, not its base64 bytes', async (_shape, part) => {
      expect(await serve(withScreenshot(part), { limiter: limiter() })).toBe(200);
    });

    it('still refuses a text prompt over the limit', async () => {
      expect(await serve(LONG_TEXT, { limiter: limiter() })).toBe(429);
    });

    it.each(LONG_ATTACHMENT_PARTS)('still counts %s by its size', async (_shape, part) => {
      expect(await serve(withScreenshot(part), { limiter: limiter() })).toBe(429);
    });

    it.each(TOOL_RESULT_IMAGES)('admits an image in %s as an attachment', async (_shape, body) => {
      expect(await serve(body, { limiter: limiter() })).toBe(200);
    });

    it.each(IMAGE_SHAPED_TEXT)('counts image-shaped text in %s in full', async (_shape, body) => {
      expect(await serve(body, { limiter: limiter() })).toBe(429);
    });
  });

  describe('locked reserve', () => {
    const reserve = { reserveMax: BigInt(LIMIT_TOKENS), reserveEstimateOverdraftUsdc: 0n };

    it.each(SCREENSHOT_PARTS)('serves a short chat with %s within a reserve that covers its tokens', async (_shape, part) => {
      expect(await serve(withScreenshot(part), reserve)).toBe(200);
    });

    it('still refuses a text prompt the reserve cannot cover', async () => {
      expect(await serve(LONG_TEXT, reserve)).toBe(402);
    });

    it.each(LONG_ATTACHMENT_PARTS)('still refuses %s the reserve cannot cover', async (_shape, part) => {
      expect(await serve(withScreenshot(part), reserve)).toBe(402);
    });

    it.each(TOOL_RESULT_IMAGES)('serves an image in %s within the reserve', async (_shape, body) => {
      expect(await serve(body, reserve)).toBe(200);
    });

    it.each(IMAGE_SHAPED_TEXT)('refuses image-shaped text in %s the reserve cannot cover', async (_shape, body) => {
      expect(await serve(body, reserve)).toBe(402);
    });
  });
});
