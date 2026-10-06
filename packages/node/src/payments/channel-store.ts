import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from '../storage/migrate.js';
import { channelMigrations } from '../storage/migrations/channels/index.js';
import type { SpendingAuthMetadata, SpendingAuthServiceMetadata } from './evm/signatures.js';

// Channel constants/types + BuyerChannelStore interface moved to @antseed/buyer-core.
export {
  CHANNEL_STATUS,
  CHANNEL_KIND,
  CHANNEL_ROLE,
  type ChannelStatus,
  type ChannelKind,
  type ChannelRole,
  type StoredChannel,
  type StoredChannelServiceTotal,
  type BuyerChannelStore,
} from '@antseed/buyer-core/channel-store-types';
import {
  CHANNEL_STATUS,
  CHANNEL_KIND,
  CHANNEL_ROLE,
  type ChannelStatus,
  type ChannelKind,
  type ChannelRole,
  type StoredChannel,
  type StoredChannelServiceTotal,
} from '@antseed/buyer-core/channel-store-types';

export interface StoredReceipt {
  id?: number;
  sessionId: string;
  runningTotal: string;       // bigint as string
  requestCount: number;
  responseHash: string;
  sellerSig: string;
  buyerAckSig: string | null;
  createdAt: number;
}

/** Per-service usage aggregated across all of a buyer's channels (paid + free).
    `serviceId` is the keccak hash of the service name (see getServiceMetadataId). */
export interface BuyerServiceUsageTotal {
  serviceId: string;
  amountUsdc: string; // bigint as string (base units)
  inputTokens: string; // bigint as string
  cachedInputTokens: string; // bigint as string
  /** Includes OUTPUT_IMAGE_TOKEN_EQUIVALENT credits for generated images. */
  outputTokens: string; // bigint as string
  outputImages: string; // bigint as string
  videoGenerations: string; // bigint as string
  videoSeconds: string; // bigint as string
  requestCount: number;
}

export class ChannelStore {
  private _db: Database.Database;

  // ── Cached prepared statements (compiled once, reused every call) ──
  /** Cached transaction function for updateDeliveredAndInsertReceipt (compiled once). */
  private readonly _updateDeliveredAndInsertReceiptTxn: (
    sessionId: string,
    tokens: string,
    requestCount: number,
    receipt: Omit<StoredReceipt, 'id'>,
  ) => void;
  private readonly _replaceServiceTotalsTxn: (sessionId: string, totals: StoredChannelServiceTotal[]) => void;
  private readonly _commitAuthorizationTxn: (channel: StoredChannel, totals: StoredChannelServiceTotal[]) => void;

