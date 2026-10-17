import { describe, it, expect } from 'vitest';
import {
  encodeSpendingAuth,
  decodeSpendingAuth,
  encodeNeedAuth,
  decodeNeedAuth,
  encodePaymentRequired,
  decodePaymentRequired,
  encodeAuthAck,
  decodeAuthAck,
} from './payment-codec.js';

describe('payment payload codec', () => {
  it('round-trips a SpendingAuth with reserve fields', () => {
    const payload = {
      channelId: '0x' + 'aa'.repeat(32),
      cumulativeAmount: '0',
      metadataHash: '0x' + 'bb'.repeat(32),
      metadata: '0x' + 'cc'.repeat(64),
      spendingAuthSig: '0x' + 'dd'.repeat(65),
      reserveSalt: '0x' + 'ee'.repeat(32),
      reserveMaxAmount: '500000',
      reserveDeadline: 1900000000,
      reserveBatch: {
        cumulativeAmount: '325000',
        metadataHash: '0x' + '11'.repeat(32),
        metadata: '0x' + '22'.repeat(64),
        spendingAuthSig: '0x' + '33'.repeat(65),
        maxAmount: '4200000',
        deadline: 1900000001,
        reserveAuthSig: '0x' + '44'.repeat(65),
      },
      oneOffRequestId: 'req-video',
    };
    expect(decodeSpendingAuth(encodeSpendingAuth(payload))).toEqual(payload);
  });

  it('round-trips NeedAuth with token accounting fields', () => {
    const payload = {
      channelId: '0x' + 'aa'.repeat(32),
      requiredCumulativeAmount: '1200',
      currentAcceptedCumulative: '0',
      deposit: '500000',
      requestId: 'req-1',
      lastRequestCost: '1200',
      inputTokens: '300000',
      cachedInputTokens: '50000',
      freshInputTokens: '250000',
      outputTokens: '20000',
      service: 'test-model',
    };
    expect(decodeNeedAuth(encodeNeedAuth(payload))).toEqual(payload);
  });

  it('round-trips PaymentRequired and AuthAck', () => {
    const required = {
      minBudgetPerRequest: '1000',
      suggestedAmount: '500000',
      requestId: 'req-2',
      inputUsdPerMillion: 3000,
      outputUsdPerMillion: 15000,
      code: 'one_off_channel_required' as const,
      oneOffPlan: {
        openingReserveAmount: '1000000',
        requiredCumulativeAmount: '650000',
        requestCost: '4200000',
      },
    };
    expect(decodePaymentRequired(encodePaymentRequired(required))).toMatchObject(required);
    const ack = { channelId: '0x' + 'ab'.repeat(32) };
    expect(decodeAuthAck(encodeAuthAck(ack))).toEqual(ack);
  });

  it('refuses to encode a payment payload the peer would drop', () => {
    expect(() => encodeSpendingAuth({
      channelId: `0x${'1'.repeat(64)}`,
      cumulativeAmount: '1',
      metadataHash: `0x${'2'.repeat(64)}`,
      metadata: `0x${'0'.repeat(70_000)}`,
      spendingAuthSig: `0x${'3'.repeat(130)}`,
    })).toThrow(/Payment payload too large/);
  });

  it('reports an oversized incoming SpendingAuth as too large', () => {
    // node.ts rotates a buyer's channel when a SpendingAuth fails with this
    // message, so the decoder's wording is part of that contract.
    const oversized = new TextEncoder().encode(JSON.stringify({ metadata: '0'.repeat(70_000) }));
    expect(() => decodeSpendingAuth(oversized)).toThrow(/payload too large/i);
  });

  it('rejects payloads missing required fields', () => {
    expect(() => decodeNeedAuth(new TextEncoder().encode('{"channelId":"x"}'))).toThrow();
    expect(() => decodeSpendingAuth(new TextEncoder().encode('not json'))).toThrow();
  });
});
