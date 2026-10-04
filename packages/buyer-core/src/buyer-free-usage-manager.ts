import { hexlify, randomBytes } from 'ethers';
import type { BuyerIdentity } from './interfaces.js';
import type { PaymentMux } from './payment-mux.js';
import type { BuyerPeerView } from './interfaces.js';
import type { FreeUsageAckPayload, NeedFreeUsageAuthPayload } from '@antseed/protocol/messages';
import type { SellerAddressResolver } from './seller-address-resolver.js';
import { peerIdToAddress } from '@antseed/protocol/peer-id';
import { debugLog, debugWarn } from './debug.js';
import {
  computeFreeUsageChannelId,
  computeFreeUsageMetadataHash,
  encodeFreeUsageMetadata,
  makeFreeUsageDomain,
  signFreeUsageAuth,
  signFreeUsageOpen,
  type FreeUsageMetadata,
  type UsageAttribution,
} from '@antseed/protocol/signatures';
import { CHANNEL_KIND, CHANNEL_ROLE, CHANNEL_STATUS, type BuyerChannelStore } from './channel-store-types.js';
import { advanceUsageMetadata, RequestServiceTracker } from './channel-usage-accounting.js';

export interface BuyerFreeUsageConfig {
  chainId: number;
  freeUsageContractAddress: string;
  defaultAuthDurationSecs: number;
  openAckTimeoutMs?: number;
  /** Disable per-service attribution in free-usage metadata. Default: false. */
  disableMetadataV2Services?: boolean;
  /** Referrer / client attribution appended to every signed metadata blob. */
  attribution?: UsageAttribution;
}

interface FreeUsageSession {
  channelId: string;
  salt: string;
  deadline: number;
  sellerEvmAddr: string;
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  latestSequence: bigint;
  services: FreeUsageMetadata['services'];
  openedAck: boolean;
  latestMetadata: FreeUsageMetadata;
  openSig: string | null;
}

interface OpenAckWaiter {
  session: FreeUsageSession;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_OPEN_ACK_TIMEOUT_MS = 30_000;

export class BuyerFreeUsageManager {
  private readonly _identity: BuyerIdentity;
  private readonly _config: BuyerFreeUsageConfig;
  private _attribution: UsageAttribution | undefined;
  private readonly _sellerAddressResolver?: SellerAddressResolver;
  private readonly _channelStore?: BuyerChannelStore;
  private readonly _domain: ReturnType<typeof makeFreeUsageDomain>;
  private readonly _sessions = new Map<string, FreeUsageSession>();
  private readonly _sellerLocks = new Map<string, Promise<void>>();
  private readonly _openAckWaiters = new Map<string, Set<OpenAckWaiter>>();
  private readonly _requestService = new RequestServiceTracker();

  constructor(
    identity: BuyerIdentity,
    config: BuyerFreeUsageConfig,
    sellerAddressResolver?: SellerAddressResolver,
    channelStore?: BuyerChannelStore,
  ) {
    this._identity = identity;
    this._config = config;
    this._attribution = config.attribution;
    this._sellerAddressResolver = sellerAddressResolver;
    this._channelStore = channelStore;
    this._domain = makeFreeUsageDomain(config.chainId, config.freeUsageContractAddress);
    this._hydrateFromStore();
  }

  private get _disableMetadataV2Services(): boolean {
    return this._config.disableMetadataV2Services === true;
  }

  /** Replace the client / invite attribution appended to future signed metadata. */
  setAttribution(attribution: UsageAttribution | undefined): void {
    this._attribution = attribution;
  }

  private _sanitizeMetadata(metadata: FreeUsageMetadata): FreeUsageMetadata {
    const base: FreeUsageMetadata = this._disableMetadataV2Services
      ? {
          cumulativeInputTokens: metadata.cumulativeInputTokens,
          cumulativeOutputTokens: metadata.cumulativeOutputTokens,
          cumulativeRequestCount: metadata.cumulativeRequestCount,
          services: [],
        }
      : metadata;
    return this._attribution ? { ...base, attribution: this._attribution } : base;
  }

