import { createHash, randomUUID } from 'node:crypto';

import type { Identity } from '../p2p/identity.js';
import type { SerializedHttpRequest } from '../types/http.js';
import type { MeteringEvent, SessionMetrics, TokenCount } from '../types/metering.js';
import type { MeteringStorage } from './storage.js';
import type { ReceiptGenerator } from './receipt-generator.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { parseResponseUsage } from '../utils/response-usage.js';

export interface SellerSessionState {
  sessionId: string;
  sessionIdBytes: Uint8Array;
  startedAt: number;
  lastActivityAt: number;
  totalRequests: number;
  totalTokens: number;
  totalLatencyMs: number;
  totalCostCents: number;
  provider: string;
  settling?: boolean;
}

export interface SellerSessionSnapshot {
  sessionId: string;
  buyerPeerId: string;
  provider: string;
  startedAt: number;
  lastActivityAt: number;
  totalRequests: number;
  totalTokens: number;
  avgLatencyMs: number;
  settling: boolean;
}

export interface SessionTrackerEvents {
  onSessionUpdated(snapshot: SellerSessionSnapshot & { buyerPeerId: string }): void;
  onSessionFinalized(info: { buyerPeerId: string; sessionId: string; reason: string }): void;
}

export interface SessionTrackerConfig {
  /** Idle time before calling settle() to collect earnings (channel stays open). Default: 10 min. */
  settlementIdleMs?: number;
  /** Idle time before calling close() to end the channel entirely. Default: 12 hours. */
  closeIdleMs?: number;
}

/**
 * Tracks seller-side session lifecycle: session state, metering, receipts, and settlement.
 *
 * Extracted from AntseedNode to separate seller session concerns
 * from core node orchestration.
 */
export class SellerSessionTracker {
  private readonly _identity: Identity;
  private readonly _metering: MeteringStorage | null;
  private readonly _receiptGenerator: ReceiptGenerator | null;
  private readonly _config: SessionTrackerConfig;
  private readonly _events: SessionTrackerEvents;

