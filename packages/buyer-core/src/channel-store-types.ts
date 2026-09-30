/**
 * Channel bookkeeping types shared between the sqlite ChannelStore in
 * @antseed/node and browser implementations. Moved from
 * packages/node/src/payments/channel-store.ts.
 */

import type { SpendingAuthMetadata, SpendingAuthServiceMetadata } from '@antseed/protocol/signatures';

export const CHANNEL_STATUS = {
  ACTIVE: 'active',
  SETTLED: 'settled',
  TIMEOUT: 'timeout',
  GHOST: 'ghost',
} as const;

export const CHANNEL_KIND = {
  PAID: 'paid',
  FREE: 'free',
} as const;

export const CHANNEL_ROLE = {
  BUYER: 'buyer',
  SELLER: 'seller',
} as const;

export type ChannelStatus = typeof CHANNEL_STATUS[keyof typeof CHANNEL_STATUS];
export type ChannelKind = typeof CHANNEL_KIND[keyof typeof CHANNEL_KIND];
export type ChannelRole = typeof CHANNEL_ROLE[keyof typeof CHANNEL_ROLE];

export interface StoredChannel {
  sessionId: string;
  peerId: string;
  role: ChannelRole;
  channelKind?: ChannelKind;
  sellerEvmAddr: string;
  buyerEvmAddr: string;
  nonce: number;
  authMax: string;          // bigint stored as string
  deadline: number;
  previousSessionId: string;
  previousConsumption: string; // bigint as string
  tokensDelivered: string;    // bigint as string
  requestCount: number;
  reservedAt: number;
  settledAt: number | null;
  settledAmount: string | null; // bigint as string
  status: ChannelStatus;
  latestBuyerSig: string | null;
  latestSpendingAuthSig: string | null;
  latestMetadata: string | null;       // hex-encoded
  /** Browser recovery context for replaying the original ReserveAuth. */
  reserveSalt?: string | null;
  /** Initial reserve ceiling, before any top-ups. */
  initialReserveAmount?: string | null;
  /** Latest signed reserve ceiling, including top-ups. */
  reserveMaxAmount?: string | null;
  /** Latest ReserveAuth signature, retained for idempotent replay. */
  latestReserveAuthSig?: string | null;
  /** Deadline covered by latestReserveAuthSig. */
  latestReserveDeadline?: number | null;
  /** True until the initial reserve is acknowledged or a top-up is observed on-chain. */
  reserveAuthPending?: boolean;
  /** Last reserve ceiling acknowledged initially or observed on-chain. */
  confirmedReserveAmount?: string | null;
  /**
   * Cumulative amount owed for delivered work. Below authMax only while a
   * video advance is outstanding; the gap covers the next charges.
   */
  deliveredAmount?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredChannelServiceTotal {
  sessionId: string;
  serviceId: string;
  cumulativeAmount: string; // bigint as string
  cumulativeInputTokens: string; // bigint as string
  cumulativeCachedInputTokens: string; // bigint as string
  cumulativeOutputTokens: string; // bigint as string
  cumulativeRequestCount: string; // bigint as string
  /** bigint as string; optional — rows/callers predating migration 005 default to '0'. */
  cumulativeOutputImages?: string;
  updatedAt: number;
}

/**
 * The store surface the buyer machinery uses. @antseed/node's sqlite
 * ChannelStore implements it; other environments can supply their own
 * backing store.
 */
export interface BuyerChannelStore {
  upsertChannel(channel: StoredChannel): void;
  getChannel(sessionId: string): StoredChannel | null;
  getActiveChannelByPeerAndBuyer(
    peerId: string,
    role: ChannelRole,
    buyerEvmAddr: string,
    channelKind?: ChannelKind,
  ): StoredChannel | null;
  getLatestChannelByPeerAndBuyer(
    peerId: string,
    role: ChannelRole,
    buyerEvmAddr: string,
    channelKind?: ChannelKind,
  ): StoredChannel | null;
  getActiveChannelsByBuyer(
    role: ChannelRole,
    buyerEvmAddr: string,
    channelKind?: ChannelKind,
  ): StoredChannel[];
  updateChannelStatus(sessionId: string, status: ChannelStatus, settledAmount?: string): void;
  replaceMetadataServiceTotals(
    sessionId: string,
    services?: readonly SpendingAuthServiceMetadata[],
  ): void;
  getChannelMetadata(channel: StoredChannel): SpendingAuthMetadata;
  /**
   * Atomically persist a signed authorization and its service totals. Stores
   * without an asynchronous durability boundary may omit this method.
   */
  commitAuthorization?(
    channel: StoredChannel,
    services?: readonly SpendingAuthServiceMetadata[],
  ): void | Promise<void>;
  /**
   * Durability barrier, awaited after a signed authorization is persisted and
   * BEFORE it is transmitted to the seller. A durable store (e.g. IndexedDB
   * behind a synchronous cache) must not resolve until the preceding writes
   * are committed, so a crash after transmission can never lose a signature
   * the seller already holds. Synchronous stores may return immediately.
   */
  flush?(): void | Promise<void>;
  /** Release backing resources after all writes have completed. */
  close?(): void | Promise<void>;
}
