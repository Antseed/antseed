import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getNetworkStats } from '../runtime/fetch-network-stats.js';
import { raceBudget } from './race-budget.js';
import { type ChatStreamStopReason } from './stream-stop.js';
import {
  normalizeChatPeerSelectionRequest,
  type ChatPeerSelectionRequest,
  type ChatRouteMode,
} from './peer-selection.js';
import {
  prepareChatAttachments,
  type PreparedChatAttachment,
  type RawChatAttachment,
} from './attachments/prepare.js';
import {
  deleteConversationAttachments,
  isSafeId,
  saveAttachment,
  sweepOrphanAttachments,
} from './attachments/store.js';
import {
  CHAT_WORKSPACE_DIR,
  getWorkspaceGitStatus,
  loadChatWorkspaceDir,
  persistChatWorkspaceDir,
} from './workspace.js';
import {
  getPeerPermissionMode,
  normalizePermissionMode,
  setPeerPermissionMode,
  type ChatPermissionMode,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from './permissions.js';
import { DEFAULT_BUYER_STATE_PATH, LOCALHOST_URL } from '../constants.js';
import { asErrorMessage } from '../utils.js';
import {
  classifyServiceCategory,
  durationBucket,
  modelPricingSnapshot,
  publicModelId,
  type TelemetryEventProperties,
} from '../telemetry/events.js';
import { classifyDiscoveryFailure } from '../telemetry/classify.js';
import type { RawPeerHealth } from '../runtime/peer-cache.js';
import {
  buildChatServiceCatalogFromNetworkModels,
  buildChatServiceCatalogFromPersistedPeers,
  type ChatServiceCatalogEntry,
  type ChatServiceProtocol,
} from './service-catalog.js';
import { enrichDomainVerificationLinks } from '../connected-apps/domain-site-metadata.js';
import { resolveChainConfig } from '@antseed/node';
import { collectPeerVerificationLinks } from '@antseed/node/discovery';
import { augmentChatToolPath } from './tool-env.js';
import type { AiConversation } from './conversation-types.js';
import {
  buildDiscoverRows,
  isCatalogEntryAllowedByBuyerMax,
  isPriceAllowedByBuyerMax,
  limitChatServiceCatalogEntries,
  loadBuyerMaxPricingDefaults,
  normalizeTrustBreakdown,
  updateServiceProtocolMap,
  updateServiceProviderHints,
  type BuyerStateDiscoveredPeer,
  type DiscoverRowEntry,
} from './service-discovery.js';
import { isPortReachable, resolveProxyPort } from './proxy-service.js';
import { isChatServiceProtocol } from './normalize.js';
import {
  normalizeModelPickerSnapshot,
  type ModelPickerSnapshot,
} from '../../shared/model-picker.js';
import {
  isPersistedPeerBindingPinned,
  PiConversationStore,
  projectPersistedConversationRoute,
} from './conversation-store.js';
import { createStreamingRunner } from './streaming-run.js';
import { generateChatImage } from './image-generation.js';
import type {
  ActiveRun,
  ChatStreamErrorPayload,
  RegisterPiChatHandlersOptions,
} from './engine-types.js';
import type { FirstModelShownSignal } from '../../shared/telemetry.js';

augmentChatToolPath();

/**
 * Programmatic surface over the chat engine for non-renderer frontends
 * (currently the Telegram bridge). Events still flow through the
 * sendToRenderer callback — tee it into the chat event bus to observe them.
 */
export type PiChatEngine = {
  createConversation(
    service?: string,
    provider?: string,
    peerId?: string,
    routeMode?: ChatRouteMode,
  ): Promise<AiConversation>;
  sendMessageStream(
    conversationId: string,
    userMessage: string,
    options?: { service?: string; peerId?: string; permissionMode?: ChatPermissionMode },
  ): Promise<{ ok: boolean; error?: string; stopReason?: ChatStreamStopReason }>;
  abort(conversationId?: string): Promise<void>;
  /** Resolves a pending tool approval; returns false when the id is unknown (already decided). */
  resolveToolApproval(id: string, decision: ToolApprovalDecision): boolean;
  getProxyPort(): Promise<number>;
  /**
   * Discovered network service catalog, sorted the way the chat UI lists
   * models and narrowed to entries within the buyer's routing policy — the
   * buyer proxy refuses pinned peers outside the pricing limits, so offering
   * them would only manufacture 502s.
   */
  discoverServiceCatalog(): Promise<ChatServiceCatalogEntry[]>;
  /**
   * Latest curated model-picker list pushed by the renderer (favorites first,
   * then recommended — the same rows as the in-app model dropdown). Null until
   * the renderer's first push after launch.
   */
  getModelPicker(): ModelPickerSnapshot | null;
  /** Rebinds a conversation's model/peer — same semantics as the chat UI's model dropdown. */
  selectPeer(request: ChatPeerSelectionRequest): Promise<{ ok: boolean; error?: string }>;
  /**
   * Sets the buyer default route (the sticky "current model" new conversations
   * inherit) and tells the renderer so the UI selection follows suit.
   */
  setDefaultRoute(peerId: string, service: string, provider?: string): Promise<{ ok: boolean; error?: string }>;
};

export function registerPiChatHandlers({
  ipcMain,
  sendToRenderer,
  configPath,
  isBuyerRuntimeRunning,
  ensureBuyerRuntimeStarted,
  appendSystemLog,
  recordFirstChatStarted,
  recordFirstModelShown,
  recordModelSelected,
  recordChatRequestStarted,
  recordChatRequestFinished,
  recordDiscoveryFailed,
}: RegisterPiChatHandlersOptions): PiChatEngine {
  void loadChatWorkspaceDir().catch(() => {});
  const store = new PiConversationStore();
  const activeRunsByConversation = new Map<string, ActiveRun>();
  const activeImageRunsByConversation = new Map<string, AbortController>();
  const serviceProviderHints = new Map<string, string[]>();
  /** Cached payment-required info from 402 responses, keyed by conversationId. */
  const cachedPaymentRequired = new Map<string, Record<string, unknown>>();
  const serviceProtocolMap = new Map<string, ChatServiceProtocol>();
  const preferredPeerByConversationId = new Map<string, string>();
  const pendingToolApprovals = new Map<string, { conversationId: string; resolve: (decision: ToolApprovalDecision) => void }>();

  const requestToolApproval = (request: ToolApprovalRequest): Promise<ToolApprovalDecision> => {
    return new Promise((resolve) => {
      pendingToolApprovals.set(request.id, { conversationId: request.conversationId, resolve });
      sendToRenderer('chat:tool-approval-requested', request);
    });
  };

  const cancelPendingToolApprovalsForConversation = (conversationId: string): void => {
    for (const [id, pending] of pendingToolApprovals) {
      if (pending.conversationId !== conversationId) continue;
      pendingToolApprovals.delete(id);
      pending.resolve('deny');
      sendToRenderer('chat:tool-approval-cleared', { id, conversationId });
    }
  };

  ipcMain.handle('chat:peer-permission-mode-get', async (_event, peerId: unknown) => {
    try {
      const mode = await getPeerPermissionMode(typeof peerId === 'string' ? peerId : null);
      return { ok: true, mode };
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  });

  ipcMain.handle('chat:peer-permission-mode-set', async (_event, payload: { peerId?: unknown; mode?: unknown }) => {
    try {
      const peerId = typeof payload?.peerId === 'string' ? payload.peerId : null;
      const mode = normalizePermissionMode(payload?.mode);
      await setPeerPermissionMode(peerId, mode);
      return { ok: true, mode };
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  });

  const resolveToolApproval = (id: string, decision: ToolApprovalDecision): boolean => {
    const pending = pendingToolApprovals.get(id);
    if (!pending) return false;
    pendingToolApprovals.delete(id);
    pending.resolve(decision);
    // Any surface may decide first; tell the others the request is settled.
    sendToRenderer('chat:tool-approval-cleared', { id, conversationId: pending.conversationId });
    return true;
  };

  ipcMain.handle('chat:tool-approval-decision', async (_event, payload: { id?: unknown; decision?: unknown }) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const decision = payload?.decision === 'allow_once' || payload?.decision === 'always_allow_peer'
      ? payload.decision
      : 'deny';
    if (!resolveToolApproval(id, decision)) {
      return { ok: false, error: 'Approval request not found' };
    }
    return { ok: true };
  });

  const cacheFallbackPaymentRequired = (conversationId: string, suggestedAmount: string): void => {
    const peerId = preferredPeerByConversationId.get(conversationId) ?? null;
    if (!peerId) {
      return;
    }
    const existing = cachedPaymentRequired.get(conversationId) ?? {};
    cachedPaymentRequired.set(conversationId, {
      ...existing,
      peerId,
      suggestedAmount,
    });
  };

  const emitChatStreamError = (payload: ChatStreamErrorPayload): void => {
    sendToRenderer('chat:ai-stream-error', payload);
  };

  const emitPaymentRequiredStreamError = (
    conversationId: string,
    suggestedAmount: string,
  ): ChatStreamStopReason => {
    const stopReason: ChatStreamStopReason = {
      kind: 'payment_required',
      source: 'billing',
      retryable: false,
      message: 'Payment is required before the stream can continue.',
    };
    emitChatStreamError({
      conversationId,
      error: `payment_required:${suggestedAmount}`,
      stopReason,
    });
    return stopReason;
  };

  const clearActiveRun = (run: ActiveRun | null): void => {
    if (!run) {
      return;
    }

    cancelPendingToolApprovalsForConversation(run.conversationId);

    try {
      run.unsubscribe();
    } catch {
      // Ignore listener cleanup failures.
    }

    try {
      run.session.dispose();
    } catch {
      // Ignore disposal races.
    }

    if (activeRunsByConversation.get(run.conversationId) === run) {
      activeRunsByConversation.delete(run.conversationId);
    }
  };

  const abortAndClearActiveRun = async (run: ActiveRun | null): Promise<void> => {
    if (!run) {
      return;
    }

    try {
      await run.session.abort();
    } catch {
      // Ignore abort races.
    }

    clearActiveRun(run);
  };

  const isProxyAvailable = async (port: number): Promise<boolean> => {
    return await isPortReachable(port);
  };

  const waitForBuyerProxy = async (port: number, timeoutMs = 20_000): Promise<boolean> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        if (await isProxyAvailable(port)) {
          return true;
        }
      } catch {
        // transient error — keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  };

  let lastServiceCatalogEntries: ChatServiceCatalogEntry[] = [];
  let lastBuyerEligibleServiceCatalogEntries: ChatServiceCatalogEntry[] = [];
  let lastServiceCatalogRefreshAt = 0;

  const modelTelemetryContext = (
    service: string,
    peerId: string | null,
  ): TelemetryEventProperties['model_selected'] => {
    const normalizedService = service.trim().toLowerCase();
    const catalogOffers = lastServiceCatalogEntries.filter((entry) => (
      entry.id.trim().toLowerCase() === normalizedService
      && (!peerId || entry.peerId === peerId)
    ));
    const eligibleOffers = lastBuyerEligibleServiceCatalogEntries.filter((entry) => (
      entry.id.trim().toLowerCase() === normalizedService
      && (!peerId || entry.peerId === peerId)
    ));
    const pricing = modelPricingSnapshot(eligibleOffers);
    return {
      public_model_id: publicModelId(service, catalogOffers.length > 0),
      service_category: classifyServiceCategory(service),
      route_mode: peerId ? 'pinned' : 'auto',
      pricing_tier: pricing.pricingTier,
      has_free_eligible_offer: pricing.hasFreeEligibleOffer,
      eligible_offer_count_bucket: pricing.eligibleOfferCountBucket,
    };
  };

  const recordModelSelection = (
    service: string,
    peerId: string | null,
  ): void => {
    if (!recordModelSelected) return;
    try {
      const selectionKey = JSON.stringify([
        service.trim().toLowerCase(),
        peerId?.trim() ?? null,
      ]);
      void Promise.resolve(recordModelSelected(
        modelTelemetryContext(service, peerId),
        selectionKey,
      )).catch(() => {});
    } catch {
      // Telemetry must never affect model selection.
    }
  };
  const SERVICE_CATALOG_DEBOUNCE_MS = 5_000;
  let serviceCatalogRefreshPromise: Promise<ChatServiceCatalogEntry[]> | null = null;

  const loadPersistedServiceCatalog = async (): Promise<ChatServiceCatalogEntry[]> => {
    try {
      const raw = await readFile(DEFAULT_BUYER_STATE_PATH, 'utf-8');
      return limitChatServiceCatalogEntries(buildChatServiceCatalogFromPersistedPeers(JSON.parse(raw)));
    } catch {
      return [];
    }
  };

  const refreshServiceCatalogFromNetwork = async (): Promise<ChatServiceCatalogEntry[]> => {
    // Deduplicate concurrent calls
    if (serviceCatalogRefreshPromise) return serviceCatalogRefreshPromise;
    // Debounce rapid calls (e.g. UI refreshes)
    if (Date.now() - lastServiceCatalogRefreshAt < SERVICE_CATALOG_DEBOUNCE_MS && lastServiceCatalogEntries.length > 0) {
      return lastServiceCatalogEntries;
    }

    serviceCatalogRefreshPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      let port = 0;
      try {
        port = await resolveProxyPort(configPath);
        const response = await fetch(`${LOCALHOST_URL}:${port}/v1/models`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const entries = buildChatServiceCatalogFromNetworkModels(await response.json());
        const limited = limitChatServiceCatalogEntries(entries);
        const resolved = limited.length > 0 ? limited : await loadPersistedServiceCatalog();
        updateServiceProviderHints(serviceProviderHints, resolved);
        updateServiceProtocolMap(serviceProtocolMap, resolved);
        lastServiceCatalogRefreshAt = Date.now();
        lastServiceCatalogEntries = resolved;
        return resolved;
      } catch (error) {
        appendSystemLog(`Desktop model catalog refresh failed (proxy :${String(port)}/v1/models): ${asErrorMessage(error)}`);
        if (lastServiceCatalogEntries.length > 0) return lastServiceCatalogEntries;
        const persisted = await loadPersistedServiceCatalog();
        lastServiceCatalogEntries = persisted;
        return persisted;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => { serviceCatalogRefreshPromise = null; });

    return serviceCatalogRefreshPromise;
  };

  // The catalog offered to non-renderer frontends (Telegram): only entries
  // the buyer routing policy will actually accept. The renderer applies the
  // same filter in chat:ai-list-discover-rows; without it here, /model
  // offered peers the buyer proxy then rejected with a policy 502.
  const discoverPolicyAllowedCatalog = async (): Promise<ChatServiceCatalogEntry[]> => {
    const entries = await refreshServiceCatalogFromNetwork();
    const buyerMaxPricing = await loadBuyerMaxPricingDefaults(configPath);
    const eligibleEntries = entries.filter((entry) => isCatalogEntryAllowedByBuyerMax(entry, buyerMaxPricing));
    lastBuyerEligibleServiceCatalogEntries = eligibleEntries;
    return eligibleEntries;
  };

  // Curated model-picker snapshot pushed by the renderer — see
  // shared/model-picker.ts. Main only caches the latest push.
  let modelPickerSnapshot: ModelPickerSnapshot | null = null;
  ipcMain.handle('chat:sync-model-picker', (_event, payload: unknown) => {
    const normalized = normalizeModelPickerSnapshot(payload);
    if (normalized) modelPickerSnapshot = normalized;
    return { ok: normalized != null };
  });

  const resolveProtocolForSend = async (serviceId: string): Promise<ChatServiceProtocol> => {
    const normalizedServiceId = serviceId.trim().toLowerCase();
    const existing = serviceProtocolMap.get(normalizedServiceId);
    if (existing) {
      return existing;
    }

    const refreshed = await refreshServiceCatalogFromNetwork();
    const match = refreshed.find((entry) => (
      entry.id.trim().toLowerCase() === normalizedServiceId
      && entry.protocol !== 'openai-images'
    ));
    return match && isChatServiceProtocol(match.protocol)
      ? match.protocol
      : 'anthropic-messages';
  };

  // Built here rather than beside the other helpers because it needs
  // `resolveProtocolForSend`; every caller lives further down.
  const runStreamingPrompt = createStreamingRunner({
    store,
    activeRunsByConversation,
    cachedPaymentRequired,
    preferredPeerByConversationId,
    configPath,
    sendToRenderer,
    appendSystemLog,
    isBuyerRuntimeRunning,
    ensureBuyerRuntimeStarted,
    requestToolApproval,
    cacheFallbackPaymentRequired,
    emitChatStreamError,
    emitPaymentRequiredStreamError,
    clearActiveRun,
    abortAndClearActiveRun,
    isProxyAvailable,
    waitForBuyerProxy,
    resolveProtocolForSend,
    getServiceCatalogEntries: () => lastServiceCatalogEntries,
    getBuyerEligibleServiceCatalogEntries: () => lastBuyerEligibleServiceCatalogEntries,
    ...(recordFirstChatStarted ? { recordFirstChatStarted } : {}),
    ...(recordChatRequestStarted ? { recordChatRequestStarted } : {}),
    ...(recordChatRequestFinished ? { recordChatRequestFinished } : {}),
  });

  ipcMain.handle('chat:ai-get-proxy-status', async () => {
    const port = await resolveProxyPort(configPath);
    const running = await isProxyAvailable(port);
    return {
      ok: true,
      data: {
        running,
        port,
      },
    };
  });

  ipcMain.handle('api:try-proxy-request', async (
    _event,
    params: { port: number; path: string; method: string; headers: Record<string, string>; body: string },
  ) => {
    try {
      const url = `${LOCALHOST_URL}:${params.port}${params.path}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      const res = await fetch(url, {
        method: params.method || 'POST',
        headers: params.headers || {},
        body: params.body || undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      return { ok: true, status: res.status, body: text, error: null as string | null };
    } catch (e) {
      const err = e as Error;
      return { ok: false, status: 0, body: '', error: err?.message ?? String(e) };
    }
  });

  type PeerMeteringStats = {
    totalSessions: number;
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    firstSessionAt: number | null;
    lastSessionAt: number | null;
  };

  // Phase budgets for the discover-rows pipeline. The renderer drops the IPC
  // result after 30s (CHAT_SERVICE_LIST_TIMEOUT_MS) — the sum of these plus
  // the local file reads must stay comfortably under that, or the model list
  // never populates while the runtime looks healthy. Generous enough for a
  // slow machine or connection to finish each phase; a phase that still
  // overruns is skipped for this cycle, not fatal.
  const CATALOG_PHASE_BUDGET_MS = 8_000;
  const METERING_FETCH_TIMEOUT_MS = 4_000;
  const METERING_PHASE_BUDGET_MS = 5_000;
  const ENRICHMENT_BUDGET_MS = 4_000;
  const NETWORK_STATS_BUDGET_MS = 8_000;
  const DISCOVER_ROWS_SLOW_MS = 3_000;
  /** Last successful per-peer metering, reused when a cycle's fetch times out. */
  const lastMeteringStats = new Map<string, PeerMeteringStats>();
  let discoverRowsEverSucceeded = false;

  ipcMain.handle('chat:ai-list-discover-rows', async () => {
    const startedAt = Date.now();
    const phaseMs: Array<[string, number]> = [];
    let phaseStartedAt = startedAt;
    const endPhase = (name: string): void => {
      const now = Date.now();
      phaseMs.push([name, now - phaseStartedAt]);
      phaseStartedAt = now;
    };
    try {
      const buyerMaxPricing = await loadBuyerMaxPricingDefaults(configPath);
      const entries = (await raceBudget(
        refreshServiceCatalogFromNetwork(),
        CATALOG_PHASE_BUDGET_MS,
        () => lastServiceCatalogEntries,
      )).filter((entry) => isCatalogEntryAllowedByBuyerMax(entry, buyerMaxPricing));
      lastBuyerEligibleServiceCatalogEntries = entries;
      endPhase('catalog');

      const buyerPort = await resolveProxyPort(configPath);
      const statsMap = new Map<string, PeerMeteringStats>();
      // Per-peer lifetime metering. The buyer-proxy exposes
      // /_antseed/metering/<peerId>; fetch in parallel for every catalog peer.
      const uniqueCatalogPeerIds = Array.from(new Set(
        entries.map((e) => e.peerId ?? '').filter((p) => p.length > 0)
      ));
      await raceBudget(Promise.all(uniqueCatalogPeerIds.map(async (peerId) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), METERING_FETCH_TIMEOUT_MS);
          let body: Record<string, unknown> | null;
          try {
            const resp = await fetch(
              `${LOCALHOST_URL}:${buyerPort}/_antseed/metering/${encodeURIComponent(peerId)}`,
              { signal: controller.signal },
            );
            if (!resp.ok) return;
            body = await resp.json() as Record<string, unknown> | null;
          } finally {
            clearTimeout(timer);
          }
          if (!body || typeof body !== 'object') return;
          const sessions = Number(body.lifetimeSessions) || 0;
          const reqs = Number(body.lifetimeRequests) || 0;
          const inTok = Number(body.lifetimeInputTokens) || 0;
          const outTok = Number(body.lifetimeOutputTokens) || 0;
          const firstAt = typeof body.lifetimeFirstSessionAt === 'number' ? body.lifetimeFirstSessionAt : null;
          const lastAt = typeof body.lifetimeLastSessionAt === 'number' ? body.lifetimeLastSessionAt : null;
          if (sessions === 0 && reqs === 0 && inTok === 0 && outTok === 0 && firstAt == null && lastAt == null) return;
          const stats: PeerMeteringStats = {
            totalSessions: sessions,
            totalRequests: reqs,
            totalInputTokens: inTok,
            totalOutputTokens: outTok,
            firstSessionAt: firstAt,
            lastSessionAt: lastAt,
          };
          statsMap.set(peerId, stats);
          lastMeteringStats.set(peerId, stats);
        } catch {
          // Timed out or unreachable — reuse the last known values so a slow
          // cycle doesn't blank the lifetime columns.
          const previous = lastMeteringStats.get(peerId);
          if (previous) statsMap.set(peerId, previous);
        }
      })), METERING_PHASE_BUDGET_MS, () => []);
      endPhase('metering');

      let discoveredPeersMap: Record<string, BuyerStateDiscoveredPeer> = {};
      let peerHealthMap: Record<string, RawPeerHealth> = {};
      try {
        const raw = await readFile(DEFAULT_BUYER_STATE_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.peerHealth && typeof parsed.peerHealth === 'object' && !Array.isArray(parsed.peerHealth)) {
          peerHealthMap = parsed.peerHealth as Record<string, RawPeerHealth>;
        }
        const arr = Array.isArray(parsed.discoveredPeers) ? parsed.discoveredPeers : [];
        const enrichmentTasks: Array<Promise<void>> = [];
        for (const p of arr) {
          if (p && typeof p === 'object' && typeof (p as { peerId?: unknown }).peerId === 'string') {
            const rec = p as Record<string, unknown>;
            const peerId = rec.peerId as string;
            const peerRecord: BuyerStateDiscoveredPeer = {
              trust: normalizeTrustBreakdown(rec.trust),
              onChainAgentId: typeof rec.onChainAgentId === 'number' ? rec.onChainAgentId : null,
              onChainPoolStakeAnts: typeof rec.onChainPoolStakeAnts === 'number' && Number.isFinite(rec.onChainPoolStakeAnts)
                ? rec.onChainPoolStakeAnts
                : null,
              onChainChannelCount: typeof rec.onChainChannelCount === 'number' ? rec.onChainChannelCount : null,
              onChainGhostCount: typeof rec.onChainGhostCount === 'number' ? rec.onChainGhostCount : null,
              onChainTotalVolumeUsdcMicros: typeof rec.onChainTotalVolumeUsdcMicros === 'number' ? rec.onChainTotalVolumeUsdcMicros : null,
              onChainLastSettledAtSec: typeof rec.onChainLastSettledAtSec === 'number' ? rec.onChainLastSettledAtSec : null,
              onChainReputationScore: typeof rec.onChainReputationScore === 'number' ? rec.onChainReputationScore : null,
              onChainWashFlagged: typeof rec.onChainWashFlagged === 'boolean' ? rec.onChainWashFlagged : null,
              onChainSybilRisk: typeof rec.onChainSybilRisk === 'number' ? rec.onChainSybilRisk : null,
              onChainSybilFlags: Array.isArray(rec.onChainSybilFlags)
                ? rec.onChainSybilFlags.filter((f: unknown): f is string => typeof f === 'string')
                : [],
              sellerContract: typeof rec.sellerContract === 'string' ? rec.sellerContract : undefined,
              verificationLinks: collectPeerVerificationLinks({ verificationResults: rec.verificationResults }),
              peerIconUrl: null,
            };
            discoveredPeersMap[peerId] = peerRecord;
            enrichmentTasks.push(
              enrichDomainVerificationLinks(peerRecord.verificationLinks).then((links) => {
                peerRecord.verificationLinks = links;
                peerRecord.peerIconUrl = links.find((link) => link.kind === 'domain' && link.faviconUrl)?.faviconUrl ?? null;
              }),
            );
          }
        }
        // Budgeted: already-cached domains resolve instantly; first-seen
        // domains keep resolving in the background and land in the
        // per-domain cache for the next cycle.
        await raceBudget(Promise.all(enrichmentTasks), ENRICHMENT_BUDGET_MS, () => []);
      } catch {
        // No state file yet
      }
      endPhase('enrichment');

      // Network-wide stats from the chain explorer (aggregator fallback). On
      // non-mainnet chains and on any failure this returns an empty map and
      // buildDiscoverRows falls back to local stats.
      const networkStats = await (async () => {
        try {
          const raw = await readFile(configPath, 'utf8');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const payments = (parsed.payments && typeof parsed.payments === 'object') ? parsed.payments as Record<string, unknown> : {};
          const overrides = (payments.crypto && typeof payments.crypto === 'object') ? payments.crypto as Record<string, unknown> : {};
          const selectedChain = (typeof overrides.chainId === 'string' && overrides.chainId.trim().length > 0)
            ? overrides.chainId
            : 'base-mainnet';
          const cc = resolveChainConfig({ chainId: selectedChain });
          return await getNetworkStats({
            explorerApiUrl: cc.explorerApiUrl,
            networkStatsUrl: cc.networkStatsUrl,
          }, { budgetMs: NETWORK_STATS_BUDGET_MS });
        } catch {
          return new Map<number, { requests: bigint; inputTokens: bigint; outputTokens: bigint }>();
        }
      })();
      endPhase('network-stats');

      const rows = (await buildDiscoverRows(entries, statsMap, discoveredPeersMap, networkStats, peerHealthMap))
        .filter((row) => isPriceAllowedByBuyerMax(
          row.inputUsdPerMillion,
          row.outputUsdPerMillion,
          row.cachedInputUsdPerMillion,
          buyerMaxPricing,
        ));
      endPhase('build');

      const totalMs = Date.now() - startedAt;
      if (totalMs >= DISCOVER_ROWS_SLOW_MS) {
        const breakdown = phaseMs.map(([name, ms]) => `${name}=${String(ms)}ms`).join(' ');
        appendSystemLog(`Service discovery slow: ${String(totalMs)}ms (${breakdown}) — ${String(rows.length)} row(s) from ${String(entries.length)} service(s)`);
      }
      if (!discoverRowsEverSucceeded) {
        discoverRowsEverSucceeded = true;
        appendSystemLog(`Service discovery ready: ${String(rows.length)} row(s) from ${String(entries.length)} service(s) in ${String(totalMs)}ms`);
      }
      return { ok: true, data: rows };
    } catch (error) {
      const totalMs = Date.now() - startedAt;
      appendSystemLog(`Service discovery failed after ${String(totalMs)}ms: ${asErrorMessage(error)}`);
      if (recordDiscoveryFailed) {
        try {
          void Promise.resolve(recordDiscoveryFailed({
            duration_bucket: durationBucket(totalMs),
            failure_code: classifyDiscoveryFailure(asErrorMessage(error)),
          })).catch(() => {});
        } catch {
          // Telemetry must never replace the original discovery failure.
        }
      }
      return { ok: false, data: [] as DiscoverRowEntry[], error: asErrorMessage(error) };
    }
  });

  ipcMain.handle('chat:ai-list-conversations', async () => {
    const conversations = await store.list();
    const enriched = conversations.map((c) => {
      const peerId = preferredPeerByConversationId.get(c.id) || c.peerId;
      if (peerId && !preferredPeerByConversationId.has(c.id)) {
        preferredPeerByConversationId.set(c.id, peerId);
      }
      return isPersistedPeerBindingPinned({ peerId: c.peerId ?? '', routeMode: c.routeMode })
        ? { ...c, peerId, routeMode: 'pinned' as const }
        : projectPersistedConversationRoute(c);
    });
    return { ok: true, data: enriched };
  });

  ipcMain.handle('chat:ai-get-workspace', async () => {
    const workspaceDir = await loadChatWorkspaceDir();
    return {
      ok: true,
      data: {
        current: workspaceDir,
        default: CHAT_WORKSPACE_DIR,
      },
    };
  });

  ipcMain.handle('chat:ai-get-workspace-git-status', async () => {
    try {
      const workspaceDir = await loadChatWorkspaceDir();
      return {
        ok: true,
        data: await getWorkspaceGitStatus(workspaceDir),
      };
    } catch (error) {
      return {
        ok: false,
        error: asErrorMessage(error),
      };
    }
  });

  ipcMain.handle('chat:ai-set-workspace', async (_event, workspaceDir: string) => {
    const current = await persistChatWorkspaceDir(workspaceDir);
    return {
      ok: true,
      data: {
        current,
        default: CHAT_WORKSPACE_DIR,
      },
    };
  });

  ipcMain.handle('chat:ai-get-conversation', async (_event, id: string) => {
    const conversation = await store.get(id);
    if (!conversation) {
      return { ok: false, error: 'Conversation not found' };
    }
    const routedConversation = projectPersistedConversationRoute(conversation);
    const peerId = preferredPeerByConversationId.get(id) || conversation.peerId;
    if (peerId) preferredPeerByConversationId.set(id, peerId);
    const enriched = conversation.routeMode === 'pinned' && peerId
      ? { ...routedConversation, peerId, routeMode: 'pinned' as const }
      : routedConversation;
    return { ok: true, data: enriched };
  });

  const createConversation = async (
    service?: string,
    provider?: string,
    peerId?: string,
    routeMode?: ChatRouteMode,
  ): Promise<AiConversation> => {
    const trimmedPeerId = routeMode === 'pinned' ? peerId?.trim() ?? '' : '';
    const peerLabel = trimmedPeerId
      ? lastServiceCatalogEntries.find((e) => e.peerId === trimmedPeerId)?.peerLabel
      : undefined;
    const conversation = await store.create(service, provider, trimmedPeerId || undefined, peerLabel, routeMode);
    if (trimmedPeerId) {
      preferredPeerByConversationId.set(conversation.id, trimmedPeerId);
    } else {
      preferredPeerByConversationId.delete(conversation.id);
    }
    return conversation;
  };

  ipcMain.handle('chat:ai-create-conversation', async (
    _event,
    service: string,
    provider?: string,
    peerId?: string,
    routeMode?: ChatRouteMode,
  ) => {
    return {
      ok: true,
      data: await createConversation(
        service,
        provider,
        peerId,
        routeMode === 'auto' || routeMode === 'pinned' ? routeMode : undefined,
      ),
    };
  });

  ipcMain.handle('chat:ai-delete-conversation', async (_event, id: string) => {
    preferredPeerByConversationId.delete(id);
    cachedPaymentRequired.delete(id);
    await store.delete(id);
    // Best effort: wipe any raw attachment bytes we persisted for this
    // conversation. Failures are swallowed so a stuck directory doesn't
    // block the primary delete from returning ok.
    try {
      await deleteConversationAttachments(id);
    } catch (err) {
      appendSystemLog(`Failed to delete attachments for conversation ${id}: ${asErrorMessage(err)}`);
    }
    return { ok: true };
  });

  // Sweep attachment directories that no longer correspond to any
  // conversation — can happen if a previous run crashed between persist
  // and the delete handler. Cheap (directory stat-only) so we do it once
  // on handler registration.
  void (async () => {
    try {
      const summaries = await store.list();
      const known = new Set<string>(summaries.map((s) => s.id));
      const removed = await sweepOrphanAttachments(known);
      if (removed.length > 0) {
        appendSystemLog(`Swept ${removed.length} orphan attachment director${removed.length === 1 ? 'y' : 'ies'}.`);
      }
    } catch (err) {
      appendSystemLog(`Attachment orphan sweep failed: ${asErrorMessage(err)}`);
    }
  })();

  ipcMain.handle('chat:ai-rename-conversation', async (_event, id: string, title: string) => {
    const manager = await store.openSessionManager(id);
    if (!manager) {
      return { ok: false, error: 'Conversation not found' };
    }
    manager.appendSessionInfo(title.trim());
    return { ok: true };
  });

  ipcMain.handle('chat:prepare-attachments', async (_event, conversationId: string, attachments: RawChatAttachment[]) => {
    try {
      const trimmedId = typeof conversationId === 'string' ? conversationId.trim() : '';
      // Guard the filesystem boundary: only run the disk-backed storage
      // path when the renderer supplied a conversationId we can vouch for.
      // Otherwise fall back to the legacy pure-prepare behaviour — the
      // LLM pipeline still works, we just can't offer native previews.
      const storage = trimmedId && isSafeId(trimmedId)
        ? async (raw: { id: string; name: string; mimeType: string; size: number }, buffer: Buffer): Promise<string> => {
            const attachmentId = randomUUID();
            await saveAttachment(trimmedId, attachmentId, raw.name, buffer);
            return attachmentId;
          }
        : undefined;
      return {
        ok: true,
        data: await prepareChatAttachments(attachments, { ...(storage ? { storage } : {}) }),
      };
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  });

  ipcMain.handle('chat:generate-image', async (_event, payload: unknown) => {
    const request = payload && typeof payload === 'object'
      ? payload as { conversationId?: unknown; prompt?: unknown; peerId?: unknown; moderation?: unknown; service?: unknown; sourceImageAttachmentId?: unknown }
      : {};
    const conversationId = typeof request.conversationId === 'string' ? request.conversationId.trim() : '';
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
    const peerId = typeof request.peerId === 'string' ? request.peerId.trim() : '';
    const moderation = request.moderation === 'auto' || request.moderation === 'low'
      ? request.moderation
      : undefined;
    const service = typeof request.service === 'string' ? request.service.trim() : '';
    const sourceImageAttachmentId = typeof request.sourceImageAttachmentId === 'string'
      ? request.sourceImageAttachmentId.trim()
      : '';
    if (!conversationId || !prompt || !service) {
      return { ok: false, error: 'Conversation, prompt, and image model are required.' };
    }
    if (!isSafeId(conversationId)) {
      return { ok: false, error: 'Invalid conversation.' };
    }
    if (sourceImageAttachmentId && !isSafeId(sourceImageAttachmentId)) {
      return { ok: false, error: 'Invalid source image.' };
    }
    if (activeRunsByConversation.has(conversationId) || activeImageRunsByConversation.has(conversationId)) {
      return { ok: false, error: 'A request is already in progress for this conversation.' };
    }
    const controller = new AbortController();
    activeImageRunsByConversation.set(conversationId, controller);
    try {
      const proxyPort = await resolveProxyPort(configPath);
      return await generateChatImage(store, proxyPort, {
        conversationId,
        prompt,
        ...(peerId ? { peerId } : {}),
        ...(moderation ? { moderation } : {}),
        service,
        ...(sourceImageAttachmentId ? { sourceImageAttachmentId } : {}),
      }, { signal: controller.signal });
    } finally {
      if (activeImageRunsByConversation.get(conversationId) === controller) {
        activeImageRunsByConversation.delete(conversationId);
      }
    }
  });

  ipcMain.handle(
    'chat:ai-send-stream',
    async (_event, conversationId: string, userMessage: string, service?: string, _provider?: string, attachments?: PreparedChatAttachment[], peerId?: string, permissionMode?: unknown) => {
      // `_provider` is accepted for IPC ABI compatibility with older
      // renderers but ignored — the buyer proxy resolves the route plan
      // from the pinned peer + the service ID without a provider hint.
      return await runStreamingPrompt(conversationId, userMessage, service, attachments, peerId, permissionMode);
    },
  );

  ipcMain.handle(
    'chat:ai-send',
    async (_event, conversationId: string, userMessage: string, service?: string, _provider?: string, attachments?: PreparedChatAttachment[], peerId?: string, permissionMode?: unknown) => {
      // `_provider` is accepted for IPC ABI compatibility with older
      // renderers but ignored — the buyer proxy resolves the route plan
      // from the pinned peer + the service ID without a provider hint.
      return await runStreamingPrompt(conversationId, userMessage, service, attachments, peerId, permissionMode);
    },
  );

  const abortConversations = async (conversationId?: string): Promise<void> => {
    const trimmedConversationId = typeof conversationId === 'string' ? conversationId.trim() : '';
    const activeRuns = trimmedConversationId
      ? [activeRunsByConversation.get(trimmedConversationId)].filter((run): run is ActiveRun => Boolean(run))
      : Array.from(activeRunsByConversation.values());
    const imageRuns = trimmedConversationId
      ? [activeImageRunsByConversation.get(trimmedConversationId)].filter((run): run is AbortController => Boolean(run))
      : Array.from(activeImageRunsByConversation.values());
    for (const controller of imageRuns) controller.abort();
    await Promise.all(activeRuns.map((run) => abortAndClearActiveRun(run)));
  };

  ipcMain.handle('chat:ai-abort', async (_event, conversationId?: string) => {
    await abortConversations(conversationId);
    return { ok: true };
  });

  const applyPeerSelection = async (payload: ChatPeerSelectionRequest | string | null): Promise<{ ok: boolean; error?: string }> => {
    const { conversationId, peerId, service, provider, routeMode } = normalizeChatPeerSelectionRequest(payload);
    const pinnedPeerId = routeMode === 'pinned' ? peerId : null;

    if (conversationId) {
      if (pinnedPeerId) {
        preferredPeerByConversationId.set(conversationId, pinnedPeerId);
        const peerLabel = lastServiceCatalogEntries.find((entry) => entry.peerId === pinnedPeerId)?.peerLabel;
        await store.setPeer(conversationId, pinnedPeerId, peerLabel, 'pinned');
      } else {
        preferredPeerByConversationId.delete(conversationId);
        await store.clearPeer(conversationId);
      }
      if (service) {
        await store.setModel(conversationId, provider ?? undefined, service);
        recordModelSelection(service, pinnedPeerId);
      }
    }

    if (!pinnedPeerId) {
      return { ok: true };
    }

    // Eager connection warmup via buyer proxy
    const proxyPort = await resolveProxyPort(configPath);
    try {
      const response = await fetch(`${LOCALHOST_URL}:${proxyPort}/_antseed/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ peerId: pinnedPeerId }),
      });
      const result = await response.json() as { ok: boolean; error?: string };
      return { ok: result.ok, error: result.error };
    } catch (err) {
      return { ok: false, error: asErrorMessage(err) };
    }
  };

  ipcMain.handle('chat:ai-select-peer', async (_event, payload: ChatPeerSelectionRequest | string | null) => applyPeerSelection(payload));

  // Keep the buyer proxy's default route (`antseed` model alias, and the
  // route the Telegram bridge reads) on the renderer's current AI VPN selection.
  // Best-effort: the buyer proxy may not be running yet — the renderer calls
  // this again on its catalog poll, so the route lands once the proxy is up.
  let lastPostedDefaultRoute = '';
  const setBuyerDefaultRoute = async (peerIdRaw: unknown, serviceRaw: unknown): Promise<{ ok: boolean; error?: string }> => {
    const peerId = typeof peerIdRaw === 'string' ? peerIdRaw.trim() : '';
    const service = typeof serviceRaw === 'string' ? serviceRaw.trim() : '';
    if (!service) return { ok: false, error: 'service is required' };
    const model = peerId ? `${peerId}@${service}` : service;
    if (model === lastPostedDefaultRoute) return { ok: true };
    try {
      const proxyPort = await resolveProxyPort(configPath);
      const response = await fetch(`${LOCALHOST_URL}:${proxyPort}/_antseed/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (result.ok) {
        lastPostedDefaultRoute = model;
        recordModelSelection(service, peerId || null);
      }
      return { ok: result.ok ?? false, error: result.error };
    } catch (err) {
      return { ok: false, error: asErrorMessage(err) };
    }
  };

  ipcMain.handle('chat:set-buyer-default-route', async (_event, payload: { peerId?: unknown; service?: unknown }) => (
    setBuyerDefaultRoute(payload?.peerId, payload?.service)
  ));

  ipcMain.handle('telemetry:first-model-shown', (_event, payload: unknown) => {
    const signal = payload as Partial<FirstModelShownSignal> | null;
    const service = typeof signal?.service === 'string' ? signal.service.trim() : '';
    const peerId = typeof signal?.peerId === 'string' ? signal.peerId.trim() : '';
    if (!service || !recordFirstModelShown) return { ok: false };
    try {
      void Promise.resolve(recordFirstModelShown(modelTelemetryContext(service, peerId || null))).catch(() => {});
    } catch {
      // Telemetry must never affect model rendering.
    }
    return { ok: true };
  });

  return {
    createConversation,
    sendMessageStream: (conversationId, userMessage, options) => runStreamingPrompt(
      conversationId,
      userMessage,
      options?.service,
      undefined,
      options?.peerId,
      options?.permissionMode,
    ),
    abort: abortConversations,
    resolveToolApproval,
    getProxyPort: () => resolveProxyPort(configPath),
    discoverServiceCatalog: discoverPolicyAllowedCatalog,
    getModelPicker: () => modelPickerSnapshot,
    selectPeer: applyPeerSelection,
    setDefaultRoute: async (peerId, service, provider) => {
      const result = await setBuyerDefaultRoute(peerId, service);
      sendToRenderer('chat:default-route-changed', { peerId, service, provider: provider ?? null });
      return result;
    },
  };
}
