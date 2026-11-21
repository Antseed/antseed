import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { VerificationMux } from '../src/verification/index.js';
import { BLIND_RELAY_CREDENTIAL_PATH } from '@antseed/protocol/blind-relay';

const BUYER = '33'.repeat(20);

function makeProvider(): Provider {
  return {
    name: 'test-provider',
    services: ['blind-model', 'plain-model'],
    serviceCategories: { 'blind-model': ['chat', 'seller-blind'], 'plain-model': ['chat'] },
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
    maxConcurrency: 1,
    handleRequest: vi.fn(),
    getCapacity: () => ({ current: 0, max: 1 }),
    mintBlindCredential: vi.fn(async () => ({
      handle: 'h',
      credential: 'scoped-token',
      upstream: { host: 'api.example.com', port: 443, baseUrl: 'https://api.example.com/v1', model: 'org/blind-model' },
      expiresAt: Date.now() + 600_000,
      spendLimitUsd: 0.1,
    })),
    blindCredentialSpendUsd: vi.fn(async () => 0),
  };
}

function spm(state: { session: boolean; accepted?: bigint; spent?: bigint }) {
  return {
    hasSession: vi.fn(() => state.session),
    getChannelByPeer: vi.fn(() => (state.session ? { sessionId: '0xchannel', authMax: '1000000' } : null)),
    getAcceptedCumulative: vi.fn(() => state.accepted ?? 0n),
    getCumulativeSpend: vi.fn(() => state.spent ?? 0n),
    getPaymentRequirements: vi.fn(() => ({ minBudgetPerRequest: '10000', suggestedAmount: '100000', requestId: 'r' })),
    recordSpend: vi.fn(),
  };
}

async function ask(model: string, options: { payments?: ReturnType<typeof spm> | null; method?: string } = {}) {
  const handler = new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [makeProvider()],
    sellerPaymentManager: (options.payments === undefined ? spm({ session: true }) : options.payments) as any,
    sessionTracker: null,
    channelsClient: options.payments === null ? null : ({} as any),
    announcer: null,
    emit: vi.fn(() => true),
  });
  const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
  const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any;
  const { mux } = handler.handleConnection(conn as any, BUYER, paymentMux, new VerificationMux(conn as any));
  await mux.handleFrame({
    type: MessageType.HttpRequest,
    messageId: 1,
    payload: encodeHttpRequest({
      requestId: 'req-1',
      method: options.method ?? 'POST',
      path: BLIND_RELAY_CREDENTIAL_PATH,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model })),
    }),
  });
  const response = conn.send.mock.calls
    .map(([raw]) => decodeFrame(raw)!.message)
    .filter((message) => message.type === MessageType.HttpResponse)
    .map((frame) => decodeHttpResponse(frame.payload))[0]!;
  return { response, json: JSON.parse(new TextDecoder().decode(response.body)), paymentMux };
}

describe('seller blind relay credential route', () => {
  it('mints for a buyer with a paid-up channel, and says the mint itself costs nothing', async () => {
    const { response, json } = await ask('blind-model');
    expect(response.statusCode).toBe(200);
    expect(json).toMatchObject({ credential: 'scoped-token', upstream: { model: 'org/blind-model' }, usage: { prompt_tokens: 0, completion_tokens: 0 } });
    expect(json.credentialId).toMatch(/^[0-9a-f]{32}$/);
    expect(json.handle).toBeUndefined();
  });

  it('refuses a service that is not blind-relayed', async () => {
    const { response, json } = await ask('plain-model');
    expect(response.statusCode).toBe(404);
    expect(json.error.code).toBe('blind_relay_not_supported');
  });

  it('asks a buyer with no channel to open one', async () => {
    const { response, paymentMux } = await ask('blind-model', { payments: spm({ session: false }) });
    expect(response.statusCode).toBe(402);
    expect(paymentMux.sendPaymentRequired).toHaveBeenCalledOnce();
  });

  it('refuses a buyer that has not signed for relayed requests yet', async () => {
    const { response, json } = await ask('blind-model', { payments: spm({ session: true, accepted: 100n, spent: 500n }) });
    expect(response.statusCode).toBe(409);
    expect(json.error.code).toBe('blind_relay_unpaid');
  });

  it('mints nothing on a seller that takes no payments', async () => {
    const { response } = await ask('blind-model', { payments: null });
    expect(response.statusCode).toBe(503);
  });
});
