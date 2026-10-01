import { AbiCoder, keccak256, verifyTypedData } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type {
  FreeUsageAuthPayload,
  FreeUsageOpenPayload,
  NeedFreeUsageAuthPayload,
} from '../types/protocol.js';
import { peerIdToAddress } from '../types/peer.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { FreeUsageClient } from './evm/free-usage-client.js';
import type { SellerFreeTierLimiter } from './seller-free-tier-limiter.js';
import {
  computeFreeUsageChannelId,
  FREE_USAGE_AUTH_TYPES,
  FREE_USAGE_METADATA_VERSION,
  FREE_USAGE_OPEN_TYPES,
  makeFreeUsageDomain,
} from './evm/signatures.js';

export interface SellerFreeUsageConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  freeUsageContractAddress: string;
  chainId: number;
  recordBatchSize?: number;
  recordFlushIntervalMs?: number;
}

interface SellerFreeUsageSession {
  channelId: string;
  buyerEvmAddr: string;
  salt: string;
  deadline: number;
  acceptedSequence: bigint;
  requestedSequence: bigint;
  requestedInputTokens: bigint;
  requestedOutputTokens: bigint;
  requestedRequestCount: bigint;
  expectedUsageBySequence: Map<string, ExpectedFreeUsage>;
  openPromise: Promise<void>;
  pendingRecord: PendingFreeUsageRecord | null;
  recordsSinceFlush: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushPromise: Promise<void> | null;
  closeRequested: boolean;
}

interface ExpectedFreeUsage {
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
}

interface PendingFreeUsageRecord {
  sequence: bigint;
  metadata: string;
  deadline: bigint;
  usageSig: string;
}

const FREE_USAGE_METADATA_ABI = [
  'uint256',
  'uint256',
  'uint256',
  'uint256',
  'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount)[]',
] as const;

const DEFAULT_RECORD_BATCH_SIZE = 16;
const DEFAULT_RECORD_FLUSH_INTERVAL_MS = 15 * 60_000;

function normalizeTokenCount(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.trunc(value));
}

export class SellerFreeUsageManager {
  private readonly _signer;
  private readonly _client: FreeUsageClient;
  private readonly _domain: ReturnType<typeof makeFreeUsageDomain>;
  private readonly _sellerEvmAddr: string;
  private readonly _recordBatchSize: number;
  private readonly _recordFlushIntervalMs: number;
  private readonly _sessions = new Map<string, SellerFreeUsageSession>();
  private readonly _buyerLocks = new Map<string, Promise<void>>();

  constructor(
    identity: Identity,
    config: SellerFreeUsageConfig,
    private readonly _freeTierLimiter: SellerFreeTierLimiter | null = null,
  ) {
    this._signer = identity.wallet;
    this._sellerEvmAddr = identity.wallet.address;
    this._domain = makeFreeUsageDomain(config.chainId, config.freeUsageContractAddress);
    this._recordBatchSize = Math.max(1, Math.trunc(config.recordBatchSize ?? DEFAULT_RECORD_BATCH_SIZE));
    this._recordFlushIntervalMs = Math.max(1, Math.trunc(config.recordFlushIntervalMs ?? DEFAULT_RECORD_FLUSH_INTERVAL_MS));
    this._client = new FreeUsageClient({
      rpcUrl: config.rpcUrl,
      ...(config.fallbackRpcUrls ? { fallbackRpcUrls: config.fallbackRpcUrls } : {}),
      contractAddress: config.freeUsageContractAddress,
      evmChainId: config.chainId,
    });
  }

  get client(): FreeUsageClient {
    return this._client;
  }