  private _advanceUsageMetadata(
    previous: FreeUsageMetadata,
    service: string | undefined,
    delta: Parameters<typeof advanceUsageMetadata>[2],
  ): FreeUsageMetadata {
    return advanceUsageMetadata(
      this._sanitizeMetadata(previous),
      this._disableMetadataV2Services ? undefined : service,
      delta,
    );
  }

  private _hydrateFromStore(): void {
    if (!this._channelStore) return;
    const activeChannels = this._channelStore.getActiveChannelsByBuyer(CHANNEL_ROLE.BUYER, this._identity.wallet.address, CHANNEL_KIND.FREE);
    for (const channel of activeChannels) {
      if (this._sessions.has(channel.peerId)) continue;
      const metadata = this._sanitizeMetadata(this._channelStore.getChannelMetadata(channel));
      if (!this._disableMetadataV2Services) {
        this._channelStore.replaceMetadataServiceTotals(channel.sessionId, metadata.services);
      }
      this._sessions.set(channel.peerId, {
        channelId: channel.sessionId,
        // Salt is only needed to create a fresh open signature; hydrated
        // sessions are already opened and only sign usage auths.
        salt: '0x' + '00'.repeat(32),
        deadline: channel.deadline,
        sellerEvmAddr: channel.sellerEvmAddr,
        cumulativeInputTokens: metadata.cumulativeInputTokens,
        cumulativeOutputTokens: metadata.cumulativeOutputTokens,
        cumulativeRequestCount: metadata.cumulativeRequestCount,
        latestSequence: BigInt(channel.requestCount),
        services: metadata.services,
        openedAck: true,
        latestMetadata: metadata,
        openSig: channel.latestBuyerSig,
      });
    }
  }

  trackRequestService(requestId: string, service: string): void {
    this._requestService.track(requestId, service);
  }

  async prepareOpen(peer: BuyerPeerView, paymentMux: PaymentMux): Promise<void> {
    const existing = this._sessions.get(peer.peerId);
    const nowSec = Math.floor(Date.now() / 1000);
    if (existing && existing.deadline > nowSec + 30) return;

    const sellerEvmAddr = await this._resolveSellerAddr(peer);
    const salt = hexlify(randomBytes(32));
    const channelId = computeFreeUsageChannelId(this._identity.wallet.address, sellerEvmAddr, salt);
    const deadline = nowSec + this._config.defaultAuthDurationSecs;
    const openSig = await signFreeUsageOpen(this._identity.wallet, this._domain, {
      channelId,
      deadline: BigInt(deadline),
    });
    const metadata: FreeUsageMetadata = {
      cumulativeInputTokens: 0n,
      cumulativeOutputTokens: 0n,
      cumulativeRequestCount: 0n,
      services: [],
    };

    const session: FreeUsageSession = {
      channelId,
      salt,
      deadline,
      sellerEvmAddr,
      cumulativeInputTokens: 0n,
      cumulativeOutputTokens: 0n,
      cumulativeRequestCount: 0n,
      latestSequence: 0n,
      services: [],
      openedAck: false,
      latestMetadata: metadata,
      openSig,
    };
    this._sessions.set(peer.peerId, session);
    try {
      paymentMux.sendFreeUsageOpen({ channelId, salt, deadline, openSig });
    } catch (err) {
      if (existing) {
        this._sessions.set(peer.peerId, existing);
      } else {
        this._sessions.delete(peer.peerId);
      }
      throw err;
    }
    debugLog(`[BuyerFreeUsage] Open sent to ${peer.peerId.slice(0, 12)}... channel=${channelId.slice(0, 18)}...`);
  }