  private readonly _stmts: {
    upsert: Database.Statement;
    getById: Database.Statement;
    getActiveByPeer: Database.Statement;
    getOneOffByRequest: Database.Statement;
    getActiveByPeerAndBuyer: Database.Statement;
    getLatestByPeer: Database.Statement;
    getLatestByPeerAndBuyer: Database.Statement;
    updateStatusWithAmount: Database.Statement;
    updateStatus: Database.Statement;
    updateTokens: Database.Statement;
    getMaxNonce: Database.Statement;
    listAll: Database.Statement;
    getTimedOut: Database.Statement;
    insertReceipt: Database.Statement;
    getReceipts: Database.Statement;
    updateReceiptAck: Database.Statement;
    getActiveChannels: Database.Statement;
    getActiveChannelsByBuyer: Database.Statement;
    getTotalsByPeerAndBuyer: Database.Statement;
    deleteServiceTotals: Database.Statement;
    insertServiceTotal: Database.Statement;
    getServiceTotals: Database.Statement;
  };

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this._db = new Database(join(dataDir, 'sessions.db'));
    this._db.pragma('journal_mode = WAL');
    runMigrations(this._db, channelMigrations);
    this._stmts = this._prepareStatements();
    this._updateDeliveredAndInsertReceiptTxn = this._db.transaction(
      (sessionId: string, tokens: string, requestCount: number, receipt: Omit<StoredReceipt, 'id'>) => {
        this.updateTokensDelivered(sessionId, tokens, requestCount);
        this.insertReceipt(receipt);
      },
    );
    const replaceServiceTotals = (sessionId: string, totals: StoredChannelServiceTotal[]) => {
      this._stmts.deleteServiceTotals.run(sessionId);
      for (const total of totals) {
        this._stmts.insertServiceTotal.run({
          sessionId: total.sessionId,
          serviceId: total.serviceId,
          cumulativeAmount: total.cumulativeAmount,
          cumulativeInputTokens: total.cumulativeInputTokens,
          cumulativeCachedInputTokens: total.cumulativeCachedInputTokens,
          cumulativeOutputTokens: total.cumulativeOutputTokens,
          cumulativeRequestCount: total.cumulativeRequestCount,
          cumulativeOutputImages: total.cumulativeOutputImages ?? '0',
          cumulativeVideoGenerations: total.cumulativeVideoGenerations ?? '0',
          cumulativeVideoSeconds: total.cumulativeVideoSeconds ?? '0',
          updatedAt: total.updatedAt,
        });
      }
    };
    this._replaceServiceTotalsTxn = this._db.transaction(replaceServiceTotals);
    this._commitAuthorizationTxn = this._db.transaction(
      (channel: StoredChannel, totals: StoredChannelServiceTotal[]) => {
        this.upsertChannel(channel);
        replaceServiceTotals(channel.sessionId, totals);
      },
    );
  }

  private _prepareStatements() {
    return {
      upsert: this._db.prepare(`
        INSERT INTO payment_channels (
          session_id, peer_id, role, channel_kind, seller_evm_addr, buyer_evm_addr,
          nonce, auth_max, deadline, previous_session_id, previous_consumption,
          tokens_delivered, request_count, reserved_at, settled_at, settled_amount,
          status, latest_buyer_sig, latest_metadata_auth_sig, latest_metadata,
          created_at, updated_at, payment_recovery, one_off_request_id
        ) VALUES (
          @sessionId, @peerId, @role, @channelKind, @sellerEvmAddr, @buyerEvmAddr,
          @nonce, @authMax, @deadline, @previousSessionId, @previousConsumption,
          @tokensDelivered, @requestCount, @reservedAt, @settledAt, @settledAmount,
          @status, @latestBuyerSig, @latestSpendingAuthSig, @latestMetadata,
          @createdAt, @updatedAt, @paymentRecovery, @oneOffRequestId
        )
        ON CONFLICT(session_id) DO UPDATE SET
          channel_kind = @channelKind,
          auth_max = @authMax,
          previous_consumption = @previousConsumption,
          tokens_delivered = @tokensDelivered,
          request_count = @requestCount,
          settled_at = @settledAt,
          settled_amount = @settledAmount,
          status = @status,
          latest_buyer_sig = @latestBuyerSig,
          latest_metadata_auth_sig = @latestSpendingAuthSig,
          latest_metadata = @latestMetadata,
          payment_recovery = @paymentRecovery,
          updated_at = @updatedAt
      `),
      getById: this._db.prepare(
        'SELECT * FROM payment_channels WHERE session_id = ?',
      ),
      getOneOffByRequest: this._db.prepare(
        "SELECT * FROM payment_channels WHERE peer_id = ? AND role = ? AND one_off_request_id = ? AND channel_kind = 'one_off' ORDER BY created_at DESC LIMIT 1",
      ),
      getActiveByPeer: this._db.prepare(
        'SELECT * FROM payment_channels WHERE peer_id = ? AND role = ? AND channel_kind = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      ),
      getActiveByPeerAndBuyer: this._db.prepare(
        'SELECT * FROM payment_channels WHERE peer_id = ? AND role = ? AND buyer_evm_addr = ? AND channel_kind = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      ),
      getLatestByPeer: this._db.prepare(
        'SELECT * FROM payment_channels WHERE peer_id = ? AND role = ? AND channel_kind = ? ORDER BY created_at DESC LIMIT 1',
      ),
      getLatestByPeerAndBuyer: this._db.prepare(
        'SELECT * FROM payment_channels WHERE peer_id = ? AND role = ? AND buyer_evm_addr = ? AND channel_kind = ? ORDER BY created_at DESC LIMIT 1',
      ),
      updateStatusWithAmount: this._db.prepare(
        'UPDATE payment_channels SET status = ?, settled_at = ?, settled_amount = ?, updated_at = ? WHERE session_id = ?',
      ),
      updateStatus: this._db.prepare(
        'UPDATE payment_channels SET status = ?, updated_at = ? WHERE session_id = ?',
      ),
      updateTokens: this._db.prepare(
        'UPDATE payment_channels SET tokens_delivered = ?, request_count = ?, updated_at = ? WHERE session_id = ?',
      ),
      getMaxNonce: this._db.prepare(
        'SELECT MAX(nonce) as max_nonce FROM payment_channels WHERE role = ?',
      ),
      listAll: this._db.prepare(
        'SELECT * FROM payment_channels WHERE channel_kind = ? ORDER BY updated_at DESC LIMIT ?',
      ),
      getTimedOut: this._db.prepare(
        'SELECT * FROM payment_channels WHERE channel_kind = ? AND status = ? AND updated_at < ? ORDER BY updated_at LIMIT 100',
      ),
      insertReceipt: this._db.prepare(`
        INSERT INTO payment_receipts (
          session_id, running_total, request_count, response_hash,
          seller_sig, buyer_ack_sig, created_at
        ) VALUES (
          @sessionId, @runningTotal, @requestCount, @responseHash,
          @sellerSig, @buyerAckSig, @createdAt
        )
      `),
      getReceipts: this._db.prepare(
        'SELECT * FROM payment_receipts WHERE session_id = ? ORDER BY created_at',
      ),
      updateReceiptAck: this._db.prepare(
        'UPDATE payment_receipts SET buyer_ack_sig = ? WHERE session_id = ? AND running_total = ? AND request_count = ?',
      ),
      getActiveChannels: this._db.prepare(
        'SELECT * FROM payment_channels WHERE role = ? AND channel_kind = ? AND status = ? ORDER BY created_at DESC',
      ),
      getActiveChannelsByBuyer: this._db.prepare(
        'SELECT * FROM payment_channels WHERE role = ? AND buyer_evm_addr = ? AND channel_kind = ? AND status = ? ORDER BY created_at DESC',
      ),
      getTotalsByPeerAndBuyer: this._db.prepare(`
        SELECT
          COUNT(*) as total_sessions,
          COALESCE(SUM(request_count), 0) as total_requests,
          COALESCE(SUM(CAST(tokens_delivered AS INTEGER)), 0) as total_input_tokens,
          COALESCE(SUM(CAST(previous_consumption AS INTEGER)), 0) as total_output_tokens,
          COALESCE(SUM(CAST(auth_max AS INTEGER)), 0) as total_authorized,
          MIN(reserved_at) as first_session_at,
          MAX(updated_at) as last_session_at
        FROM payment_channels
        WHERE peer_id = ? AND role = ? AND buyer_evm_addr = ? AND channel_kind = ?
      `),
      deleteServiceTotals: this._db.prepare(
        'DELETE FROM payment_channel_service_totals WHERE session_id = ?',
      ),
      insertServiceTotal: this._db.prepare(`
        INSERT INTO payment_channel_service_totals (
          session_id, service_id, cumulative_amount, cumulative_input_tokens,
          cumulative_cached_input_tokens, cumulative_output_tokens,
          cumulative_request_count, cumulative_output_images,
          cumulative_video_generations, cumulative_video_seconds, updated_at
        ) VALUES (
          @sessionId, @serviceId, @cumulativeAmount, @cumulativeInputTokens,
          @cumulativeCachedInputTokens, @cumulativeOutputTokens,
          @cumulativeRequestCount, @cumulativeOutputImages,
          @cumulativeVideoGenerations, @cumulativeVideoSeconds, @updatedAt
        )
      `),
      getServiceTotals: this._db.prepare(
        'SELECT * FROM payment_channel_service_totals WHERE session_id = ? ORDER BY service_id',
      ),
    };
  }

  // ── Channel CRUD ──────────────────────────────────────────────

  upsertChannel(channel: StoredChannel): void {
    this._stmts.upsert.run({
      sessionId: channel.sessionId,
      peerId: channel.peerId,
      role: channel.role,
      channelKind: channel.channelKind ?? CHANNEL_KIND.PAID,
      sellerEvmAddr: channel.sellerEvmAddr,
      buyerEvmAddr: channel.buyerEvmAddr,
      nonce: channel.nonce,
      authMax: channel.authMax,
      deadline: channel.deadline,
      previousSessionId: channel.previousSessionId,
      previousConsumption: channel.previousConsumption,
      tokensDelivered: channel.tokensDelivered,
      requestCount: channel.requestCount,
      reservedAt: channel.reservedAt,
      settledAt: channel.settledAt,
      settledAmount: channel.settledAmount,
      status: channel.status,
      latestBuyerSig: channel.latestBuyerSig ?? null,
      latestSpendingAuthSig: channel.latestSpendingAuthSig ?? null,
      latestMetadata: channel.latestMetadata ?? null,
      paymentRecovery: JSON.stringify({
        reserveSalt: channel.reserveSalt,
        initialReserveAmount: channel.initialReserveAmount,
        reserveMaxAmount: channel.reserveMaxAmount,
        latestReserveAuthSig: channel.latestReserveAuthSig,
        latestReserveDeadline: channel.latestReserveDeadline,
        reserveAuthPending: channel.reserveAuthPending,
        confirmedReserveAmount: channel.confirmedReserveAmount,
        deliveredAmount: channel.deliveredAmount,
      }),
      oneOffRequestId: channel.oneOffRequestId ?? null,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    });
  }

  getChannel(sessionId: string): StoredChannel | null {
    const row = this._stmts.getById.get(sessionId) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  getOneOffChannelByRequest(peerId: string, role: ChannelRole, requestId: string): StoredChannel | null {
    const row = this._stmts.getOneOffByRequest.get(peerId, role, requestId) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  getActiveChannelByPeer(peerId: string, role: ChannelRole, channelKind: ChannelKind = CHANNEL_KIND.PAID): StoredChannel | null {
    const row = this._stmts.getActiveByPeer.get(peerId, role, channelKind, CHANNEL_STATUS.ACTIVE) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  getActiveChannelByPeerAndBuyer(peerId: string, role: ChannelRole, buyerEvmAddr: string, channelKind: ChannelKind = CHANNEL_KIND.PAID): StoredChannel | null {
    const row = this._stmts.getActiveByPeerAndBuyer.get(
      peerId,
      role,
      buyerEvmAddr,
      channelKind,
      CHANNEL_STATUS.ACTIVE,
    ) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  getLatestChannel(peerId: string, role: ChannelRole, channelKind: ChannelKind = CHANNEL_KIND.PAID): StoredChannel | null {
    const row = this._stmts.getLatestByPeer.get(peerId, role, channelKind) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  getLatestChannelByPeerAndBuyer(peerId: string, role: ChannelRole, buyerEvmAddr: string, channelKind: ChannelKind = CHANNEL_KIND.PAID): StoredChannel | null {
    const row = this._stmts.getLatestByPeerAndBuyer.get(peerId, role, buyerEvmAddr, channelKind) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  updateChannelStatus(sessionId: string, status: ChannelStatus, settledAmount?: string): void {
    const now = Date.now();
    if (settledAmount !== undefined) {
      this._stmts.updateStatusWithAmount.run(status, now, settledAmount, now, sessionId);
    } else {
      this._stmts.updateStatus.run(status, now, sessionId);
    }
  }

  updateTokensDelivered(sessionId: string, tokens: string, requestCount: number): void {
    this._stmts.updateTokens.run(tokens, requestCount, Date.now(), sessionId);
  }

  getMaxNonce(role: ChannelRole): number {
    const row = this._stmts.getMaxNonce.get(role) as { max_nonce: number | null } | undefined;
    return row?.max_nonce ?? 0;
  }

  /** List all channels ordered by most recent first. */
  listAllChannels(limit = 100, channelKind: ChannelKind = CHANNEL_KIND.PAID): StoredChannel[] {
    const rows = this._stmts.listAll.all(channelKind, limit) as ChannelRow[];
    return rows.map(rowToChannel);
  }

  /** Get all active channels for a given role (buyer or seller). */
  getActiveChannels(role: ChannelRole, channelKind: ChannelKind = CHANNEL_KIND.PAID): StoredChannel[] {
    const rows = this._stmts.getActiveChannels.all(role, channelKind, CHANNEL_STATUS.ACTIVE) as ChannelRow[];
    return rows.map(rowToChannel);
  }

  getActiveChannelsByBuyer(role: ChannelRole, buyerEvmAddr: string, channelKind: ChannelKind = CHANNEL_KIND.PAID): StoredChannel[] {
    const rows = this._stmts.getActiveChannelsByBuyer.all(role, buyerEvmAddr, channelKind, CHANNEL_STATUS.ACTIVE) as ChannelRow[];
    return rows.map(rowToChannel);
  }

  /** All channels for a given buyer (any status), ordered by most recent first. */
  getAllChannelsByBuyer(role: ChannelRole, buyerEvmAddr: string, channelKind: ChannelKind = CHANNEL_KIND.PAID): StoredChannel[] {
    const rows = this._db
      .prepare(
        'SELECT * FROM payment_channels WHERE role = ? AND buyer_evm_addr = ? AND channel_kind = ? ORDER BY created_at DESC',
      )
      .all(role, buyerEvmAddr, channelKind) as ChannelRow[];
    return rows.map(rowToChannel);
  }

  getBuyerPaymentChannels(buyerEvmAddr: string): StoredChannel[] {
    const rows = this._db.prepare(
      'SELECT * FROM payment_channels WHERE role = ? AND buyer_evm_addr = ? AND channel_kind IN (?, ?) ORDER BY created_at DESC',
    ).all(CHANNEL_ROLE.BUYER, buyerEvmAddr, CHANNEL_KIND.PAID, CHANNEL_KIND.ONE_OFF) as ChannelRow[];
    return rows.map(rowToChannel);
  }

  /** Aggregate totals across all channels for a given peer and role. */
  getTotalsByPeer(peerId: string, role: ChannelRole, channelKind: ChannelKind = CHANNEL_KIND.PAID): {
    totalSessions: number;
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalAuthorizedUsdc: bigint;
    firstSessionAt: number | null;
    lastSessionAt: number | null;
  } {
    const row = this._db.prepare(`
      SELECT
        COUNT(*) as total_sessions,
        COALESCE(SUM(request_count), 0) as total_requests,
        COALESCE(SUM(CAST(tokens_delivered AS INTEGER)), 0) as total_input_tokens,
        COALESCE(SUM(CAST(previous_consumption AS INTEGER)), 0) as total_output_tokens,
        COALESCE(SUM(CAST(auth_max AS INTEGER)), 0) as total_authorized,
        MIN(reserved_at) as first_session_at,
        MAX(updated_at) as last_session_at
      FROM payment_channels
      WHERE peer_id = ? AND role = ? AND channel_kind = ?
    `).get(peerId, role, channelKind) as {
      total_sessions: number;
      total_requests: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_authorized: number;
      first_session_at: number | null;
      last_session_at: number | null;
    };
    return {
      totalSessions: row.total_sessions,
      totalRequests: row.total_requests,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalAuthorizedUsdc: BigInt(row.total_authorized),
      firstSessionAt: row.first_session_at,
      lastSessionAt: row.last_session_at,
    };
  }

  getTotalsByPeerAndBuyer(peerId: string, role: ChannelRole, buyerEvmAddr: string, channelKind: ChannelKind = CHANNEL_KIND.PAID): {
    totalSessions: number;
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalAuthorizedUsdc: bigint;
    firstSessionAt: number | null;
    lastSessionAt: number | null;
  } {
    const row = this._stmts.getTotalsByPeerAndBuyer.get(peerId, role, buyerEvmAddr, channelKind) as {
      total_sessions: number;
      total_requests: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_authorized: number;
      first_session_at: number | null;
      last_session_at: number | null;
    };
    return {
      totalSessions: row.total_sessions,
      totalRequests: row.total_requests,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalAuthorizedUsdc: BigInt(row.total_authorized),
      firstSessionAt: row.first_session_at,
      lastSessionAt: row.last_session_at,
    };
  }

  // ── Timeout queries ───────────────────────────────────────────

  getTimedOutChannels(timeoutSeconds: number, channelKind: ChannelKind = CHANNEL_KIND.PAID): StoredChannel[] {
    const cutoff = Date.now() - timeoutSeconds * 1000;
    const rows = this._stmts.getTimedOut.all(channelKind, CHANNEL_STATUS.ACTIVE, cutoff) as ChannelRow[];
    return rows.map(rowToChannel);
  }

  // ── Receipt CRUD ──────────────────────────────────────────────

  insertReceipt(receipt: Omit<StoredReceipt, 'id'>): void {
    this._stmts.insertReceipt.run({
      sessionId: receipt.sessionId,
      runningTotal: receipt.runningTotal,
      requestCount: receipt.requestCount,
      responseHash: receipt.responseHash,
      sellerSig: receipt.sellerSig,
      buyerAckSig: receipt.buyerAckSig,
      createdAt: receipt.createdAt,
    });
  }

  getReceipts(sessionId: string): StoredReceipt[] {
    const rows = this._stmts.getReceipts.all(sessionId) as ReceiptRow[];
    return rows.map(rowToReceipt);
  }

  /** Atomically update tokens delivered and insert receipt in a single transaction. */
  updateDeliveredAndInsertReceipt(
    sessionId: string,
    tokens: string,
    requestCount: number,
    receipt: Omit<StoredReceipt, 'id'>,
  ): void {
    this._updateDeliveredAndInsertReceiptTxn(sessionId, tokens, requestCount, receipt);
  }

  /** Update receipt ack directly by composite key (no load-all-then-filter). */
  updateReceiptAck(sessionId: string, runningTotal: string, requestCount: number, buyerAckSig: string): void {
    this._stmts.updateReceiptAck.run(buyerAckSig, sessionId, runningTotal, requestCount);
  }

  // ── Service total CRUD ────────────────────────────────────────

  replaceServiceTotals(sessionId: string, totals: Omit<StoredChannelServiceTotal, 'sessionId' | 'updatedAt'>[]): void {
    const updatedAt = Date.now();
    this._replaceServiceTotalsTxn(
      sessionId,
      totals.map((total) => ({
        sessionId,
        ...total,
        updatedAt,
      })),
    );
  }

  replaceMetadataServiceTotals(sessionId: string, services: readonly SpendingAuthServiceMetadata[] = []): void {
    this.replaceServiceTotals(sessionId, this._metadataTotals(services));
  }

  /** Persist the signed channel snapshot and its exact service totals atomically. */
  commitAuthorization(
    channel: StoredChannel,
    services: readonly SpendingAuthServiceMetadata[] = [],
  ): void {
    const updatedAt = Date.now();
    const totals = this._metadataTotals(services).map((total) => ({
      sessionId: channel.sessionId,
      ...total,
      updatedAt,
    }));
    this._commitAuthorizationTxn(channel, totals);
  }

  getServiceTotals(sessionId: string): StoredChannelServiceTotal[] {
    const rows = this._stmts.getServiceTotals.all(sessionId) as ServiceTotalRow[];
    return rows.map(rowToServiceTotal);
  }

  /**
   * Aggregate per-service usage across every channel owned by `buyerEvmAddr`
   * (all statuses, paid and free). Values are summed as bigints in JS — the
   * columns are TEXT-encoded bigints, so SQL SUM would silently lose precision.
   */
  getBuyerServiceUsageTotals(buyerEvmAddr: string): BuyerServiceUsageTotal[] {
    const rows = this._db
      .prepare(`
        SELECT t.service_id, t.cumulative_amount, t.cumulative_input_tokens,
               t.cumulative_cached_input_tokens, t.cumulative_output_tokens,
               t.cumulative_request_count, t.cumulative_output_images,
               t.cumulative_video_generations, t.cumulative_video_seconds
        FROM payment_channel_service_totals t
        JOIN payment_channels c ON c.session_id = t.session_id
        WHERE c.role = ? AND c.buyer_evm_addr = ?
      `)
      .all(CHANNEL_ROLE.BUYER, buyerEvmAddr) as Array<{
        service_id: string;
        cumulative_amount: string;
        cumulative_input_tokens: string;
        cumulative_cached_input_tokens: string;
        cumulative_output_tokens: string;
        cumulative_request_count: string;
        cumulative_output_images: string;
        cumulative_video_generations: string;
        cumulative_video_seconds: string;
      }>;

    const byService = new Map<string, {
      amount: bigint;
      input: bigint;
      cached: bigint;
      output: bigint;
      requests: bigint;
      images: bigint;
      videoGenerations: bigint;
      videoSeconds: bigint;
    }>();
    const toBigInt = (value: string): bigint => {
      try { return BigInt(value || '0'); } catch { return 0n; }
    };
    for (const row of rows) {
      const entry = byService.get(row.service_id) ?? {
        amount: 0n,
        input: 0n,
        cached: 0n,
        output: 0n,
        requests: 0n,
        images: 0n,
        videoGenerations: 0n,
        videoSeconds: 0n,
      };
      entry.amount += toBigInt(row.cumulative_amount);
      entry.input += toBigInt(row.cumulative_input_tokens);
      entry.cached += toBigInt(row.cumulative_cached_input_tokens);
      entry.output += toBigInt(row.cumulative_output_tokens);
      entry.requests += toBigInt(row.cumulative_request_count);
      entry.images += toBigInt(row.cumulative_output_images);
      entry.videoGenerations += toBigInt(row.cumulative_video_generations);
      entry.videoSeconds += toBigInt(row.cumulative_video_seconds);
      byService.set(row.service_id, entry);
    }
    return Array.from(byService.entries()).map(([serviceId, entry]) => ({
      serviceId,
      amountUsdc: entry.amount.toString(),
      inputTokens: entry.input.toString(),
      cachedInputTokens: entry.cached.toString(),
      outputTokens: entry.output.toString(),
      outputImages: entry.images.toString(),
      videoGenerations: entry.videoGenerations.toString(),
      videoSeconds: entry.videoSeconds.toString(),
      requestCount: Number(entry.requests),
    }));
  }

  getMetadataServiceTotals(sessionId: string): SpendingAuthServiceMetadata[] {
    return this.getServiceTotals(sessionId).map((total) => ({
      serviceId: total.serviceId,
      cumulativeAmount: BigInt(total.cumulativeAmount),
      cumulativeInputTokens: BigInt(total.cumulativeInputTokens),
      cumulativeCachedInputTokens: BigInt(total.cumulativeCachedInputTokens),
      cumulativeOutputTokens: BigInt(total.cumulativeOutputTokens),
      cumulativeRequestCount: BigInt(total.cumulativeRequestCount),
      cumulativeOutputImages: BigInt(total.cumulativeOutputImages ?? '0'),
      cumulativeVideoGenerations: BigInt(total.cumulativeVideoGenerations ?? '0'),
      cumulativeVideoSeconds: BigInt(total.cumulativeVideoSeconds ?? '0'),
    }));
  }

  getChannelMetadata(channel: StoredChannel): SpendingAuthMetadata {
    const services = this.getMetadataServiceTotals(channel.sessionId);
    return {
      cumulativeInputTokens: BigInt(channel.tokensDelivered),
      cumulativeOutputTokens: BigInt(channel.previousConsumption),
      cumulativeRequestCount: BigInt(channel.requestCount),
      // No channel column for images — recovered from the per-service rows.
      cumulativeOutputImages: services.reduce((sum, s) => sum + s.cumulativeOutputImages, 0n),
      cumulativeVideoGenerations: services.reduce((sum, s) => sum + (s.cumulativeVideoGenerations ?? 0n), 0n),
      cumulativeVideoSeconds: services.reduce((sum, s) => sum + (s.cumulativeVideoSeconds ?? 0n), 0n),
      services,
    };
  }

  private _metadataTotals(
    services: readonly SpendingAuthServiceMetadata[],
  ): Omit<StoredChannelServiceTotal, 'sessionId' | 'updatedAt'>[] {
    return services.map((service) => ({
      serviceId: service.serviceId,
      cumulativeAmount: service.cumulativeAmount.toString(),
      cumulativeInputTokens: service.cumulativeInputTokens.toString(),
      cumulativeCachedInputTokens: service.cumulativeCachedInputTokens.toString(),
      cumulativeOutputTokens: service.cumulativeOutputTokens.toString(),
      cumulativeRequestCount: service.cumulativeRequestCount.toString(),
      cumulativeOutputImages: (service.cumulativeOutputImages ?? 0n).toString(),
      cumulativeVideoGenerations: (service.cumulativeVideoGenerations ?? 0n).toString(),
      cumulativeVideoSeconds: (service.cumulativeVideoSeconds ?? 0n).toString(),
    }));
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  close(): void {
    this._db.close();
  }
}

// ── Row types ─────────────────────────────────────────────────

interface ChannelRow {
  payment_recovery: string | null;
  one_off_request_id: string | null;
  session_id: string;
  peer_id: string;
  role: string;
  channel_kind: string;
  seller_evm_addr: string;
  buyer_evm_addr: string;
  nonce: number;
  auth_max: string;
  deadline: number;
  previous_session_id: string;
  previous_consumption: string;
  tokens_delivered: string;
  request_count: number;
  reserved_at: number;
  settled_at: number | null;
  settled_amount: string | null;
  status: string;
  latest_buyer_sig: string | null;
  latest_metadata_auth_sig: string | null;
  latest_metadata: string | null;
  created_at: number;
  updated_at: number;
}

interface ReceiptRow {
  id: number;
  session_id: string;
  running_total: string;
  request_count: number;
  response_hash: string;
  seller_sig: string;
  buyer_ack_sig: string | null;
  created_at: number;
}

interface ServiceTotalRow {
  session_id: string;
  service_id: string;
  cumulative_amount: string;
  cumulative_input_tokens: string;
  cumulative_cached_input_tokens: string;
  cumulative_output_tokens: string;
  cumulative_request_count: string;
  cumulative_output_images: string;
  cumulative_video_generations: string;
  cumulative_video_seconds: string;
  updated_at: number;
}

function rowToChannel(row: ChannelRow): StoredChannel {
  return {
    ...(row.payment_recovery ? JSON.parse(row.payment_recovery) : {}),
    sessionId: row.session_id,
    peerId: row.peer_id,
    role: row.role as ChannelRole,
    channelKind: (row.channel_kind ?? CHANNEL_KIND.PAID) as ChannelKind,
    sellerEvmAddr: row.seller_evm_addr,
    buyerEvmAddr: row.buyer_evm_addr,
    nonce: row.nonce,
    authMax: row.auth_max,
    deadline: row.deadline,
    previousSessionId: row.previous_session_id,
    previousConsumption: row.previous_consumption,
    tokensDelivered: row.tokens_delivered,
    requestCount: row.request_count,
    reservedAt: row.reserved_at,
    settledAt: row.settled_at,
    settledAmount: row.settled_amount,
    status: row.status as StoredChannel['status'],
    latestBuyerSig: row.latest_buyer_sig,
    latestSpendingAuthSig: row.latest_metadata_auth_sig,
    latestMetadata: row.latest_metadata,
    ...(row.one_off_request_id ? { oneOffRequestId: row.one_off_request_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReceipt(row: ReceiptRow): StoredReceipt {
  return {
    id: row.id,
    sessionId: row.session_id,
    runningTotal: row.running_total,
    requestCount: row.request_count,
    responseHash: row.response_hash,
    sellerSig: row.seller_sig,
    buyerAckSig: row.buyer_ack_sig,
    createdAt: row.created_at,
  };
}

function rowToServiceTotal(row: ServiceTotalRow): StoredChannelServiceTotal {
  return {
    sessionId: row.session_id,
    serviceId: row.service_id,
    cumulativeAmount: row.cumulative_amount,
    cumulativeInputTokens: row.cumulative_input_tokens,
    cumulativeCachedInputTokens: row.cumulative_cached_input_tokens,
    cumulativeOutputTokens: row.cumulative_output_tokens,
    cumulativeRequestCount: row.cumulative_request_count,
    cumulativeOutputImages: row.cumulative_output_images ?? '0',
    cumulativeVideoGenerations: row.cumulative_video_generations ?? '0',
    cumulativeVideoSeconds: row.cumulative_video_seconds ?? '0',
    updatedAt: row.updated_at,
  };
}
