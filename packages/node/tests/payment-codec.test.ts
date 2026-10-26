import { describe, it, expect } from 'vitest';
import {
  encodeSpendingAuth, decodeSpendingAuth,
  encodeAuthAck, decodeAuthAck,
  encodeFreeUsageOpen, decodeFreeUsageOpen,
  encodeFreeUsageAuth, decodeFreeUsageAuth,
  encodeFreeUsageAck, decodeFreeUsageAck,
  encodeNeedFreeUsageAuth, decodeNeedFreeUsageAuth,
  encodePaymentRequired, decodePaymentRequired,
  encodeNeedAuth, decodeNeedAuth,
  encodeCloseChannelRequest, decodeCloseChannelRequest,
  encodeCloseChannelResult, decodeCloseChannelResult,
} from '../src/p2p/payment-codec.js';

describe('payment codec round-trips', () => {
  it('SpendingAuth', () => {
    const payload = {
      channelId: '0x' + 'aa'.repeat(32),
      cumulativeAmount: '1000000',
      metadataHash: '0x' + 'cc'.repeat(32),
      metadata: '0x' + 'dd'.repeat(128),
      spendingAuthSig: '0x' + 'ee'.repeat(65),
    };
    const encoded = encodeSpendingAuth(payload);
    const decoded = decodeSpendingAuth(encoded);
    expect(decoded).toEqual(payload);
  });

  it('AuthAck', () => {
    const payload = { channelId: '0x' + 'aa'.repeat(32) };
    expect(decodeAuthAck(encodeAuthAck(payload))).toEqual(payload);
  });

  it('FreeUsageOpen', () => {
    const payload = {
      channelId: '0x' + 'ab'.repeat(32),
      salt: '0x' + '01'.repeat(32),
      deadline: 123456,
      openSig: '0x' + 'ef'.repeat(65),
    };
    expect(decodeFreeUsageOpen(encodeFreeUsageOpen(payload))).toEqual(payload);
    const withDelegations = { ...payload, freeTierDelegations: 'delegations-header' };
    expect(decodeFreeUsageOpen(encodeFreeUsageOpen(withDelegations))).toEqual(withDelegations);
  });

  it('rejects FreeUsageOpen with a non-finite deadline', () => {
    const encoded = new TextEncoder().encode(JSON.stringify({
      channelId: '0x' + 'ab'.repeat(32),
      salt: '0x' + '01'.repeat(32),
      deadline: 'NaN',
      openSig: '0x' + 'ef'.repeat(65),
    }));
    expect(() => decodeFreeUsageOpen(encoded)).toThrow(/finite number/);
  });

  it('FreeUsageAuth', () => {
    const payload = {
      channelId: '0x' + 'ab'.repeat(32),
      cumulativeInputTokens: '100',
      cumulativeOutputTokens: '40',
      sequence: '2',
      metadataHash: '0x' + 'cd'.repeat(32),
      metadata: '0x' + '12'.repeat(128),
      deadline: 123456,
      usageSig: '0x' + 'ef'.repeat(65),
    };
    expect(decodeFreeUsageAuth(encodeFreeUsageAuth(payload))).toEqual(payload);
  });

  it('rejects FreeUsageAuth with a non-finite deadline', () => {
    const encoded = new TextEncoder().encode(JSON.stringify({
      channelId: '0x' + 'ab'.repeat(32),
      cumulativeInputTokens: '100',
      cumulativeOutputTokens: '40',
      sequence: '2',
      metadataHash: '0x' + 'cd'.repeat(32),
      metadata: '0x' + '12'.repeat(128),
      deadline: 'NaN',
      usageSig: '0x' + 'ef'.repeat(65),
    }));
    expect(() => decodeFreeUsageAuth(encoded)).toThrow(/finite number/);
  });

  it('FreeUsageAck', () => {
    const payload = {
      channelId: '0x' + 'ab'.repeat(32),
      acceptedSequence: '2',
    };
    expect(decodeFreeUsageAck(encodeFreeUsageAck(payload))).toEqual(payload);
  });

  it('NeedFreeUsageAuth', () => {
    const payload = {
      channelId: '0x' + 'ab'.repeat(32),
      requiredSequence: '3',
      currentAcceptedSequence: '2',
      requestId: 'req-free',
      inputTokens: '100',
      outputTokens: '40',
      service: 'gpt-free',
    };
    expect(decodeNeedFreeUsageAuth(encodeNeedFreeUsageAuth(payload))).toEqual(payload);
  });

  it('PaymentRequired', () => {
    const payload = {
      minBudgetPerRequest: '10000',
      suggestedAmount: '100000',
      requestId: 'req-123',
    };
    const encoded = encodePaymentRequired(payload);
    const decoded = decodePaymentRequired(encoded);
    expect(decoded).toEqual(payload);
  });

  it('PaymentRequired with optional pricing fields', () => {
    const payload = {
      minBudgetPerRequest: '10000',
      suggestedAmount: '100000',
      requestId: 'req-456',
      inputUsdPerMillion: 3000,
      outputUsdPerMillion: 15000,
    };
    const encoded = encodePaymentRequired(payload);
    const decoded = decodePaymentRequired(encoded);
    expect(decoded).toEqual(payload);
  });

  it('PaymentRequired with budget-exhausted catch-up fields', () => {
    const payload = {
      minBudgetPerRequest: '10000',
      suggestedAmount: '1000000',
      requestId: 'req-789',
      inputUsdPerMillion: 0.36,
      outputUsdPerMillion: 1.65,
      cachedInputUsdPerMillion: 0.07,
      requiredCumulativeAmount: '85119',
      currentSpent: '85119',
      currentAcceptedCumulative: '56218',
      channelId: '0x' + 'aa'.repeat(32),
    };
    const encoded = encodePaymentRequired(payload);
    const decoded = decodePaymentRequired(encoded);
    expect(decoded).toEqual(payload);
  });

  it('PaymentRequired with channel_exhausted code and reserveMaxAmount', () => {
    const payload = {
      minBudgetPerRequest: '10000',
      suggestedAmount: '1000000',
      requestId: 'req-exhausted',
      requiredCumulativeAmount: '11019626',
      currentSpent: '11009626',
      currentAcceptedCumulative: '10998222',
      channelId: '0x' + 'cd'.repeat(32),
      reserveMaxAmount: '11000000',
      code: 'channel_exhausted' as const,
    };
    const encoded = encodePaymentRequired(payload);
    const decoded = decodePaymentRequired(encoded);
    expect(decoded).toEqual(payload);
  });

  it('NeedAuth', () => {
    const payload = {
      channelId: '0x' + 'aa'.repeat(32),
      requiredCumulativeAmount: '500000',
      currentAcceptedCumulative: '200000',
      deposit: '1000000',
    };
    const encoded = encodeNeedAuth(payload);
    const decoded = decodeNeedAuth(encoded);
    expect(decoded).toEqual(payload);
  });

  it('NeedAuth with billingUsage', () => {
    const payload = {
      channelId: '0x' + 'aa'.repeat(32),
      requiredCumulativeAmount: '500000',
      currentAcceptedCumulative: '200000',
      deposit: '1000000',
      requestId: 'req-image',
      lastRequestCost: '80000',
      inputTokens: '0',
      outputTokens: '0',
      billingUsage: {
        version: 1 as const,
        units: { output_images: '2' },
      },
    };
    expect(decodeNeedAuth(encodeNeedAuth(payload))).toEqual(payload);
  });

  it('rejects malformed NeedAuth billingUsage', () => {
    const encoded = new TextEncoder().encode(JSON.stringify({
      channelId: '0x' + 'aa'.repeat(32),
      requiredCumulativeAmount: '500000',
      currentAcceptedCumulative: '200000',
      deposit: '1000000',
      billingUsage: {
        version: 1,
        units: { output_images: '-1' },
      },
    }));
    expect(() => decodeNeedAuth(encoded)).toThrow(/billingUsage/);
  });

  it('CloseChannelRequest without an attached auth', () => {
    const payload = { version: 1 as const, channelId: '0x' + 'aa'.repeat(32) };
    expect(decodeCloseChannelRequest(encodeCloseChannelRequest(payload))).toEqual(payload);
  });

  it('CloseChannelRequest with an attached auth', () => {
    const payload = {
      version: 1 as const,
      channelId: '0x' + 'aa'.repeat(32),
      cumulativeAmount: '750000',
      metadataHash: '0x' + 'cc'.repeat(32),
      metadata: '0x' + 'dd'.repeat(128),
      spendingAuthSig: '0x' + 'ee'.repeat(65),
    };
    expect(decodeCloseChannelRequest(encodeCloseChannelRequest(payload))).toEqual(payload);
  });

  it('CloseChannelRequest drops a partial auth rather than passing it on unverifiable', () => {
    const wire = new TextEncoder().encode(JSON.stringify({
      version: 1,
      channelId: '0x' + 'aa'.repeat(32),
      cumulativeAmount: '750000',
      spendingAuthSig: '0x' + 'ee'.repeat(65),
      // metadata / metadataHash missing
    }));
    const decoded = decodeCloseChannelRequest(wire);
    expect(decoded.cumulativeAmount).toBeUndefined();
    expect(decoded.spendingAuthSig).toBeUndefined();
  });

  it('CloseChannelResult success', () => {
    const payload = {
      version: 1 as const,
      channelId: '0x' + 'aa'.repeat(32),
      status: 'closed' as const,
      txHash: '0x' + 'bb'.repeat(32),
      finalAmount: '750000',
    };
    expect(decodeCloseChannelResult(encodeCloseChannelResult(payload))).toEqual(payload);
  });

  it('CloseChannelResult rejection', () => {
    const payload = {
      version: 1 as const,
      channelId: '0x' + 'aa'.repeat(32),
      status: 'rejected' as const,
      code: 'pending_auth' as const,
      reason: 'unsigned spend outstanding',
      retryAfterMs: 2000,
      requiredCumulativeAmount: '750000',
    };
    expect(decodeCloseChannelResult(encodeCloseChannelResult(payload))).toEqual(payload);
  });

  it('CloseChannelResult drops an unrecognized reject code', () => {
    const wire = new TextEncoder().encode(JSON.stringify({
      version: 1,
      channelId: '0x' + 'aa'.repeat(32),
      status: 'rejected',
      code: 'not_a_real_code',
    }));
    expect(decodeCloseChannelResult(wire).code).toBeUndefined();
  });

  it('CloseChannelResult rejects an unknown status', () => {
    const wire = new TextEncoder().encode(JSON.stringify({
      version: 1,
      channelId: '0x' + 'aa'.repeat(32),
      status: 'maybe',
    }));
    expect(() => decodeCloseChannelResult(wire)).toThrow(/status/);
  });
});
