import { describe, expect, it, vi } from 'vitest';
import { Wallet } from 'ethers';
import { toPeerId } from '@antseed/protocol';
import type { SpendingAuthPayload } from '@antseed/protocol/messages';
import type { PaymentMux } from './payment-mux.js';
import { BuyerPaymentManager } from './buyer-payment-manager.js';
import { CHANNEL_ROLE, CHANNEL_STATUS, type BuyerChannelStore, type StoredChannel } from './channel-store-types.js';

const PEER = 'c3cf17082a164c4cf3504d50962668649d327662';
const BUYER = '0x5EF698bF25d8A81ceeDB27caFE989fBBE9735558';
const SELLER = '0xc3cf17082a164C4cf3504D50962668649D327662';
/** The channel the late result is about. */
const OLD_CHANNEL = '0x0dedefdf2055ecce3ea0a08ea594730cd7003944179d3975a554436a7b9d8e02';
/** The channel that opened for the same peer while that result was in flight. */
const NEW_CHANNEL = '0x9d2fd96187a2b4820c02b79e5e90874a3f3f54d661b895a1ab4e9c1f2b22d74e';

function storedChannel(sessionId: string): StoredChannel {
  return {
    sessionId,
    peerId: PEER,
    role: CHANNEL_ROLE.BUYER,
    sellerEvmAddr: SELLER,
    buyerEvmAddr: BUYER,
    nonce: 0,
    authMax: '1000000',
    deadline: 0,
    previousSessionId: `0x${'0'.repeat(64)}`,
    previousConsumption: '0',
    tokensDelivered: '0',
    requestCount: 0,
    reservedAt: 0,
    settledAt: null,
    settledAmount: null,
    status: CHANNEL_STATUS.ACTIVE,
    latestBuyerSig: null,
    latestSpendingAuthSig: null,
    latestMetadata: null,
  };
}

/** A manager with only the parts `retireSession` touches. */
function makeManager(activeChannelId: string | null) {
  const updateChannelStatus = vi.fn();
  const channelStore = {
    getActiveChannelByPeerAndBuyer: vi.fn(() => (activeChannelId ? storedChannel(activeChannelId) : null)),
    updateChannelStatus,
  };
  const manager = Object.create(BuyerPaymentManager.prototype) as BuyerPaymentManager;
  Object.assign(manager as object, {
    _channelStore: channelStore,
    _identity: { wallet: { address: BUYER } },
    _cumulativeAmount: new Map<string, bigint>(),
    _sellerAccepted: new Map(),
    _requestLedgers: new Map(),
    _metadata: new Map(),
    _verifiedCost: new Map(),
    _sessionPricing: new Map(),
    _currentReserveCeiling: new Map(),
    _initialReserveAmount: new Map(),
    _reserveSalt: new Map(),
    _pendingReserveAuth: new Map(),
    _confirmedPeers: new Set<string>(),
    _rejectedPeers: new Set<string>(),
    _responseTokenTotals: new Map(),
    _clearRequestBillingForSeller: vi.fn(),
  });
  return { manager, updateChannelStatus };
}

describe('BuyerPaymentManager.retireSession', () => {
  it('does not retire a newer channel when the result is for an older one', () => {
    const { manager, updateChannelStatus } = makeManager(NEW_CHANNEL);
    manager._cumulativeAmount.set(PEER, 0n);

    // A late result for OLD_CHANNEL: the chain said OLD settled at 3767.
    manager.retireSession(PEER, CHANNEL_STATUS.SETTLED, 3767n, OLD_CHANNEL);

    expect(updateChannelStatus).not.toHaveBeenCalled();
    // The newer channel keeps its in-memory state as well.
    expect(manager._cumulativeAmount.get(PEER)).toBe(0n);
  });

  it('retires the channel the result is about', () => {
    const { manager, updateChannelStatus } = makeManager(NEW_CHANNEL);

    manager.retireSession(PEER, CHANNEL_STATUS.SETTLED, 0n, NEW_CHANNEL);

    expect(updateChannelStatus).toHaveBeenCalledTimes(1);
    expect(updateChannelStatus).toHaveBeenCalledWith(NEW_CHANNEL, CHANNEL_STATUS.SETTLED, '0');
  });

  it('matches the expected channel id case-insensitively', () => {
    const { manager, updateChannelStatus } = makeManager(NEW_CHANNEL);

    manager.retireSession(PEER, CHANNEL_STATUS.SETTLED, 0n, NEW_CHANNEL.toUpperCase());

    expect(updateChannelStatus).toHaveBeenCalledTimes(1);
    expect(updateChannelStatus).toHaveBeenCalledWith(NEW_CHANNEL, CHANNEL_STATUS.SETTLED, '0');
  });

  it('still retires the active channel when no channel is expected', () => {
    const { manager, updateChannelStatus } = makeManager(NEW_CHANNEL);

    manager.retireSession(PEER, CHANNEL_STATUS.GHOST);

    expect(updateChannelStatus).toHaveBeenCalledTimes(1);
    expect(updateChannelStatus).toHaveBeenCalledWith(NEW_CHANNEL, CHANNEL_STATUS.GHOST, undefined);
  });

  it('writes nothing when there is no active channel', () => {
    const { manager, updateChannelStatus } = makeManager(null);

    manager.retireSession(PEER, CHANNEL_STATUS.GHOST, undefined, OLD_CHANNEL);

    expect(updateChannelStatus).not.toHaveBeenCalled();
  });
});