  /** Per-buyer session tracking: buyerPeerId → seller session state */
  private readonly _sessions = new Map<string, SellerSessionState>();
  private readonly _settlementTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _closeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    identity: Identity,
    metering: MeteringStorage | null,
    receiptGenerator: ReceiptGenerator | null,
    config: SessionTrackerConfig,
    events: SessionTrackerEvents,
  ) {
    this._identity = identity;
    this._metering = metering;
    this._receiptGenerator = receiptGenerator;
    this._config = config;
    this._events = events;
  }

  getActiveSessions(): SellerSessionSnapshot[] {
    const snapshots: SellerSessionSnapshot[] = [];
    for (const [buyerPeerId, session] of this._sessions.entries()) {
      snapshots.push({
        sessionId: session.sessionId,
        buyerPeerId,
        provider: session.provider,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        totalRequests: session.totalRequests,
        totalTokens: session.totalTokens,
        avgLatencyMs: session.totalRequests > 0 ? session.totalLatencyMs / session.totalRequests : 0,
        settling: Boolean(session.settling),
      });
    }
    return snapshots;
  }

  getActiveChannelCount(): number {
    let count = 0;
    for (const session of this._sessions.values()) {
      if (!session.settling) count += 1;
    }
    return count;
  }

  /**
   * Get or create a seller session for a buyer.
   * Updates lastActivityAt and provider on existing sessions.
   */
  getOrCreateSession(buyerPeerId: string, providerName: string): SellerSessionState {
    let session = this._sessions.get(buyerPeerId);
    if (!session) {
      const now = Date.now();
      const sessionId = randomUUID();
      const sessionIdBytes = createHash('sha256').update(sessionId).digest();
      session = {
        sessionId,
        sessionIdBytes: new Uint8Array(sessionIdBytes),
        startedAt: now,
        lastActivityAt: now,
        totalRequests: 0,
        totalTokens: 0,
        totalLatencyMs: 0,
        totalCostCents: 0,
        provider: providerName,
      };
      this._sessions.set(buyerPeerId, session);
    }

    session.provider = providerName;
    session.lastActivityAt = Date.now();
    return session;
  }

  estimateTokens(inputBytes: number, outputBytes: number): TokenCount {
    const inputTokens = Math.max(1, Math.round(inputBytes / 4));
    const outputTokens = Math.max(1, Math.round(outputBytes / 4));
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, method: 'content-length', confidence: 'low' };
  }

  async recordMetering(input: {
    buyerPeerId: string;
    providerName: string;
    pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number };
    request: SerializedHttpRequest;
    statusCode: number;
    latencyMs: number;
    inputBytes: number;
    outputBytes: number;
    responseBody: Uint8Array;
    /** Pre-computed usage from parseResponseUsage — avoids re-parsing the same body. */
    providerUsage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
    /** Service (model id) the buyer asked for, recorded for the seller's request log. */
    service?: string;
    /** Why the request failed, when the status code does not carry it (the provider call threw). */
    error?: string;
  }): Promise<void> {
    const { buyerPeerId, providerName, pricing: providerPricingUsdPerMillion, request, statusCode, latencyMs, inputBytes, outputBytes, responseBody } = input;
    const sellerPeerId = this._identity.peerId;
    const isSSE = request.headers['accept']?.includes('text/event-stream') ?? false;

    const providerUsage = input.providerUsage ?? parseResponseUsage(responseBody);
    let tokens: TokenCount;
    if (providerUsage.inputTokens > 0 || providerUsage.outputTokens > 0) {
      const totalTokens = providerUsage.inputTokens + providerUsage.outputTokens;
      tokens = {
        inputTokens: providerUsage.inputTokens,
        outputTokens: providerUsage.outputTokens,
        totalTokens,
        method: 'provider-usage',
        confidence: 'high',
      };
      debugLog(`[SessionTracker] Metering: provider-usage tokens=${totalTokens} (in=${providerUsage.inputTokens} out=${providerUsage.outputTokens})`);
    } else {
      tokens = this.estimateTokens(inputBytes, outputBytes);
      debugLog(`[SessionTracker] Metering: estimated tokens=${tokens.totalTokens} from ${inputBytes}+${outputBytes} bytes`);
    }

    // Update session
    const session = this.getOrCreateSession(buyerPeerId, providerName);

    session.totalRequests++;
    session.totalTokens += tokens.totalTokens;
    session.totalLatencyMs += latencyMs;
    session.provider = providerName;
    session.lastActivityAt = Date.now();
    this._emitSessionUpdated(buyerPeerId, session);

    const metering = this._metering;
    if (!metering) {
      this.scheduleSettlementTimer(buyerPeerId);
      return;
    }

    // Record metering event
    const event: MeteringEvent = {
      eventId: randomUUID(),
      sessionId: session.sessionId,
      timestamp: Date.now(),
      provider: providerName,
      sellerPeerId,
      buyerPeerId,
      tokens,
      latencyMs,
      statusCode,
      wasStreaming: isSSE,
      ...(input.service ? { service: input.service } : {}),
      ...(providerUsage.cachedInputTokens !== undefined ? { cachedInputTokens: providerUsage.cachedInputTokens } : {}),
      ...(request.requestId ? { requestId: request.requestId } : {}),
    };
    const error = input.error ?? (statusCode >= 400 ? summarizeErrorBody(responseBody) : null);
    if (error) event.error = error;

    try {
      metering.insertEvent(event);
    } catch (err) {
      debugWarn(`[SessionTracker] Failed to record metering event: ${err instanceof Error ? err.message : err}`);
    }

    if (this._receiptGenerator) {
      const estimatedCostUsd =
        (tokens.inputTokens * providerPricingUsdPerMillion.inputUsdPerMillion +
          tokens.outputTokens * providerPricingUsdPerMillion.outputUsdPerMillion) /
        1_000_000;
      const effectiveUsdPerThousandTokens =
        tokens.totalTokens > 0 ? (estimatedCostUsd / tokens.totalTokens) * 1000 : 0;
      const unitPriceCentsPerThousandTokens = Math.max(0, effectiveUsdPerThousandTokens * 100);
      const receipt = this._receiptGenerator.generate(
        session.sessionId,
        event.eventId,
        providerName,
        buyerPeerId,
        event.tokens,
        unitPriceCentsPerThousandTokens,
      );
      try {
        metering.insertReceipt(receipt);
        session.totalCostCents += receipt.costCents;
      } catch (err) {
        debugWarn(`[SessionTracker] Failed to record usage receipt: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Upsert session metrics
    const sessionMetrics: SessionMetrics = {
      sessionId: session.sessionId,
      sellerPeerId,
      buyerPeerId,
      provider: providerName,
      startedAt: session.startedAt,
      endedAt: null,
      totalRequests: session.totalRequests,
      totalTokens: session.totalTokens,
      totalCostCents: session.totalCostCents,
      avgLatencyMs: session.totalLatencyMs / session.totalRequests,
      peerSwitches: 0,
      disputedReceipts: 0,
    };

    try {
      metering.upsertSession(sessionMetrics);
    } catch (err) {
      debugWarn(`[SessionTracker] Failed to upsert session: ${err instanceof Error ? err.message : err}`);
    }

    this.scheduleSettlementTimer(buyerPeerId);
  }

  scheduleSettlementTimer(buyerPeerId: string): void {
    // Reset the settle timer (short idle → settle, keep channel open)
    const existingSettle = this._settlementTimers.get(buyerPeerId);
    if (existingSettle) clearTimeout(existingSettle);

    const settleIdleMs = this._config.settlementIdleMs ?? 600_000;
    const settleTimer = setTimeout(() => {
      void this.finalizeSession(buyerPeerId, 'idle-settle');
    }, settleIdleMs);
    settleTimer.unref();
    this._settlementTimers.set(buyerPeerId, settleTimer);

    // Reset the close timer (long idle → close, end channel)
    const existingClose = this._closeTimers.get(buyerPeerId);
    if (existingClose) clearTimeout(existingClose);

    const closeIdleMs = this._config.closeIdleMs ?? 43_200_000; // 12 hours
    const closeTimer = setTimeout(() => {
      void this.finalizeSession(buyerPeerId, 'idle-timeout');
    }, closeIdleMs);
    closeTimer.unref();
    this._closeTimers.set(buyerPeerId, closeTimer);
  }

  async finalizeSession(buyerPeerId: string, reason: string): Promise<void> {
    const session = this._sessions.get(buyerPeerId);
    if (!session) return;

    // idle-settle: emit event for on-chain settle() but keep the session alive
    if (reason === 'idle-settle') {
      this._events.onSessionFinalized({ buyerPeerId, sessionId: session.sessionId, reason });
      return;
    }

    if (session.settling) return;
    session.settling = true;

    const timer = this._settlementTimers.get(buyerPeerId);
    if (timer) {
      clearTimeout(timer);
      this._settlementTimers.delete(buyerPeerId);
    }
    const closeTimer = this._closeTimers.get(buyerPeerId);
    if (closeTimer) {
      clearTimeout(closeTimer);
      this._closeTimers.delete(buyerPeerId);
    }

    if (!this._metering) {
      this._sessions.delete(buyerPeerId);
      return;
    }

    const now = Date.now();
    const baseMetrics: SessionMetrics = {
      sessionId: session.sessionId,
      sellerPeerId: this._identity.peerId,
      buyerPeerId,
      provider: session.provider,
      startedAt: session.startedAt,
      endedAt: now,
      totalRequests: session.totalRequests,
      totalTokens: session.totalTokens,
      totalCostCents: session.totalCostCents,
      avgLatencyMs: session.totalRequests > 0 ? session.totalLatencyMs / session.totalRequests : 0,
      peerSwitches: 0,
      disputedReceipts: 0,
    };

    try {
      this._metering.upsertSession(baseMetrics);
      this._sessions.delete(buyerPeerId);
      this._events.onSessionFinalized({
        buyerPeerId,
        sessionId: session.sessionId,
        reason,
      });
    } catch (err) {
      session.settling = false;
      debugWarn(`[SessionTracker] Failed to finalize session ${session.sessionId}: ${err instanceof Error ? err.message : err}`);
      const retry = setTimeout(() => {
        void this.finalizeSession(buyerPeerId, 'retry');
      }, 10_000);
      if (typeof (retry as { unref?: () => void }).unref === 'function') {
        (retry as { unref: () => void }).unref();
      }
      this._settlementTimers.set(buyerPeerId, retry);
    }
  }

  async finalizeAllSessions(reason: string): Promise<void> {
    if (this._sessions.size === 0) return;
    const buyers = [...this._sessions.keys()];
    await Promise.allSettled(
      buyers.map((buyerPeerId) => this.finalizeSession(buyerPeerId, reason)),
    );
  }

  clearTimers(): void {
    for (const timer of this._settlementTimers.values()) {
      clearTimeout(timer);
    }
    this._settlementTimers.clear();
    for (const timer of this._closeTimers.values()) {
      clearTimeout(timer);
    }
    this._closeTimers.clear();
  }

  private _emitSessionUpdated(buyerPeerId: string, session: SellerSessionState): void {
    this._events.onSessionUpdated({
      buyerPeerId,
      sessionId: session.sessionId,
      provider: session.provider,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      totalRequests: session.totalRequests,
      totalTokens: session.totalTokens,
      avgLatencyMs: session.totalRequests > 0 ? session.totalLatencyMs / session.totalRequests : 0,
      settling: Boolean(session.settling),
    });
  }
}

/** Upper bound on a stored request error; enough for an upstream message, never a whole body. */
const MAX_EVENT_ERROR_CHARS = 300;

/** The message of an error response (`error.message`, `error`, or `message`), else its text, shortened. */
export function summarizeErrorBody(body: Uint8Array): string | null {
  const text = new TextDecoder().decode(body.subarray(0, 4096)).trim();
  if (!text) return null;
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error = parsed.error;
    const candidate = typeof error === 'string' ? error
      : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message
      : typeof parsed.message === 'string' ? parsed.message : null;
    if (candidate) message = candidate;
  } catch {
    // Not JSON (or cut off): keep the text.
  }
  message = message.replace(/\s+/g, ' ').trim();
  return message.length > MAX_EVENT_ERROR_CHARS ? `${message.slice(0, MAX_EVENT_ERROR_CHARS - 1)}…` : message;
}