  async waitForOpenAck(sellerPeerId: string, timeoutMs = this._config.openAckTimeoutMs ?? DEFAULT_OPEN_ACK_TIMEOUT_MS): Promise<void> {
    const session = this._sessions.get(sellerPeerId);
    if (!session) {
      throw new Error(`free usage channel for ${sellerPeerId.slice(0, 12)}... was not prepared`);
    }
    if (session.openedAck) return;

    await new Promise<void>((resolve, reject) => {
      const waiter: OpenAckWaiter = {
        session,
        resolve,
        reject,
        timer: setTimeout(() => {
          this._removeOpenAckWaiter(sellerPeerId, waiter);
          if (this._sessions.get(sellerPeerId) === session && !session.openedAck) {
            this._sessions.delete(sellerPeerId);
            this._channelStore?.updateChannelStatus(session.channelId, CHANNEL_STATUS.TIMEOUT);
          }
          reject(new Error(`timed out waiting for free usage open ack from ${sellerPeerId.slice(0, 12)}...`));
        }, timeoutMs),
      };
      let waiters = this._openAckWaiters.get(sellerPeerId);
      if (!waiters) {
        waiters = new Set();
        this._openAckWaiters.set(sellerPeerId, waiters);
      }
      waiters.add(waiter);
    });
  }

  handleAck(sellerPeerId: string, payload: FreeUsageAckPayload): void {
    const session = this._sessions.get(sellerPeerId);
    if (!session || session.channelId !== payload.channelId) return;
    session.openedAck = true;
    this._persistSession(sellerPeerId, session, session.openSig, null, null);
    this._retireOtherActiveSessions(sellerPeerId, session.channelId);
    this._resolveOpenAckWaiters(sellerPeerId, session);
    debugLog(
      `[BuyerFreeUsage] Ack from ${sellerPeerId.slice(0, 12)}... channel=${payload.channelId.slice(0, 18)}...` +
      `${payload.acceptedSequence ? ` sequence=${payload.acceptedSequence}` : ''}`,
    );
  }

  onPeerDisconnect(sellerPeerId: string): void {
    this._sessions.delete(sellerPeerId);
    this._sellerLocks.delete(sellerPeerId);
    this._rejectOpenAckWaiters(sellerPeerId, new Error(`peer ${sellerPeerId.slice(0, 12)}... disconnected before free usage open ack`));
  }

  async handleNeedAuth(
    sellerPeerId: string,
    payload: NeedFreeUsageAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const lock = (this._sellerLocks.get(sellerPeerId) ?? Promise.resolve()).then(async () => {
      await this._handleNeedAuthInner(sellerPeerId, payload, paymentMux);
    });
    this._sellerLocks.set(sellerPeerId, lock.catch(() => {}));
    return lock;
  }

  private async _handleNeedAuthInner(
    sellerPeerId: string,
    payload: NeedFreeUsageAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this._sessions.get(sellerPeerId);
    if (!session || session.channelId !== payload.channelId) {
      debugWarn(`[BuyerFreeUsage] NeedFreeUsageAuth for unknown channel ${payload.channelId.slice(0, 18)}...`);
      return;
    }

    const requiredSequence = BigInt(payload.requiredSequence);
    if (requiredSequence <= session.latestSequence) {
      return;
    }

    const inputTokens = BigInt(payload.inputTokens ?? '0');
    const outputTokens = BigInt(payload.outputTokens ?? '0');
    const attributedService = this._requestService.get(payload.requestId) ?? payload.service;

    const metadata = this._advanceUsageMetadata(session.latestMetadata, attributedService, {
      amount: 0n,
      inputTokens,
      cachedInputTokens: 0n,
      outputTokens,
      requests: 1n,
      outputImages: 0n,
    });
    const metadataHash = computeFreeUsageMetadataHash(metadata);
    const encodedMetadata = encodeFreeUsageMetadata(metadata);
    const usageSig = await signFreeUsageAuth(this._identity.wallet, this._domain, {
      channelId: session.channelId,
      sequence: requiredSequence,
      metadataHash,
      deadline: BigInt(session.deadline),
    });

    paymentMux.sendFreeUsageAuth({
      channelId: session.channelId,
      cumulativeInputTokens: metadata.cumulativeInputTokens.toString(),
      cumulativeOutputTokens: metadata.cumulativeOutputTokens.toString(),
      sequence: requiredSequence.toString(),
      metadataHash,
      metadata: encodedMetadata,
      deadline: session.deadline,
      usageSig,
    });

    session.latestSequence = requiredSequence;
    session.cumulativeInputTokens = metadata.cumulativeInputTokens;
    session.cumulativeOutputTokens = metadata.cumulativeOutputTokens;
    session.cumulativeRequestCount = metadata.cumulativeRequestCount;
    session.services = metadata.services;
    session.latestMetadata = metadata;
    this._requestService.take(payload.requestId);
    this._persistSession(sellerPeerId, session, null, usageSig, encodedMetadata);
    debugLog(
      `[BuyerFreeUsage] UsageAuth sent to ${sellerPeerId.slice(0, 12)}... ` +
      `channel=${session.channelId.slice(0, 18)}... sequence=${session.latestSequence}`,
    );
  }

