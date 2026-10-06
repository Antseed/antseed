import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { ChannelStore, CHANNEL_STATUS } from '../src/payments/channel-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import type { CloseChannelRequestPayload, SpendingAuthPayload } from '../src/types/protocol.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import {
  signSpendingAuth,
  signReserveAuth,
  makeChannelsDomain,
  computeMetadataHash,
  encodeMetadata,
  ZERO_METADATA_HASH,
} from '../src/payments/evm/signatures.js';
import type { SpendingAuthMessage, ReserveAuthMessage, SpendingAuthMetadata } from '../src/payments/evm/signatures.js';

const CHAIN_ID = 31337;
const CONTRACT_ADDR = '0x' + 'dd'.repeat(20);
const CHANNEL_ID = '0x' + 'ab'.repeat(32);

function createTestIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  return { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), privateKey, wallet };
}

function createMockPaymentMux(): PaymentMux & { sentNeedAuths: unknown[] } {
  const mux = {
    sentNeedAuths: [] as unknown[],
    sendSpendingAuth() {},
    sendAuthAck() {},
    sendPaymentRequired() {},
    sendNeedAuth(payload: unknown) { mux.sentNeedAuths.push(payload); },
    sendCloseChannelResult() {},
    onSpendingAuth() {},
    onAuthAck() {},
    onPaymentRequired() {},
    onNeedAuth() {},
    onCloseChannelRequest() {},
    onCloseChannelResult() {},
    handleFrame: vi.fn(),
  };
  return mux as unknown as PaymentMux & { sentNeedAuths: unknown[] };
}

function metadataFor(inputTokens: bigint): SpendingAuthMetadata {
  return {
    cumulativeInputTokens: inputTokens,
    cumulativeOutputTokens: 0n,
    cumulativeRequestCount: 0n,
  };
}

/** Buyer's opening ReserveAuth — establishes the channel on the seller. */
async function buildReserveAuth(buyer: Identity, reserveMaxAmount = 10_000_000n): Promise<SpendingAuthPayload> {
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const meta = metadataFor(0n);
  const domain = makeChannelsDomain(CHAIN_ID, CONTRACT_ADDR);
  const reserveMsg: ReserveAuthMessage = {
    channelId: CHANNEL_ID,
    maxAmount: reserveMaxAmount,
    deadline: BigInt(deadline),
  };
  return {
    channelId: CHANNEL_ID,
    cumulativeAmount: '0',
    metadataHash: computeMetadataHash(meta),
    metadata: encodeMetadata(meta),
    spendingAuthSig: await signReserveAuth(buyer.wallet, domain, reserveMsg),
    reserveSalt: '0x' + '01'.repeat(32),
    reserveMaxAmount: reserveMaxAmount.toString(),
    reserveDeadline: deadline,
  };
}

async function buildSpendingAuth(buyer: Identity, cumulativeAmount: bigint): Promise<SpendingAuthPayload> {
  const meta = metadataFor(cumulativeAmount);
  const metadataHash = computeMetadataHash(meta);
  const msg: SpendingAuthMessage = { channelId: CHANNEL_ID, cumulativeAmount, metadataHash };
  return {
    channelId: CHANNEL_ID,
    cumulativeAmount: cumulativeAmount.toString(),
    metadataHash,
    metadata: encodeMetadata(meta),
    spendingAuthSig: await signSpendingAuth(buyer.wallet, makeChannelsDomain(CHAIN_ID, CONTRACT_ADDR), msg),
  };
}

/** A CloseChannelRequest carrying a valid buyer SpendingAuth at `cumulativeAmount`. */
async function buildCloseRequest(
  buyer: Identity,
  cumulativeAmount: bigint,
): Promise<CloseChannelRequestPayload> {
  const auth = await buildSpendingAuth(buyer, cumulativeAmount);
  return {
    version: 1,
    channelId: CHANNEL_ID,
    cumulativeAmount: auth.cumulativeAmount,
    metadataHash: auth.metadataHash,
    metadata: auth.metadata,
    spendingAuthSig: auth.spendingAuthSig,
  };
}