const CATCH_UP_SELLER = toPeerId('5e'.repeat(20));
const MAX_PER_REQUEST = 1_000_000n;

function memoryChannelStore(): BuyerChannelStore {
  const channels = new Map<string, StoredChannel>();
  return {
    upsertChannel: (channel: StoredChannel) => { channels.set(channel.sessionId, channel); },
    getChannel: (id: string) => channels.get(id) ?? null,
    getActiveChannelByPeerAndBuyer: (peerId: string, role: string, buyer: string) =>
      [...channels.values()].find((c) =>
        c.peerId === peerId && c.role === role && c.buyerEvmAddr === buyer && c.status === CHANNEL_STATUS.ACTIVE) ?? null,
    getActiveChannelsByBuyer: () => [],
    replaceMetadataServiceTotals: () => {},
  } as unknown as BuyerChannelStore;
}

async function sessionSignedUpTo(cumulative: bigint) {
  const wallet = Wallet.createRandom();
  const manager = new BuyerPaymentManager(
    { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), wallet },
    {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: `0x${'dd'.repeat(20)}`,
      channelsContractAddress: `0x${'cc'.repeat(20)}`,
      usdcAddress: `0x${'ee'.repeat(20)}`,
      identityRegistryAddress: `0x${'ff'.repeat(20)}`,
      chainId: 31337,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: MAX_PER_REQUEST,
      maxReserveAmountUsdc: 10_000_000n,
      dataDir: '/nonexistent',
    },
    memoryChannelStore(),
  );
  const sent: SpendingAuthPayload[] = [];
  const mux = {
    sendSpendingAuth: (payload: SpendingAuthPayload) => { sent.push(payload); },
    sendReserveAuth: () => {},
  } as unknown as PaymentMux;

  const channelId = await manager.authorizeSpending(CATCH_UP_SELLER, mux, 10_000n);
  await manager.handleAuthAck(CATCH_UP_SELLER, { channelId });
  // The buyer pays a cost claim only for a response it recorded.
  manager.recordDeliveredResponse(CATCH_UP_SELLER, 'paid-request', { costUsdc: cumulative });
  await manager.handleNeedAuth(CATCH_UP_SELLER, {
    channelId,
    requiredCumulativeAmount: cumulative.toString(),
    currentAcceptedCumulative: '0',
    deposit: '10000000',
    requestId: 'paid-request',
    lastRequestCost: cumulative.toString(),
  }, mux);
  expect(manager.getCumulativeAmount(CATCH_UP_SELLER)).toBe(cumulative);
  sent.length = 0;
  return { manager, mux, sent };
}

describe('BuyerPaymentManager 402 catch-up', () => {
  it('signs exactly the seller-required cumulative, without adding minBudgetPerRequest on top', async () => {
    const { manager, mux, sent } = await sessionSignedUpTo(1_000n);

    await manager.extendCurrentSpendingAuth(CATCH_UP_SELLER, 500_000n, mux, 4_000n);

    expect(sent.map((auth) => auth.cumulativeAmount)).toEqual(['4000']);
    expect(manager.getCumulativeAmount(CATCH_UP_SELLER)).toBe(4_000n);
  });

  it('caps the seller-required cumulative at verified spend plus maxPerRequestUsdc', async () => {
    const { manager, mux, sent } = await sessionSignedUpTo(1_000n);

    await manager.extendCurrentSpendingAuth(CATCH_UP_SELLER, 500_000n, mux, 5_000_000n);

    expect(sent.map((auth) => auth.cumulativeAmount)).toEqual([(1_000n + MAX_PER_REQUEST).toString()]);
  });

  it('advances by minBudgetPerRequest when the seller gives no target', async () => {
    const { manager, mux, sent } = await sessionSignedUpTo(1_000n);

    await manager.extendCurrentSpendingAuth(CATCH_UP_SELLER, 500_000n, mux);

    expect(sent.map((auth) => auth.cumulativeAmount)).toEqual(['501000']);
  });
});
