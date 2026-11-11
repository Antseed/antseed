/**
 * IPC surface of the built-in chat. The chat is a plain API client of the
 * gateway: it lists the gateway's models, sends each turn to the gateway with
 * the desktop's key, and persists conversations as pi sessions.
 */
import { PendingRuns } from './pending-runs.js';
import { sendStreamHandler } from './send-options.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  prepareChatAttachments,
  type RawChatAttachment,
} from './attachments/prepare.js';
import {
  deleteConversationAttachments,
  isSafeId,
  saveAttachment,
  sweepOrphanAttachments,
} from './attachments/store.js';
import {
  CHAT_DATA_DIR,
  CHAT_WORKSPACE_DIR,
  loadChatWorkspaceDir,
  persistChatWorkspaceDir,
} from './workspace.js';
import { ChatOrganizationStore, flagsFor, type ConversationFlags } from './chat-organization.js';
import { GitBranchCache } from './git-branch.js';
import {
  getModelPermissionMode,
  normalizePermissionMode,
  setModelPermissionMode,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from './permissions.js';
import { asErrorMessage } from '../utils.js';
import {
  classifyServiceCategory,
  durationBucket,
  modelPricingSnapshot,
  publicModelId,
  type TelemetryEventProperties,
} from '../telemetry/events.js';
import { classifyDiscoveryFailure } from '../telemetry/classify.js';
import { augmentChatToolPath } from './tool-env.js';
import { normalizeServiceId } from './normalize.js';
import { PiConversationStore } from './conversation-store.js';
import { createStreamingRunner, type ResolvedChatModel } from './streaming-run.js';
import { generateChatImage } from './image-generation.js';
import type { PiChatEngine } from './engine-types.js';
import { recommendAppModels, toChatModel, toTrustedChatModels, type ChatModel } from '../gateway/catalog.js';
import { fetchRoutePreview } from '../gateway/route-preview.js';
import { splitPinnedModel } from '../../shared/pinned-model.js';
import { currentPrivacyMode, getGatewayEndpoint, whenPrivacySettled, type GatewayEndpoint } from '../gateway/service.js';
import { passPrivacyGate, requiresPrivate, type PrivacyGate } from './privacy-gate.js';
import { clearGatewayModelCache, fetchGatewayModelEntries, type GatewayModelEntry } from '../gateway/models.js';
import type {
  ActiveRun,
  ChatStreamErrorPayload,
  RegisterPiChatHandlersOptions,
} from './engine-types.js';
import type { FirstModelShownSignal } from '../../shared/telemetry.js';
import { finiteNumber } from '../gateway/response-fields.js';

augmentChatToolPath();

export type { PiChatEngine } from './engine-types.js';

type OfferPricing = ResolvedChatModel['offers'][number];

/** Seller offers listed under a gateway entry, reduced to the prices telemetry buckets. */
function entryOffers(entry: GatewayModelEntry | undefined): OfferPricing[] {
  const peers = Array.isArray(entry?.['peers']) ? entry['peers'] as unknown[] : [];
  return peers
    .filter((peer): peer is Record<string, unknown> => Boolean(peer) && typeof peer === 'object')
    .map((peer) => {
      const offer: OfferPricing = {};
      for (const key of ['inputUsdPerMillion', 'outputUsdPerMillion', 'cachedInputUsdPerMillion', 'minImageUsdPerImage', 'maxImageUsdPerImage'] as const) {
        const value = finiteNumber(peer[key]);
        if (value !== null) offer[key] = value;
      }
      return offer;
    });
}

export function registerPiChatHandlers({
  ipcMain,
  sendToRenderer,
  configPath,
  appendSystemLog,
  recordFirstChatStarted,
  recordFirstModelShown,
  recordModelSelected,
  recordChatRequestStarted,
  recordChatRequestFinished,
  recordDiscoveryFailed,
  getChatSendTelemetryContext,
  recordPremiumBlocked,
}: RegisterPiChatHandlersOptions): PiChatEngine {
  void loadChatWorkspaceDir().catch(() => {});
  const store = new PiConversationStore();
  const organization = new ChatOrganizationStore(path.join(CHAT_DATA_DIR, 'organization.json'));
  const gitBranches = new GitBranchCache();
  const activeRunsByConversation = new Map<string, ActiveRun>();
  const pendingRuns = new PendingRuns();
  const activeImageRunsByConversation = new Map<string, AbortController>();
  const pendingToolApprovals = new Map<string, { conversationId: string; resolve: (decision: ToolApprovalDecision) => void }>();
  /** Entries from the last successful `/v1/models` read, for telemetry context. */
  let lastEntries: GatewayModelEntry[] = [];

  // ── Tool approvals ──

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

  const resolveToolApproval = (id: string, decision: ToolApprovalDecision): boolean => {
    const pending = pendingToolApprovals.get(id);
    if (!pending) return false;
    pendingToolApprovals.delete(id);
    pending.resolve(decision);
    sendToRenderer('chat:tool-approval-cleared', { id, conversationId: pending.conversationId });
    return true;
  };

  ipcMain.handle('chat:tool-approval-decision', async (_event, payload: { id?: unknown; decision?: unknown }) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const decision: ToolApprovalDecision = payload?.decision === 'allow_once' || payload?.decision === 'always_allow'
      ? payload.decision
      : 'deny';
    if (!resolveToolApproval(id, decision)) {
      return { ok: false, error: 'Approval request not found' };
    }
    return { ok: true };
  });

  // Agent access ("Ask first" / "Full access") is remembered per model.
  ipcMain.handle('chat:permission-mode-get', async (_event, modelId: unknown) => {
    try {
      // Remembered per model, whichever seller a chat pins.
      return { ok: true, mode: await getModelPermissionMode(splitPinnedModel(normalizeServiceId(modelId)).modelId || null) };
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  });

  ipcMain.handle('chat:permission-mode-set', async (_event, payload: { modelId?: unknown; mode?: unknown }) => {
    try {
      const mode = normalizePermissionMode(payload?.mode);
      await setModelPermissionMode(splitPinnedModel(normalizeServiceId(payload?.modelId)).modelId || null, mode);
      return { ok: true, mode };
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  });

  // ── Runs ──

  const emitChatStreamError = (payload: ChatStreamErrorPayload): void => {
    sendToRenderer('chat:ai-stream-error', payload);
  };

  const clearActiveRun = (run: ActiveRun | null): void => {
    if (!run) return;
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
    if (!run) return;
    try {
      await run.session.abort();
    } catch {
      // Ignore abort races.
    }
    clearActiveRun(run);
  };

  // ── Models ──

  const resolveModel = async (endpoint: GatewayEndpoint, modelId: string): Promise<ResolvedChatModel> => {
    try {
      const entries = await fetchGatewayModelEntries(endpoint);
      lastEntries = entries;
      // A pinned `peer@model` is described by its model's entry.
      const { modelId: listedId } = splitPinnedModel(modelId);
      const entry = entries.find((candidate) => candidate.id === listedId);
      return { model: entry ? toChatModel(entry) : null, offers: entryOffers(entry) };
    } catch (error) {
      appendSystemLog(`Gateway model list unavailable; sending "${modelId}" as a plain chat model: ${asErrorMessage(error)}`);
      return { model: null, offers: [] };
    }
  };

  const modelTelemetryContext = (requested: string): TelemetryEventProperties['model_selected'] => {
    const { modelId, peerId } = splitPinnedModel(requested);
    const entry = lastEntries.find((candidate) => candidate.id === modelId);
    const pricing = modelPricingSnapshot(entryOffers(entry));
    return {
      public_model_id: publicModelId(modelId, entry !== undefined),
      service_category: classifyServiceCategory(modelId),
      route_mode: peerId ? 'pinned' : 'auto',
      pricing_tier: pricing.pricingTier,
      has_free_eligible_offer: pricing.hasFreeEligibleOffer,
      eligible_offer_count_bucket: pricing.eligibleOfferCountBucket,
    };
  };

  const recordModelSelection = (modelId: string): void => {
    if (!recordModelSelected) return;
    try {
      void Promise.resolve(recordModelSelected(modelTelemetryContext(modelId), JSON.stringify([splitPinnedModel(modelId).modelId.toLowerCase()])))
        .catch(() => {});
    } catch {
      // Telemetry must never affect model selection.
    }
  };

  ipcMain.handle('chat:list-models', async (_event, payload: { force?: unknown } | undefined) => {
    const startedAt = Date.now();
    try {
      const endpoint = await getGatewayEndpoint();
      const entries = await fetchGatewayModelEntries(endpoint, { force: payload?.force === true });
      lastEntries = entries;
      // Every model, the ones the apps leave out marked: the picker lists the
      // apps' set and still finds a chat's model among the rest.
      const models: ChatModel[] = toTrustedChatModels(entries, { teeOnly: currentPrivacyMode() === 'private' });
      return { ok: true, data: models };
    } catch (error) {
      const message = asErrorMessage(error);
      appendSystemLog(`Chat model list failed: ${message}`);
      if (recordDiscoveryFailed) {
        try {
          void Promise.resolve(recordDiscoveryFailed({
            duration_bucket: durationBucket(Date.now() - startedAt),
            failure_code: classifyDiscoveryFailure(message),
          })).catch(() => {});
        } catch {
          // Telemetry must never replace the original failure.
        }
      }
      return { ok: false, data: [] as ChatModel[], error: message };
    }
  });

  /** Sellers for a model under this app's key and routing policy, for the seller picker. */
  ipcMain.handle('chat:route-preview', async (_event, payload: { model?: unknown; force?: unknown } | undefined) => {
    const model = normalizeServiceId(payload?.model);
    if (!model) return { ok: false, error: 'Model is required' };
    try {
      return { ok: true, data: await fetchRoutePreview(await getGatewayEndpoint(), model, { force: payload?.force === true }) };
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  });

  const sellerName = (peerId: string): string | null => {
    const wanted = peerId.toLowerCase();
    for (const entry of lastEntries) {
      const peers = Array.isArray(entry['peers']) ? entry['peers'] as Array<Record<string, unknown>> : [];
      const peer = peers.find((candidate) => String(candidate['peerId'] ?? '').toLowerCase() === wanted);
      if (typeof peer?.['displayName'] === 'string' && peer['displayName'].trim()) return peer['displayName'].trim();
    }
    return null;
  };

  const privacyGate: PrivacyGate = { whenSettled: whenPrivacySettled, mode: currentPrivacyMode };
  const runStreamingPrompt = createStreamingRunner({
    store,
    activeRunsByConversation,
    pendingRuns,
    configPath,
    sendToRenderer,
    appendSystemLog,
    getEndpoint: () => getGatewayEndpoint(),
    resolveModel,
    requestToolApproval,
    emitChatStreamError,
    clearActiveRun,
    abortAndClearActiveRun,
    sellerName,
    privacy: privacyGate,
    ...(recordFirstChatStarted ? { recordFirstChatStarted } : {}),
    ...(recordChatRequestStarted ? { recordChatRequestStarted } : {}),
    ...(recordChatRequestFinished ? { recordChatRequestFinished } : {}),
    ...(getChatSendTelemetryContext ? { getChatSendTelemetryContext } : {}),
    ...(recordPremiumBlocked ? { recordPremiumBlocked } : {}),
  });

  // ── Conversations ──

  ipcMain.handle('chat:ai-list-conversations', async () => {
    const [summaries, flags] = await Promise.all([store.list(), organization.read()]);
    const data = await Promise.all(summaries.map(async (summary) => {
      const gitBranch = summary.workspacePath ? await gitBranches.get(summary.workspacePath) : null;
      return { ...summary, ...flagsFor(flags, summary.id), ...(gitBranch ? { gitBranch } : {}) };
    }));
    return { ok: true, data };
  });

  ipcMain.handle('chat:ai-set-conversation-flags', async (_event, id: string, flags: ConversationFlags) => {
    try {
      const conversationId = typeof id === 'string' ? id.trim() : '';
      if (!conversationId) return { ok: false, error: 'Conversation not found' };
      const patch: ConversationFlags = {};
      if (typeof flags?.pinned === 'boolean') patch.pinned = flags.pinned;
      if (typeof flags?.archived === 'boolean') patch.archived = flags.archived;
      return { ok: true, data: await organization.setFlags(conversationId, patch) };
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  });

  ipcMain.handle('chat:ai-get-conversation', async (_event, id: string) => {
    const conversation = await store.get(id);
    if (!conversation) {
      return { ok: false, error: 'Conversation not found' };
    }
    return { ok: true, data: conversation };
  });

  ipcMain.handle('chat:ai-create-conversation', async (_event, model: unknown) => {
    const modelId = normalizeServiceId(model);
    if (!modelId) return { ok: false, error: 'Choose a model before starting a chat.' };
    try {
      return { ok: true, data: await store.create(modelId) };
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  });

  ipcMain.handle('chat:ai-set-model', async (_event, conversationId: unknown, model: unknown) => {
    const id = typeof conversationId === 'string' ? conversationId.trim() : '';
    const modelId = normalizeServiceId(model);
    if (!modelId) return { ok: false, error: 'Model is required' };
    try {
      if (id) await store.setModel(id, modelId);
      recordModelSelection(modelId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  });

  ipcMain.handle('chat:ai-delete-conversation', async (_event, id: string) => {
    await store.delete(id);
    try {
      await organization.forget(id);
    } catch (err) {
      appendSystemLog(`Failed to clear pin/archive for conversation ${id}: ${asErrorMessage(err)}`);
    }
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

  // ── Workspace ──

  ipcMain.handle('chat:ai-get-workspace', async () => {
    const workspaceDir = await loadChatWorkspaceDir();
    return { ok: true, data: { current: workspaceDir, default: CHAT_WORKSPACE_DIR } };
  });

  ipcMain.handle('chat:ai-set-workspace', async (_event, workspaceDir: string) => {
    const current = await persistChatWorkspaceDir(workspaceDir);
    return { ok: true, data: { current, default: CHAT_WORKSPACE_DIR } };
  });

  // ── Attachments, images, sends ──

  ipcMain.handle('chat:prepare-attachments', async (_event, conversationId: string, attachments: RawChatAttachment[]) => {
    try {
      const trimmedId = typeof conversationId === 'string' ? conversationId.trim() : '';
      // Guard the filesystem boundary: only run the disk-backed storage
      // path when the renderer supplied a conversationId we can vouch for.
      // Otherwise fall back to the pure-prepare behaviour — the LLM
      // pipeline still works, we just can't offer native previews.
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
      ? payload as { conversationId?: unknown; prompt?: unknown; model?: unknown; moderation?: unknown; sourceImageAttachmentId?: unknown; requirePrivate?: unknown; allowPrivateHistory?: unknown }
      : {};
    const conversationId = typeof request.conversationId === 'string' ? request.conversationId.trim() : '';
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
    const moderation = request.moderation === 'auto' || request.moderation === 'low'
      ? request.moderation
      : undefined;
    const service = normalizeServiceId(request.model);
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
      // An image goes out under whichever policy the switch settles on, like a text send.
      // An image edit sends an earlier image of the chat, so its history counts too.
      const mustBePrivate = requiresPrivate(
        { requirePrivate: request.requirePrivate === true, allowPrivateHistory: request.allowPrivateHistory === true },
        (await store.get(conversationId))?.messages ?? [],
      );
      const refused = await passPrivacyGate(privacyGate, mustBePrivate);
      if (refused) return { ok: false, error: refused };
      const requireTee = mustBePrivate || currentPrivacyMode() === 'private';
      const endpoint = { ...await getGatewayEndpoint(), ...(requireTee ? { requireTee } : {}) };
      return await generateChatImage(store, endpoint, {
        conversationId,
        prompt,
        ...(moderation ? { moderation } : {}),
        service,
        ...(sourceImageAttachmentId ? { sourceImageAttachmentId } : {}),
      }, { signal: controller.signal, sellerName, privacyMode: currentPrivacyMode });
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    } finally {
      if (activeImageRunsByConversation.get(conversationId) === controller) {
        activeImageRunsByConversation.delete(conversationId);
      }
    }
  });

  ipcMain.handle('chat:ai-send-stream', sendStreamHandler(runStreamingPrompt));

  const abortConversations = async (conversationId?: string): Promise<void> => {
    const trimmedConversationId = typeof conversationId === 'string' ? conversationId.trim() : '';
    const activeRuns = trimmedConversationId
      ? [activeRunsByConversation.get(trimmedConversationId)].filter((run): run is ActiveRun => Boolean(run))
      : Array.from(activeRunsByConversation.values());
    const imageRuns = trimmedConversationId
      ? [activeImageRunsByConversation.get(trimmedConversationId)].filter((run): run is AbortController => Boolean(run))
      : Array.from(activeImageRunsByConversation.values());
    for (const controller of imageRuns) controller.abort();
    pendingRuns.abort(trimmedConversationId || undefined);
    await Promise.all(activeRuns.map((run) => abortAndClearActiveRun(run)));
  };

  ipcMain.handle('chat:ai-abort', async (_event, conversationId?: string) => {
    await abortConversations(conversationId);
    return { ok: true };
  });

  ipcMain.handle('telemetry:first-model-shown', (_event, payload: unknown) => {
    const signal = payload as Partial<FirstModelShownSignal> | null;
    const service = typeof signal?.service === 'string' ? signal.service.trim() : '';
    if (!service || !recordFirstModelShown) return { ok: false };
    try {
      void Promise.resolve(recordFirstModelShown(modelTelemetryContext(service))).catch(() => {});
    } catch {
      // Telemetry must never affect model rendering.
    }
    return { ok: true };
  });

  return {
    invalidateModelCatalog: () => {
      clearGatewayModelCache();
      lastEntries = [];
    },
    createConversation: (model) => store.create(model),
    hasConversation: async (conversationId) => (await store.get(conversationId)) !== null,
    setConversationModel: (conversationId, model) => store.setModel(conversationId, model),
    getConversationModel: async (conversationId) => (await store.get(conversationId))?.service || null,
    sendMessageStream: async (conversationId, userMessage) => runStreamingPrompt(conversationId, userMessage),
    abort: abortConversations,
    resolveToolApproval,
    listModels: async () => {
      // Not the minute-long cache: the list narrows the moment Private turns on.
      await whenPrivacySettled();
      const entries = await fetchGatewayModelEntries(await getGatewayEndpoint(), { force: true });
      lastEntries = entries;
      // Trusted sellers' models first, so a default lands on one; the rest still resolve a saved pick.
      return recommendAppModels(toTrustedChatModels(entries, { teeOnly: currentPrivacyMode() === 'private' }));
    },
  };
}