  handleOpen(buyerPeerId: string, payload: FreeUsageOpenPayload, paymentMux: PaymentMux, remoteIp: string | null = null): void {
    const lock = (this._buyerLocks.get(buyerPeerId) ?? Promise.resolve()).then(async () => {
      await this._handleOpenInner(buyerPeerId, payload, paymentMux, remoteIp);
    });
    this._buyerLocks.set(buyerPeerId, lock.catch(() => {}));
    void lock.catch((err) => {
      debugWarn(`[SellerFreeUsage] Open failed for ${buyerPeerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
    });
  }

  handleAuth(buyerPeerId: string, payload: FreeUsageAuthPayload, paymentMux: PaymentMux): void {
    const lock = (this._buyerLocks.get(buyerPeerId) ?? Promise.resolve()).then(async () => {
      await this._handleAuthInner(buyerPeerId, payload, paymentMux);
    });
    this._buyerLocks.set(buyerPeerId, lock.catch(() => {}));
    void lock.catch((err) => {
      debugWarn(`[SellerFreeUsage] UsageAuth failed for ${buyerPeerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
    });
  }

  onPeerDisconnect(buyerPeerId: string): void {
    const session = this._sessions.get(buyerPeerId);
    if (session) {
      this._clearFlushTimer(session);
      session.closeRequested = true;
      if (session.pendingRecord || session.flushPromise) {
        void this._flushPendingRecord(buyerPeerId, session).finally(() => {
          if (this._sessions.get(buyerPeerId) === session) {
            this._sessions.delete(buyerPeerId);
          }
        });
      } else {
        this._sessions.delete(buyerPeerId);
      }
    } else {
      this._sessions.delete(buyerPeerId);
    }
    this._buyerLocks.delete(buyerPeerId);
  }

  async flushAllPendingRecords(): Promise<void> {
    await Promise.all(
      [...this._sessions.entries()].map(([buyerPeerId, session]) => {
        this._clearFlushTimer(session);
        return this._flushPendingRecord(buyerPeerId, session);
      }),
    );
  }

  reportUsageRequest(
    buyerPeerId: string,
    paymentMux: PaymentMux,
    usage: { requestId?: string; inputTokens: number; outputTokens: number; service?: string },
  ): void {
    const session = this._sessions.get(buyerPeerId);
    if (!session) {
      debugWarn(`[SellerFreeUsage] Cannot request usage auth for ${buyerPeerId.slice(0, 12)}...: no free usage channel`);
      return;
    }

    const nextSequence = (session.requestedSequence > session.acceptedSequence
      ? session.requestedSequence
      : session.acceptedSequence) + 1n;
    const payload: NeedFreeUsageAuthPayload = {
      channelId: session.channelId,
      requiredSequence: nextSequence.toString(),
      currentAcceptedSequence: session.acceptedSequence.toString(),
      ...(usage.requestId ? { requestId: usage.requestId } : {}),
      inputTokens: normalizeTokenCount(usage.inputTokens).toString(),
      outputTokens: normalizeTokenCount(usage.outputTokens).toString(),
      ...(usage.service ? { service: usage.service } : {}),
    };

    try {
      paymentMux.sendNeedFreeUsageAuth(payload);
      const inputTokens = normalizeTokenCount(usage.inputTokens);
      const outputTokens = normalizeTokenCount(usage.outputTokens);
      session.requestedSequence = nextSequence;
      session.requestedInputTokens += inputTokens;
      session.requestedOutputTokens += outputTokens;
      session.requestedRequestCount += 1n;
      session.expectedUsageBySequence.set(nextSequence.toString(), {
        cumulativeInputTokens: session.requestedInputTokens,
        cumulativeOutputTokens: session.requestedOutputTokens,
        cumulativeRequestCount: session.requestedRequestCount,
      });
      debugLog(
        `[SellerFreeUsage] NeedFreeUsageAuth sent to ${buyerPeerId.slice(0, 12)}... ` +
        `channel=${session.channelId.slice(0, 18)}... sequence=${nextSequence}`,
      );
    } catch (err) {
      debugWarn(`[SellerFreeUsage] NeedFreeUsageAuth send failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async _handleOpenInner(
    buyerPeerId: string,
    payload: FreeUsageOpenPayload,
    paymentMux: PaymentMux,
    remoteIp: string | null,
  ): Promise<void> {
    const buyerEvmAddr = peerIdToAddress(buyerPeerId);
    const expectedChannelId = computeFreeUsageChannelId(buyerEvmAddr, this._sellerEvmAddr, payload.salt);
    if (expectedChannelId.toLowerCase() !== payload.channelId.toLowerCase()) {
      throw new Error(`channelId mismatch expected=${expectedChannelId} got=${payload.channelId}`);
    }
    if (payload.deadline <= Math.floor(Date.now() / 1000)) {
      throw new Error('free usage open expired');
    }

    const recovered = verifyTypedData(
      this._domain,
      FREE_USAGE_OPEN_TYPES,
      { channelId: payload.channelId, deadline: BigInt(payload.deadline) },
      payload.openSig,
    );
    if (recovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
      throw new Error(`invalid FreeUsageOpen signer recovered=${recovered} expected=${buyerEvmAddr}`);
    }

    // Check inside the buyer lock, immediately before spending gas. Opening
    // does not consume quota; the inference handler accounts for requests.
    // Storage errors propagate so admission fails closed without an open/ack.
    const admission = this._freeTierLimiter?.check({ buyerPeerId, remoteIp });
    if (admission && !admission.allowed) {
      throw new Error(
        `free_tier_exhausted: limitedBy=${admission.limitedBy} ` +
        `ip=${admission.remoteIp ?? 'unknown'} retryAfterMs=${admission.retryAfterMs}`,
      );
    }

    const openPromise = this._openOnChain(buyerEvmAddr, payload);
    const session: SellerFreeUsageSession = {
      channelId: payload.channelId,
      buyerEvmAddr,
      salt: payload.salt,
      deadline: payload.deadline,
      acceptedSequence: 0n,
      requestedSequence: 0n,
      requestedInputTokens: 0n,
      requestedOutputTokens: 0n,
      requestedRequestCount: 0n,
      expectedUsageBySequence: new Map(),
      openPromise,
      pendingRecord: null,
      recordsSinceFlush: 0,
      flushTimer: null,
      flushPromise: null,
      closeRequested: false,
    };
    this._sessions.set(buyerPeerId, session);

    try {
      await openPromise;
    } catch (err) {
      if (this._sessions.get(buyerPeerId) === session) {
        this._sessions.delete(buyerPeerId);
      }
      throw err;
    }
    paymentMux.sendFreeUsageAck({ channelId: payload.channelId, acceptedSequence: '0' });
    debugLog(`[SellerFreeUsage] Open reported on-chain channel=${payload.channelId.slice(0, 18)}...`);
  }

  private async _openOnChain(buyerEvmAddr: string, payload: FreeUsageOpenPayload): Promise<void> {
    try {
      await this._client.open(this._signer, buyerEvmAddr, payload.salt, BigInt(payload.deadline), payload.openSig);
    } catch (err) {
      const existing = await this._tryGetExistingSession(payload.channelId);
      if (
        existing
        && existing.status === 1
        && existing.buyer.toLowerCase() === buyerEvmAddr.toLowerCase()
        && existing.seller.toLowerCase() === this._sellerEvmAddr.toLowerCase()
      ) {
        return;
      }
      throw err;
    }
  }

  private async _handleAuthInner(
    buyerPeerId: string,
    payload: FreeUsageAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this._sessions.get(buyerPeerId);
    if (!session || session.channelId.toLowerCase() !== payload.channelId.toLowerCase()) {
      throw new Error(`unknown free usage channel ${payload.channelId}`);
    }

    const sequence = BigInt(payload.sequence);
    if (sequence <= session.acceptedSequence) {
      paymentMux.sendFreeUsageAck({
        channelId: payload.channelId,
        acceptedSequence: session.acceptedSequence.toString(),
      });
      return;
    }

    const metadataHash = keccak256(payload.metadata);
    if (metadataHash.toLowerCase() !== payload.metadataHash.toLowerCase()) {
      throw new Error('metadataHash mismatch');
    }
    const sequenceKey = sequence.toString();
    const expectedUsage = session.expectedUsageBySequence.get(sequenceKey);
    if (!expectedUsage) {
      throw new Error(`unexpected free usage sequence ${sequence}`);
    }
    // The seller enforces aggregate counters it measured; per-service tuples
    // remain buyer-attributed audit metadata.
    const signedUsage = this._decodeFreeUsageMetadata(payload.metadata);
    const payloadInputTokens = BigInt(payload.cumulativeInputTokens);
    const payloadOutputTokens = BigInt(payload.cumulativeOutputTokens);
    if (
      payloadInputTokens !== signedUsage.cumulativeInputTokens
      || payloadOutputTokens !== signedUsage.cumulativeOutputTokens
      || signedUsage.cumulativeInputTokens !== expectedUsage.cumulativeInputTokens
      || signedUsage.cumulativeOutputTokens !== expectedUsage.cumulativeOutputTokens
      || signedUsage.cumulativeRequestCount !== expectedUsage.cumulativeRequestCount
    ) {
      throw new Error(
        `free usage totals mismatch sequence=${sequence} ` +
        `expected(in=${expectedUsage.cumulativeInputTokens},out=${expectedUsage.cumulativeOutputTokens},requests=${expectedUsage.cumulativeRequestCount}) ` +
        `got(in=${signedUsage.cumulativeInputTokens},out=${signedUsage.cumulativeOutputTokens},requests=${signedUsage.cumulativeRequestCount})`,
      );
    }
    const recovered = verifyTypedData(
      this._domain,
      FREE_USAGE_AUTH_TYPES,
      {
        channelId: payload.channelId,
        sequence,
        metadataHash: payload.metadataHash,
        deadline: BigInt(payload.deadline),
      },
      payload.usageSig,
    );
    if (recovered.toLowerCase() !== session.buyerEvmAddr.toLowerCase()) {
      throw new Error(`invalid FreeUsageAuth signer recovered=${recovered} expected=${session.buyerEvmAddr}`);
    }

    session.pendingRecord = {
      sequence,
      metadata: payload.metadata,
      deadline: BigInt(payload.deadline),
      usageSig: payload.usageSig,
    };
    session.recordsSinceFlush += 1;
    session.acceptedSequence = sequence;
    for (const key of session.expectedUsageBySequence.keys()) {
      if (BigInt(key) <= sequence) session.expectedUsageBySequence.delete(key);
    }
    paymentMux.sendFreeUsageAck({
      channelId: payload.channelId,
      acceptedSequence: sequence.toString(),
    });
    this._scheduleRecordFlush(buyerPeerId, session);
    debugLog(
      `[SellerFreeUsage] Usage auth accepted channel=${payload.channelId.slice(0, 18)}... ` +
      `sequence=${sequence}`,
    );
  }

  private _scheduleRecordFlush(
    buyerPeerId: string,
    session: SellerFreeUsageSession,
    opts: { retry?: boolean } = {},
  ): void {
    if (!session.pendingRecord || session.flushPromise) return;
    if (!opts.retry && session.recordsSinceFlush >= this._recordBatchSize) {
      this._clearFlushTimer(session);
      void this._flushPendingRecord(buyerPeerId, session);
      return;
    }
    if (session.flushTimer) return;
    // Records revert on-chain after the channel deadline, so never wait past it.
    const untilDeadlineMs = session.deadline * 1000 - Date.now() - 60_000;
    const delayMs = Math.min(this._recordFlushIntervalMs, Math.max(1_000, untilDeadlineMs));
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null;
      void this._flushPendingRecord(buyerPeerId, session);
    }, delayMs);
    (session.flushTimer as { unref?: () => void }).unref?.();
  }

  private _clearFlushTimer(session: SellerFreeUsageSession): void {
    if (!session.flushTimer) return;
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }

  private _flushPendingRecord(buyerPeerId: string, session: SellerFreeUsageSession): Promise<void> {
    if (!session.pendingRecord) return Promise.resolve();
    if (session.flushPromise) return session.flushPromise;

    let promise!: Promise<void>;
    promise = (async () => {
      const flushed = await this._doFlushPendingRecord(buyerPeerId, session);
      if (session.flushPromise === promise) {
        session.flushPromise = null;
      }
      if (session.pendingRecord && !session.closeRequested) {
        this._scheduleRecordFlush(buyerPeerId, session, flushed ? {} : { retry: true });
      }
    })();
    session.flushPromise = promise;
    return promise;
  }

  private async _doFlushPendingRecord(
    buyerPeerId: string,
    session: SellerFreeUsageSession,
  ): Promise<boolean> {
    const record = session.pendingRecord;
    if (!record) return true;

    this._clearFlushTimer(session);
    try {
      await session.openPromise;
      const closeRequested = session.closeRequested;
      if (closeRequested) {
        await this._client.close(
          this._signer,
          session.channelId,
          record.sequence,
          record.metadata,
          record.deadline,
          record.usageSig,
        );
      } else {
        await this._client.record(
          this._signer,
          session.channelId,
          record.sequence,
          record.metadata,
          record.deadline,
          record.usageSig,
        );
      }
      if (!closeRequested && session.closeRequested) {
        await this._client.close(
          this._signer,
          session.channelId,
          record.sequence,
          record.metadata,
          record.deadline,
          record.usageSig,
        );
      }
      const pending = session.pendingRecord;
      if (!pending || pending.sequence <= record.sequence) {
        session.pendingRecord = null;
        session.recordsSinceFlush = 0;
      } else {
        const delta = pending.sequence - record.sequence;
        session.recordsSinceFlush = Number(delta > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : delta);
      }
      debugLog(
        `[SellerFreeUsage] Usage ${session.closeRequested ? 'closed' : 'reported'} on-chain channel=${session.channelId.slice(0, 18)}... ` +
        `sequence=${record.sequence}`,
      );
      return true;
    } catch (err) {
      debugWarn(
        `[SellerFreeUsage] Deferred record failed for ${buyerPeerId.slice(0, 12)}... ` +
        `channel=${session.channelId.slice(0, 18)}... sequence=${record.sequence}: ` +
        `${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  private async _tryGetExistingSession(channelId: string) {
    try {
      return await this._client.getSession(channelId);
    } catch {
      return null;
    }
  }

  private _decodeFreeUsageMetadata(metadata: string): ExpectedFreeUsage {
    const [version, inputTokens, outputTokens, requestCount] = AbiCoder.defaultAbiCoder().decode(
      FREE_USAGE_METADATA_ABI,
      metadata,
    );
    if (BigInt(version) !== FREE_USAGE_METADATA_VERSION) {
      throw new Error(`unsupported free usage metadata version ${version}`);
    }
    return {
      cumulativeInputTokens: BigInt(inputTokens),
      cumulativeOutputTokens: BigInt(outputTokens),
      cumulativeRequestCount: BigInt(requestCount),
    };
  }
}