  private async _resolveSellerAddr(peer: BuyerPeerView): Promise<string> {
    if (!this._sellerAddressResolver) return peerIdToAddress(peer.peerId);
    return this._sellerAddressResolver.resolveSellerAddress(peer.peerId, peer.metadata);
  }

  private _resolveOpenAckWaiters(sellerPeerId: string, session: FreeUsageSession): void {
    const waiters = this._openAckWaiters.get(sellerPeerId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (waiter.session !== session) continue;
      this._removeOpenAckWaiter(sellerPeerId, waiter);
      waiter.resolve();
    }
  }

  private _rejectOpenAckWaiters(sellerPeerId: string, err: Error): void {
    const waiters = this._openAckWaiters.get(sellerPeerId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      this._removeOpenAckWaiter(sellerPeerId, waiter);
      waiter.reject(err);
    }
  }

  private _removeOpenAckWaiter(sellerPeerId: string, waiter: OpenAckWaiter): void {
    clearTimeout(waiter.timer);
    const waiters = this._openAckWaiters.get(sellerPeerId);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this._openAckWaiters.delete(sellerPeerId);
  }

  private _retireOtherActiveSessions(sellerPeerId: string, keepSessionId: string): void {
    if (!this._channelStore) return;
    const activeChannels = this._channelStore.getActiveChannelsByBuyer(
      CHANNEL_ROLE.BUYER,
      this._identity.wallet.address,
      CHANNEL_KIND.FREE,
    );
    for (const channel of activeChannels) {
      if (channel.peerId !== sellerPeerId || channel.sessionId === keepSessionId) continue;
      this._channelStore.updateChannelStatus(channel.sessionId, CHANNEL_STATUS.GHOST);
    }
  }

  private _persistSession(
    sellerPeerId: string,
    session: FreeUsageSession,
    openSig: string | null,
    usageSig: string | null,
    encodedMetadata: string | null,
  ): void {
    if (!this._channelStore) return;
    const now = Date.now();
    const existing = this._channelStore.getChannel(session.channelId);
    this._channelStore.upsertChannel({
      sessionId: session.channelId,
      peerId: sellerPeerId,
      role: CHANNEL_ROLE.BUYER,
      channelKind: CHANNEL_KIND.FREE,
      sellerEvmAddr: session.sellerEvmAddr,
      buyerEvmAddr: this._identity.wallet.address,
      nonce: 0,
      authMax: '0',
      deadline: session.deadline,
      previousSessionId: '0x' + '00'.repeat(32),
      previousConsumption: session.cumulativeOutputTokens.toString(),
      tokensDelivered: session.cumulativeInputTokens.toString(),
      requestCount: Number(session.cumulativeRequestCount),
      reservedAt: existing?.reservedAt ?? now,
      settledAt: null,
      settledAmount: null,
      status: CHANNEL_STATUS.ACTIVE,
      latestBuyerSig: openSig ?? existing?.latestBuyerSig ?? null,
      latestSpendingAuthSig: usageSig ?? existing?.latestSpendingAuthSig ?? null,
      latestMetadata: encodedMetadata ?? existing?.latestMetadata ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this._channelStore.replaceMetadataServiceTotals(session.channelId, this._sanitizeMetadata(session.latestMetadata).services);
  }
}
