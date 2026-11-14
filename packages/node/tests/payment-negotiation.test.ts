import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { PaymentMux } from '../src/p2p/payment-mux.js';
import { MessageType, type FramedMessage, type PaymentRequiredPayload } from '../src/types/protocol.js';
import * as codec from '../src/p2p/payment-codec.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';
import { BuyerPaymentNegotiator } from '../src/payments/buyer-payment-negotiator.js';
import { ChannelStore, CHANNEL_ROLE, CHANNEL_STATUS } from '../src/payments/channel-store.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { Wallet } from 'ethers';

function mockConnection(): PeerConnection {
  return { send: vi.fn() } as unknown as PeerConnection;
}

function createTestIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
}

/** Generate a fake but valid-format peerId (40 hex chars) from a label. */
function fakePeerId(label: string): string {
  const hex = Buffer.from(label).toString('hex').padEnd(40, '0').slice(0, 40);
  return hex;
}

const CHAIN_ID = 31337;
const CONTRACT_ADDR = '0x' + 'dd'.repeat(20);

const SAMPLE_PAYMENT_REQUIRED: PaymentRequiredPayload = {
  minBudgetPerRequest: '10000',
  suggestedAmount: '5000000',
  requestId: 'req-' + 'a'.repeat(32),
};

// ═══════════════════════════════════════════════════════════════
// PaymentRequired codec
// ═══════════════════════════════════════════════════════════════

describe('PaymentRequired codec', () => {
  it('round-trips encodePaymentRequired / decodePaymentRequired', () => {
    const encoded = codec.encodePaymentRequired(SAMPLE_PAYMENT_REQUIRED);
    const decoded = codec.decodePaymentRequired(encoded);
    expect(decoded).toEqual(SAMPLE_PAYMENT_REQUIRED);
  });

  it('decodePaymentRequired rejects missing fields', () => {
    const incomplete = new TextEncoder().encode(JSON.stringify({
      minBudgetPerRequest: '10000',
    }));
    expect(() => codec.decodePaymentRequired(incomplete)).toThrow('Missing or invalid string field');
  });

  it('decodePaymentRequired rejects non-object', () => {
    const notObject = new TextEncoder().encode('"just a string"');
    expect(() => codec.decodePaymentRequired(notObject)).toThrow('Expected JSON object');
  });

  it('preserves all fields through encode/decode', () => {
    const payload: PaymentRequiredPayload = {
      minBudgetPerRequest: '10000',
      suggestedAmount: '1500000',
      requestId: 'abc-123',
        };
    const decoded = codec.decodePaymentRequired(codec.encodePaymentRequired(payload));
    expect(decoded.minBudgetPerRequest).toBe(payload.minBudgetPerRequest);
    expect(decoded.suggestedAmount).toBe(payload.suggestedAmount);
    expect(decoded.requestId).toBe(payload.requestId);
  });
});

// ═══════════════════════════════════════════════════════════════
// PaymentMux PaymentRequired
// ═══════════════════════════════════════════════════════════════