function onChainChannel(buyer: Identity, seller: Identity, settled: bigint) {
  return {
    buyer: buyer.wallet.address,
    seller: seller.wallet.address,
    deposit: 10_000_000n,
    settled,
    metadataHash: ZERO_METADATA_HASH,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    settledAt: 0n,
    closeRequestedAt: 0n,
    status: 1,
  };
}

describe('SellerPaymentManager.handleCloseChannelRequest', () => {
  let tempDir: string;
  let store: ChannelStore;
  let seller: Identity;
  let buyer: Identity;
  let manager: SellerPaymentManager;
  let mux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'seller-coop-close-'));
    store = new ChannelStore(tempDir);
    seller = createTestIdentity();
    buyer = createTestIdentity();

    const config: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      channelsContractAddress: CONTRACT_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
    };
    manager = new SellerPaymentManager(seller, config, store);

    vi.spyOn(manager.channelsClient, 'reserve').mockResolvedValue('0xreserve');
    vi.spyOn(manager.channelsClient, 'settle').mockResolvedValue('0xsettle');
    vi.spyOn(manager.channelsClient, 'close').mockResolvedValue('0xclosetx');
    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(onChainChannel(buyer, seller, 0n));

    mux = createMockPaymentMux();

    // Establish the channel so a close has something to act on.
    await manager.handleSpendingAuth(buyer.peerId, await buildReserveAuth(buyer), mux);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('closes at the seller-held cumulative when the buyer sends no signature', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    manager.recordSpend(CHANNEL_ID, 400_000n);

    const result = await manager.handleCloseChannelRequest(
      buyer.peerId,
      { version: 1, channelId: CHANNEL_ID },
      mux,
    );

    expect(result.status).toBe('closed');
    expect(result.txHash).toBe('0xclosetx');
    expect(result.finalAmount).toBe('400000');
    expect(manager.channelsClient.close).toHaveBeenCalledWith(
      expect.anything(), CHANNEL_ID, 400_000n, expect.any(String), expect.any(String),
    );
    expect(store.getChannel(CHANNEL_ID)!.status).toBe(CHANNEL_STATUS.SETTLED);
    expect(manager.hasSession(buyer.peerId)).toBe(false);
  });

  it('closes at the buyer-supplied cumulative when it exceeds the seller-held one', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    manager.recordSpend(CHANNEL_ID, 400_000n);

    const result = await manager.handleCloseChannelRequest(
      buyer.peerId,
      await buildCloseRequest(buyer, 900_000n),
      mux,
    );

    expect(result.status).toBe('closed');
    expect(result.finalAmount).toBe('900000');
    expect(manager.channelsClient.close).toHaveBeenCalledWith(
      expect.anything(), CHANNEL_ID, 900_000n, expect.any(String), expect.any(String),
    );
  });

  it('keeps the seller-held cumulative when the buyer offers a lower one', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 900_000n), mux);
    manager.recordSpend(CHANNEL_ID, 900_000n);

    const result = await manager.handleCloseChannelRequest(
      buyer.peerId,
      await buildCloseRequest(buyer, 100_000n),
      mux,
    );

    expect(result.status).toBe('closed');
    expect(result.finalAmount).toBe('900000');
  });

  it('refuses while a billable request is still in flight', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    manager.beginBillableRequest(buyer.peerId);

    const result = await manager.handleCloseChannelRequest(
      buyer.peerId,
      { version: 1, channelId: CHANNEL_ID },
      mux,
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('busy');
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(manager.channelsClient.close).not.toHaveBeenCalled();
    expect(manager.hasSession(buyer.peerId)).toBe(true);

    manager.endBillableRequest(buyer.peerId);
    expect(manager.hasInFlightRequests(buyer.peerId)).toBe(false);
  });

  it('yields to a request admitted while the close was still preparing', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    manager.recordSpend(CHANNEL_ID, 400_000n);

    let resolveGetSession!: (value: ReturnType<typeof onChainChannel>) => void;
    vi.spyOn(manager.channelsClient, 'getSession').mockReturnValue(
      new Promise((resolve) => { resolveGetSession = resolve; }) as never,
    );

    const pending = manager.handleCloseChannelRequest(
      buyer.peerId,
      { version: 1, channelId: CHANNEL_ID },
      mux,
    );
    // Admission is still open during the handler's awaits — a request that
    // starts now must make the close step aside, not lose its billing.
    manager.beginBillableRequest(buyer.peerId);
    resolveGetSession(onChainChannel(buyer, seller, 0n));

    const result = await pending;
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('busy');
    expect(manager.channelsClient.close).not.toHaveBeenCalled();
    expect(manager.hasSession(buyer.peerId)).toBe(true);
    manager.endBillableRequest(buyer.peerId);
  });

  it('rejects pending_auth when unsigned spend lands during close preparation', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    manager.recordSpend(CHANNEL_ID, 400_000n);

    // A fast request admitted and fully billed while the handler awaits
    // on-chain state — its spend must not settle below the signed amount.
    vi.spyOn(manager.channelsClient, 'getSession').mockImplementation(async () => {
      manager.recordSpend(CHANNEL_ID, 100_000n);
      return onChainChannel(buyer, seller, 0n);
    });

    const result = await manager.handleCloseChannelRequest(
      buyer.peerId,
      { version: 1, channelId: CHANNEL_ID },
      mux,
    );
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('pending_auth');
    expect(result.requiredCumulativeAmount).toBe('500000');
    expect(manager.channelsClient.close).not.toHaveBeenCalled();
    expect(manager.hasSession(buyer.peerId)).toBe(true);
  });

  it('reports the close transaction in flight via hasClosingChannel', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    manager.recordSpend(CHANNEL_ID, 400_000n);

    let resolveClose!: (txHash: string) => void;
    vi.spyOn(manager.channelsClient, 'close').mockReturnValue(
      new Promise((resolve) => { resolveClose = resolve; }) as never,
    );

    expect(manager.hasClosingChannel(buyer.peerId)).toBe(false);
    const pending = manager.handleCloseChannelRequest(
      buyer.peerId,
      { version: 1, channelId: CHANNEL_ID },
      mux,
    );
    await vi.waitFor(() => expect(manager.hasClosingChannel(buyer.peerId)).toBe(true));

    resolveClose('0xclosetx');
    const result = await pending;
    expect(result.status).toBe('closed');
    expect(manager.hasClosingChannel(buyer.peerId)).toBe(false);
  });

  it('clears the closing state when the close fails, so the channel serves again', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    manager.recordSpend(CHANNEL_ID, 400_000n);
    vi.spyOn(manager.channelsClient, 'close').mockRejectedValue(new Error('tx reverted'));

    const result = await manager.handleCloseChannelRequest(
      buyer.peerId,
      { version: 1, channelId: CHANNEL_ID },
      mux,
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('close_failed');
    expect(manager.hasClosingChannel(buyer.peerId)).toBe(false);
    expect(manager.hasSession(buyer.peerId)).toBe(true);
  });

  it('reports a background close in flight via hasClosingChannel', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);

    let resolveClose!: (txHash: string) => void;
    vi.spyOn(manager.channelsClient, 'close').mockReturnValue(
      new Promise((resolve) => { resolveClose = resolve; }) as never,
    );

    const pending = manager.handleCloseRequested(CHANNEL_ID);
    expect(manager.hasClosingChannel(buyer.peerId)).toBe(true);

    resolveClose('0xclosetx');
    await pending;
    expect(manager.hasClosingChannel(buyer.peerId)).toBe(false);
  });

  it('refuses with pending_auth and a NeedAuth when spend outruns the signed amount', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    manager.recordSpend(CHANNEL_ID, 750_000n);

    const result = await manager.handleCloseChannelRequest(
      buyer.peerId,
      { version: 1, channelId: CHANNEL_ID },
      mux,
      // The catch-up wait resolves immediately: no auth will arrive in a unit test.
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('pending_auth');
    expect(result.requiredCumulativeAmount).toBe('750000');
    expect(manager.channelsClient.close).not.toHaveBeenCalled();

    const needAuth = mux.sentNeedAuths.at(-1) as Record<string, unknown>;
    expect(needAuth.channelId).toBe(CHANNEL_ID);
    expect(needAuth.requiredCumulativeAmount).toBe('750000');
  }, 10_000);

  it('accepts a buyer signature that covers the outstanding spend', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    manager.recordSpend(CHANNEL_ID, 750_000n);

    const result = await manager.handleCloseChannelRequest(
      buyer.peerId,
      await buildCloseRequest(buyer, 750_000n),
      mux,
    );

    expect(result.status).toBe('closed');
    expect(result.finalAmount).toBe('750000');
  });

  it('rejects a signature signed by someone other than the channel buyer', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    const impostor = createTestIdentity();

    const result = await manager.handleCloseChannelRequest(
      buyer.peerId,
      await buildCloseRequest(impostor, 900_000n),
      mux,
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('invalid_auth');
    expect(manager.channelsClient.close).not.toHaveBeenCalled();
  });

  it('rejects a signature whose metadata does not match its hash', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    const request = await buildCloseRequest(buyer, 900_000n);
    request.metadata = encodeMetadata(metadataFor(12345n));

    const result = await manager.handleCloseChannelRequest(buyer.peerId, request, mux);

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('invalid_auth');
  });

  it('rejects a request naming a different channel', async () => {
    const result = await manager.handleCloseChannelRequest(
      buyer.peerId,
      { version: 1, channelId: '0x' + 'ee'.repeat(32) },
      mux,
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('no_channel');
  });

  it('rejects when the buyer has no active channel', async () => {
    const stranger = createTestIdentity();
    const result = await manager.handleCloseChannelRequest(
      stranger.peerId,
      { version: 1, channelId: CHANNEL_ID },
      mux,
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('no_channel');
  });

  it('closes unsigned at the on-chain settled amount when no auth exists on either side', async () => {
    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(onChainChannel(buyer, seller, 250_000n));

    const result = await manager.handleCloseChannelRequest(
      buyer.peerId,
      { version: 1, channelId: CHANNEL_ID },
      mux,
    );

    expect(result.status).toBe('closed');
    expect(result.finalAmount).toBe('250000');
    // finalAmount == settled makes the contract skip signature verification.
    expect(manager.channelsClient.close).toHaveBeenCalledWith(
      expect.anything(), CHANNEL_ID, 250_000n, '0x', '0x',
    );
  });

  it('reports close_failed and keeps the channel when the on-chain call reverts', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    vi.spyOn(manager.channelsClient, 'close').mockRejectedValue(new Error('execution reverted: InvalidAmount'));

    const result = await manager.handleCloseChannelRequest(
      buyer.peerId,
      { version: 1, channelId: CHANNEL_ID },
      mux,
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('close_failed');
    expect(result.reason).toContain('InvalidAmount');
    expect(store.getChannel(CHANNEL_ID)!.status).toBe(CHANNEL_STATUS.ACTIVE);
    expect(manager.hasSession(buyer.peerId)).toBe(true);
  });

  it('persists an adopted buyer auth so a later close can still use it', async () => {
    await manager.handleSpendingAuth(buyer.peerId, await buildSpendingAuth(buyer, 400_000n), mux);
    manager.recordSpend(CHANNEL_ID, 400_000n);
    vi.spyOn(manager.channelsClient, 'close').mockRejectedValueOnce(new Error('boom'));

    const failed = await manager.handleCloseChannelRequest(
      buyer.peerId,
      await buildCloseRequest(buyer, 900_000n),
      mux,
    );
    expect(failed.status).toBe('rejected');

    expect(store.getChannel(CHANNEL_ID)!.authMax).toBe('900000');
    expect(manager.getAcceptedCumulative(CHANNEL_ID)).toBe(900_000n);

    const retried = await manager.handleCloseChannelRequest(
      buyer.peerId,
      { version: 1, channelId: CHANNEL_ID },
      mux,
    );
    expect(retried.status).toBe('closed');
    expect(retried.finalAmount).toBe('900000');
  });
});