describe('PaymentMux PaymentRequired', () => {
  it('dispatches PaymentRequired to registered handler', async () => {
    const conn = mockConnection();
    const mux = new PaymentMux(conn);
    const handler = vi.fn();
    mux.onPaymentRequired(handler);

    const frame: FramedMessage = {
      type: MessageType.PaymentRequired,
      messageId: 1,
      payload: codec.encodePaymentRequired(SAMPLE_PAYMENT_REQUIRED),
    };

    const result = await mux.handleFrame(frame);
    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledWith(SAMPLE_PAYMENT_REQUIRED);
  });

  it('returns true for PaymentRequired even with no handler', async () => {
    const conn = mockConnection();
    const mux = new PaymentMux(conn);

    const frame: FramedMessage = {
      type: MessageType.PaymentRequired,
      messageId: 1,
      payload: codec.encodePaymentRequired(SAMPLE_PAYMENT_REQUIRED),
    };

    const result = await mux.handleFrame(frame);
    expect(result).toBe(true);
  });

  it('sendPaymentRequired encodes and sends via connection', () => {
    const conn = mockConnection();
    const mux = new PaymentMux(conn);

    mux.sendPaymentRequired(SAMPLE_PAYMENT_REQUIRED);
    expect(conn.send).toHaveBeenCalledOnce();

    const sentFrame = (conn.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Uint8Array;
    expect(sentFrame[0]).toBe(MessageType.PaymentRequired);
  });

  it('PaymentRequired (0x56) is in the payment message range', () => {
    expect(PaymentMux.isPaymentMessage(0x56)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Seller: PaymentRequired generation
// ═══════════════════════════════════════════════════════════════

describe('SellerPaymentManager PaymentRequired', () => {
  let tempDir: string;
  let store: ChannelStore;
  let sellerIdentity: Identity;
  let manager: SellerPaymentManager;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'seller-negotiation-'));
    store = new ChannelStore(tempDir);
    sellerIdentity = createTestIdentity();

    const config: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      channelsContractAddress: CONTRACT_ADDR,
          chainId: CHAIN_ID,
      dataDir: tempDir,
    };
    manager = new SellerPaymentManager(sellerIdentity, config, store);

    vi.spyOn(manager.channelsClient, 'reserve').mockResolvedValue('0xhash');
    vi.spyOn(manager.channelsClient, 'close').mockResolvedValue('0xhash');
    vi.spyOn(manager.channelsClient, 'requestClose').mockResolvedValue('0xhash');
    vi.spyOn(manager.channelsClient, 'withdraw').mockResolvedValue('0xhash');
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('getPaymentRequirements returns a valid payload immediately (no init needed)', () => {
    const req = manager.getPaymentRequirements('req-1');
    expect(req).not.toBeNull();
    expect(req.minBudgetPerRequest).toBe('500000'); // default $0.50
    expect(req.suggestedAmount).toBe('1000000'); // $1.00 default
  });

  it('getPaymentRequirements includes the triggering requestId', () => {
    expect(manager.getPaymentRequirements('req-aaa').requestId).toBe('req-aaa');
    expect(manager.getPaymentRequirements('req-bbb').requestId).toBe('req-bbb');
  });

  it('minBudgetPerRequest can be configured', () => {
    const customConfig: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      channelsContractAddress: CONTRACT_ADDR,
          chainId: CHAIN_ID,
      dataDir: tempDir,
      minBudgetPerRequest: '50000',
    };
    const customManager = new SellerPaymentManager(sellerIdentity, customConfig, store);

    const req = customManager.getPaymentRequirements('req-1');
    expect(req.minBudgetPerRequest).toBe('50000');
  });
});

// ═══════════════════════════════════════════════════════════════
// PaymentRequired buffering (race condition: 402 + PR same tick)
// ═══════════════════════════════════════════════════════════════

describe('PaymentMux PaymentRequired buffering', () => {
  it('handler fires immediately when listener is registered first', async () => {
    const conn = mockConnection();
    const mux = new PaymentMux(conn);
    const received: PaymentRequiredPayload[] = [];

    mux.onPaymentRequired((payload) => received.push(payload));

    const frame: FramedMessage = {
      type: MessageType.PaymentRequired,
      messageId: 1,
      payload: codec.encodePaymentRequired(SAMPLE_PAYMENT_REQUIRED),
    };
    await mux.handleFrame(frame);

    expect(received).toHaveLength(1);
    expect(received[0]!.requestId).toBe(SAMPLE_PAYMENT_REQUIRED.requestId);
  });

  it('multiple PaymentRequired frames dispatch to handler in order', async () => {
    const conn = mockConnection();
    const mux = new PaymentMux(conn);
    const received: string[] = [];

    mux.onPaymentRequired((payload) => received.push(payload.requestId));

    for (const id of ['req-1', 'req-2', 'req-3']) {
      const payload = { ...SAMPLE_PAYMENT_REQUIRED, requestId: id };
      await mux.handleFrame({
        type: MessageType.PaymentRequired,
        messageId: 1,
        payload: codec.encodePaymentRequired(payload),
      });
    }

    expect(received).toEqual(['req-1', 'req-2', 'req-3']);
  });
});

// ═══════════════════════════════════════════════════════════════
// Seller: suggested amount for returning vs new buyers
// ═══════════════════════════════════════════════════════════════

describe('SellerPaymentManager suggested amount', () => {
  let tempDir: string;
  let store: ChannelStore;
  let sellerIdentity: Identity;
  let manager: SellerPaymentManager;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'seller-proven-'));
    store = new ChannelStore(tempDir);
    sellerIdentity = createTestIdentity();

    const config: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      channelsContractAddress: CONTRACT_ADDR,
          chainId: CHAIN_ID,
      dataDir: tempDir,
    };
    manager = new SellerPaymentManager(sellerIdentity, config, store);

    vi.spyOn(manager.channelsClient, 'reserve').mockResolvedValue('0xhash');
    vi.spyOn(manager.channelsClient, 'close').mockResolvedValue('0xhash');
    vi.spyOn(manager.channelsClient, 'requestClose').mockResolvedValue('0xhash');
    vi.spyOn(manager.channelsClient, 'withdraw').mockResolvedValue('0xhash');
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('suggests $1.00 amount for new buyers', () => {
    const req = manager.getPaymentRequirements('req-1', 'unknown-buyer');
    expect(req.suggestedAmount).toBe('1000000'); // $1.00
  });

  it('suggests $1.00 for returning buyers with settled sessions', () => {
    // Insert a prior settled session
    store.upsertChannel({
      sessionId: '0x' + 'aa'.repeat(32),
      peerId: 'returning-buyer',
      role: CHANNEL_ROLE.SELLER,
      sellerEvmAddr: sellerIdentity.wallet.address,
      buyerEvmAddr: '0x' + 'bb'.repeat(20),
      nonce: 1,
      authMax: '1000000',
      deadline: Math.floor(Date.now() / 1000) + 3600,
      previousSessionId: '0x' + '00'.repeat(32),
      previousConsumption: '0',
      tokensDelivered: '500',
      requestCount: 5,
      reservedAt: Date.now(),
      settledAt: null,
      settledAmount: null,
      status: CHANNEL_STATUS.SETTLED,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const req = manager.getPaymentRequirements('req-2', 'returning-buyer');
    expect(req.suggestedAmount).toBe('1000000');
  });

  it('includes per-direction pricing when provided', () => {
    const req = manager.getPaymentRequirements('req-3', undefined, {
      inputUsdPerMillion: 3.0,
      outputUsdPerMillion: 15.0,
    });
    expect(req.inputUsdPerMillion).toBe(3.0);
    expect(req.outputUsdPerMillion).toBe(15.0);
  });

  it('omits pricing fields when not provided', () => {
    const req = manager.getPaymentRequirements('req-4');
    expect(req.inputUsdPerMillion).toBeUndefined();
    expect(req.outputUsdPerMillion).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Codec: PaymentRequired with optional pricing fields
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Budget mismatch: seller minBudgetPerRequest > buyer maxPerRequestUsdc
// ═══════════════════════════════════════════════════════════════

describe('Budget mismatch rejection', () => {
  let tempDir: string;
  let store: ChannelStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'budget-mismatch-'));
    store = new ChannelStore(tempDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('buyer refuses when seller minBudgetPerRequest exceeds buyer maxPerRequestUsdc', async () => {
    const buyerIdentity = createTestIdentity();
    const { BuyerPaymentManager } = await import('../src/payments/buyer-payment-manager.js');


    const buyerConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      channelsContractAddress: CONTRACT_ADDR,
          usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: CHAIN_ID,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 50_000n,      // buyer allows max $0.05
      maxReserveAmountUsdc: 10_000_000n,
      dataDir: tempDir,
    };

    const buyer = new BuyerPaymentManager(buyerIdentity, buyerConfig, store);
    buyer.setSigner(buyerIdentity.wallet);

    const mux = {
      sentSpendingAuths: [] as unknown[],
      sendSpendingAuth(payload: unknown) { mux.sentSpendingAuths.push(payload); },
      sendAuthAck() {},
      sendPaymentRequired() {},
      sendNeedAuth() {},
      onSpendingAuth() {},
      onAuthAck() {},
      onPaymentRequired() {},
      onNeedAuth() {},
      handleFrame: vi.fn(),
    } as unknown as import('../src/p2p/payment-mux.js').PaymentMux & { sentSpendingAuths: unknown[] };

    // Seller demands $0.10 per request — exceeds buyer's $0.05 limit
    const sellerMinBudget = 100_000n;
    const sessionId = await buyer.authorizeSpending(
      fakePeerId('seller-peer-expensive'),
      mux,
      sellerMinBudget,
    );

    // Buyer should refuse (empty sessionId, no SpendingAuth sent)
    expect(sessionId).toBe('');
    expect(mux.sentSpendingAuths.length).toBe(0);
  });

  it('buyer accepts when seller minBudgetPerRequest equals buyer maxPerRequestUsdc', async () => {
    const buyerIdentity = createTestIdentity();
    const { BuyerPaymentManager } = await import('../src/payments/buyer-payment-manager.js');


    const buyerConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      channelsContractAddress: CONTRACT_ADDR,
          usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: CHAIN_ID,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 100_000n,     // buyer allows exactly $0.10
      maxReserveAmountUsdc: 10_000_000n,
      dataDir: tempDir,
    };

    const buyer = new BuyerPaymentManager(buyerIdentity, buyerConfig, store);
    buyer.setSigner(buyerIdentity.wallet);

    const mux = {
      sentSpendingAuths: [] as unknown[],
      sendSpendingAuth(payload: unknown) { mux.sentSpendingAuths.push(payload); },
      sendAuthAck() {},
      sendPaymentRequired() {},
      sendNeedAuth() {},
      onSpendingAuth() {},
      onAuthAck() {},
      onPaymentRequired() {},
      onNeedAuth() {},
      handleFrame: vi.fn(),
    } as unknown as import('../src/p2p/payment-mux.js').PaymentMux & { sentSpendingAuths: unknown[] };

    // Seller demands exactly $0.10 per request — matches buyer's limit
    const sellerMinBudget = 100_000n;
    const sessionId = await buyer.authorizeSpending(
      fakePeerId('seller-peer-match'),
      mux,
      sellerMinBudget,
    );

    // Should succeed
    expect(sessionId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mux.sentSpendingAuths.length).toBe(1);
  });

  it('buyer accepts when seller minBudgetPerRequest is below buyer maxPerRequestUsdc', async () => {
    const buyerIdentity = createTestIdentity();
    const { BuyerPaymentManager } = await import('../src/payments/buyer-payment-manager.js');


    const buyerConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      channelsContractAddress: CONTRACT_ADDR,
          usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: CHAIN_ID,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 100_000n,     // buyer allows $0.10
      maxReserveAmountUsdc: 10_000_000n,
      dataDir: tempDir,
    };

    const buyer = new BuyerPaymentManager(buyerIdentity, buyerConfig, store);
    buyer.setSigner(buyerIdentity.wallet);

    const mux = {
      sentSpendingAuths: [] as unknown[],
      sendSpendingAuth(payload: unknown) { mux.sentSpendingAuths.push(payload); },
      sendAuthAck() {},
      sendPaymentRequired() {},
      sendNeedAuth() {},
      onSpendingAuth() {},
      onAuthAck() {},
      onPaymentRequired() {},
      onNeedAuth() {},
      handleFrame: vi.fn(),
    } as unknown as import('../src/p2p/payment-mux.js').PaymentMux & { sentSpendingAuths: unknown[] };

    // Seller demands only $0.01 per request — well within buyer's limit
    const sellerMinBudget = 10_000n;
    const sessionId = await buyer.authorizeSpending(
      fakePeerId('seller-peer-cheap'),
      mux,
      sellerMinBudget,
    );

    expect(sessionId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mux.sentSpendingAuths.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Codec: PaymentRequired with optional pricing fields
// ═══════════════════════════════════════════════════════════════

describe('PaymentRequired codec with pricing', () => {
  it('round-trips with per-direction pricing', () => {
    const payload: PaymentRequiredPayload = {
      ...SAMPLE_PAYMENT_REQUIRED,
      inputUsdPerMillion: 3.0,
      outputUsdPerMillion: 15.0,
    };
    const decoded = codec.decodePaymentRequired(codec.encodePaymentRequired(payload));
    expect(decoded.inputUsdPerMillion).toBe(3.0);
    expect(decoded.outputUsdPerMillion).toBe(15.0);
  });

  it('round-trips without pricing (fields absent)', () => {
    const decoded = codec.decodePaymentRequired(codec.encodePaymentRequired(SAMPLE_PAYMENT_REQUIRED));
    expect(decoded.inputUsdPerMillion).toBeUndefined();
    expect(decoded.outputUsdPerMillion).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Buyer: insufficient deposit handling
// ═══════════════════════════════════════════════════════════════

describe('Buyer insufficient deposit handling', () => {
  let tempDir: string;
  let store: ChannelStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buyer-insufficient-deposits-'));
    store = new ChannelStore(tempDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeBuyerPaymentManager(): { buyer: BuyerPaymentManager; buyerIdentity: Identity } {
    const buyerIdentity = createTestIdentity();
    const buyer = new BuyerPaymentManager(buyerIdentity, {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      channelsContractAddress: CONTRACT_ADDR,
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: CHAIN_ID,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 500_000n,
      maxReserveAmountUsdc: 1_000_000n,
      dataDir: tempDir,
    }, store);
    return { buyer, buyerIdentity };
  }

  function makeMux(): import('../src/p2p/payment-mux.js').PaymentMux & { sentSpendingAuths: unknown[] } {
    const mux = {
      sentSpendingAuths: [] as unknown[],
      sendSpendingAuth(payload: unknown) { mux.sentSpendingAuths.push(payload); },
      sendAuthAck() {},
      sendPaymentRequired() {},
      sendNeedAuth() {},
      onSpendingAuth() {},
      onAuthAck() {},
      onPaymentRequired() {},
      onNeedAuth() {},
      handleFrame: vi.fn(),
    };
    return mux as unknown as import('../src/p2p/payment-mux.js').PaymentMux & { sentSpendingAuths: unknown[] };
  }

  it('returns payment_required before reserve when available deposit is below reserve amount', async () => {
    const { buyer, buyerIdentity } = makeBuyerPaymentManager();
    const depositsClient = {
      getBuyerBalance: vi.fn().mockResolvedValue({ available: 500_000n, reserved: 0n, lastActivityAt: 0n }),
    };
    const negotiator = new BuyerPaymentNegotiator(
      buyerIdentity,
      buyer,
      depositsClient as never,
      null,
      store,
      {},
      { emit: vi.fn() },
    );

    const conn = mockConnection();
    const peer = {
      peerId: toPeerId('a'.repeat(40)),
      lastSeen: Date.now(),
      providers: ['openai'],
      defaultInputUsdPerMillion: 3,
      defaultOutputUsdPerMillion: 15,
    };
    const req: SerializedHttpRequest = {
      requestId: 'req-short-balance',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      body: new Uint8Array(0),
    };
    const response: SerializedHttpResponse = {
      requestId: req.requestId,
      statusCode: 402,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        error: 'payment_required',
        minBudgetPerRequest: '10000',
        suggestedAmount: '1000000',
      })),
    };

    const result = await negotiator.handle402(response, peer, conn, req);

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      const body = JSON.parse(new TextDecoder().decode(result.response.body)) as Record<string, unknown>;
      expect(body.code).toBe('insufficient_deposits');
    }
    expect(depositsClient.getBuyerBalance).toHaveBeenCalledOnce();
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('does not send a top-up ReserveAuth when available deposit cannot cover the added reserve', async () => {
    const { buyer } = makeBuyerPaymentManager();
    const mux = makeMux();
    const sellerPeerId = fakePeerId('seller-top-up-short');

    await buyer.authorizeSpending(sellerPeerId, mux, 10_000n, 1_000_000n);
    vi.spyOn(buyer.depositsClient, 'getBuyerBalance').mockResolvedValue({
      available: 500_000n,
      reserved: 1_000_000n,
      lastActivityAt: 0n,
    });

    await expect(buyer.topUpReserve(sellerPeerId, mux)).rejects.toThrow('Insufficient buyer deposits');
    expect(mux.sentSpendingAuths).toHaveLength(1);
  });
});
