/**
 * One turn of the chat agent: prompt in, streamed assistant reply out.
 *
 * Split out of `engine.ts` because it is by far the largest piece of
 * `registerPiChatHandlers` and has a wide blast radius — proxy readiness,
 * peer binding, tool approval, payment-required handling and session
 * persistence all interleave here. The context object below is the complete
 * set of engine state this run touches; nothing else is reachable from it.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AgentSessionEvent, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import type { AssistantMessage, AssistantMessageEvent, Message } from '@mariozechner/pi-ai';
import { createBrowserPreviewTool, createStartDevServerTool } from './dev-tools.js';
import { webFetchTool } from './web-fetch.js';
import { buildVprSystemPrompt } from './system-prompt.js';
import {
  classifyChatStreamFailure,
  formatChatStreamStopForLog,
  type ChatStreamStopReason,
} from './stream-stop.js';
import {
  allowToolForPeer,
  getPeerPermissionMode,
  isToolAllowedForPeer,
  normalizePermissionMode,
  type ChatPermissionMode,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from './permissions.js';
import {
  describeToolApproval,
  isToolPermissionAutoAllowed,
  requiresToolApproval,
} from './tool-policy.js';
import {
  buildAttachmentPromptText,
  extractAttachmentImages,
  type PreparedChatAttachment,
} from './attachments/prepare.js';
import { getCurrentChatWorkspaceDir } from './workspace.js';
import { PROXY_PROVIDER_ID } from './provider-hint.js';
import { normalizePeerId, normalizeServiceId } from './normalize.js';
import { asErrorMessage } from '../utils.js';
import type { ChatServiceCatalogEntry, ChatServiceProtocol } from './service-catalog.js';
import {
  convertAssistantMessageForUi,
  convertUserMessageForUi,
  extractToolCallFromPartial,
  isToolArgumentsObject,
  mergeAssistantMessagesForUi,
  parseAssistantMetaFromSessionEvent,
  toToolOutputString,
} from './message-projection.js';
import {
  makeProxyService,
  fetchProxyConversationRoute,
  normalizePaymentBody,
  resolveProxyPort,
  resolveSystemPrompt,
  PROXY_RUNTIME_API_KEY,
} from './proxy-service.js';
import {
  CHAT_AGENT_DIR,
  extractPeerFromEntries,
  isPersistedPeerBindingPinned,
  PiConversationStore,
} from './conversation-store.js';
import {
  classifyServiceCategory,
  durationBucket,
  httpStatusBucket,
  modelPricingSnapshot,
  offersAvailableBucket,
  publicModelId,
  type TelemetryEventProperties,
} from '../telemetry/events.js';
import { classifyChatRequestFailure } from '../telemetry/classify.js';
import {
  generateConversationTitleWithModel,
  getMessageText,
  shouldGenerateConversationTitleForSession,
} from './conversation-title.js';
import type { AiChatMessage, AiMessageMeta } from './conversation-types.js';
import type { ActiveRun, ChatStreamErrorPayload } from './engine-types.js';

/**
 * Everything a streaming run reaches for outside its own arguments. Passing it
 * explicitly keeps the run honest about the engine state it mutates.
 */
export type StreamingRunContext = {
  store: PiConversationStore;
  activeRunsByConversation: Map<string, ActiveRun>;
  cachedPaymentRequired: Map<string, Record<string, unknown>>;
  preferredPeerByConversationId: Map<string, string>;
  configPath: string;
  sendToRenderer: (channel: string, payload: unknown) => void;
  appendSystemLog: (line: string) => void;
  isBuyerRuntimeRunning: () => boolean;
  ensureBuyerRuntimeStarted?: (() => Promise<boolean>) | undefined;
  requestToolApproval: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
  cacheFallbackPaymentRequired: (conversationId: string, suggestedAmount: string) => void;
  emitChatStreamError: (payload: ChatStreamErrorPayload) => void;
  emitPaymentRequiredStreamError: (
    conversationId: string,
    suggestedAmount: string,
  ) => ChatStreamStopReason;
  clearActiveRun: (run: ActiveRun | null) => void;
  abortAndClearActiveRun: (run: ActiveRun | null) => Promise<void>;
  isProxyAvailable: (port: number) => Promise<boolean>;
  waitForBuyerProxy: (port: number, timeoutMs?: number) => Promise<boolean>;
  resolveProtocolForSend: (serviceId: string) => Promise<ChatServiceProtocol>;
  /**
   * Read-only view of the engine's service-catalog cache. A getter, not a
   * value: the engine replaces the array wholesale on every refresh.
   */
  getServiceCatalogEntries: () => ChatServiceCatalogEntry[];
  getBuyerEligibleServiceCatalogEntries: () => ChatServiceCatalogEntry[];
  recordFirstChatStarted?: StreamingRunContextTelemetry['recordFirstChatStarted'];
  recordChatRequestStarted?: StreamingRunContextTelemetry['recordChatRequestStarted'];
  recordChatRequestFinished?: StreamingRunContextTelemetry['recordChatRequestFinished'];
};

type StreamingRunContextTelemetry = Pick<
  import('./engine-types.js').RegisterPiChatHandlersOptions,
  'recordFirstChatStarted' | 'recordChatRequestStarted' | 'recordChatRequestFinished'
>;

export type StreamingRunner = ReturnType<typeof createStreamingRunner>;

export function createStreamingRunner(ctx: StreamingRunContext) {
  const {
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
    getServiceCatalogEntries,
    getBuyerEligibleServiceCatalogEntries,
    recordFirstChatStarted,
    recordChatRequestStarted,
    recordChatRequestFinished,
  } = ctx;

  const runStreamingPrompt = async (
    conversationId: string,
    userMessage: string,
    serviceOverride?: string,
    attachments?: PreparedChatAttachment[],
    peerOverride?: string,
    permissionModeInput?: unknown,
  ): Promise<{ ok: boolean; error?: string; stopReason?: ChatStreamStopReason }> => {
    const trimmedMessage = userMessage.trim();
    const requestedPermissionMode: ChatPermissionMode | null = (
      permissionModeInput === 'manual' || permissionModeInput === 'full'
        ? normalizePermissionMode(permissionModeInput)
        : null
    );
    const attachmentPromptText = buildAttachmentPromptText(attachments);
    const attachmentImages = extractAttachmentImages(attachments);
    if (trimmedMessage.length === 0 && attachmentPromptText.length === 0 && attachmentImages.length === 0) {
      return { ok: false, error: 'Empty message' };
    }


    const existingRun = activeRunsByConversation.get(conversationId);
    if (existingRun) {
      appendSystemLog(
        `Cancelling existing in-flight chat request for conversation ${existingRun.conversationId.slice(0, 8)}...`,
      );
      await abortAndClearActiveRun(existingRun);
    }

    const proxyPort = await resolveProxyPort(configPath);
    const runtimeRunning = isBuyerRuntimeRunning();
    let proxyAvailable = await isProxyAvailable(proxyPort);
    if (!proxyAvailable && ensureBuyerRuntimeStarted) {
      if (runtimeRunning) {
        appendSystemLog(`Buyer runtime is running. Waiting for proxy :${proxyPort}...`);
      } else {
        appendSystemLog(`Buyer proxy offline on port ${proxyPort}; attempting to start Buyer runtime...`);
      }
      try {
        const started = runtimeRunning ? true : await ensureBuyerRuntimeStarted();
        if (started) {
          if (!runtimeRunning) {
            appendSystemLog(`Buyer runtime start requested. Waiting for proxy :${proxyPort}...`);
          }
          proxyAvailable = await waitForBuyerProxy(proxyPort);
        }
      } catch (error) {
        appendSystemLog(`Buyer runtime auto-start failed: ${asErrorMessage(error)}`);
      }
    }
    if (!proxyAvailable) {
      return {
        ok: false,
        error: `Buyer proxy is not reachable on port ${proxyPort}. Start Buyer runtime or fix buyer.proxyPort in config.`,
      };
    }

    const sessionManager = await store.openSessionManager(conversationId);
    if (!sessionManager) {
      return { ok: false, error: 'Conversation not found' };
    }

    const context = sessionManager.buildSessionContext();

    const serviceId = normalizeServiceId(serviceOverride || context.model?.modelId);
    const persistedPeer = extractPeerFromEntries(sessionManager);
    const peerOverrideId = normalizePeerId(peerOverride) ?? null;
    const persistedPinnedPeerId = isPersistedPeerBindingPinned(persistedPeer) ? persistedPeer.peerId : null;
    const preferredPeerId = peerOverrideId
      ?? preferredPeerByConversationId.get(conversationId)
      ?? persistedPeer?.peerId
      ?? null;
    const routeMode = peerOverrideId || persistedPinnedPeerId ? 'pinned' : 'auto';
    const persistedPermissionMode: ChatPermissionMode = preferredPeerId
      ? await getPeerPermissionMode(preferredPeerId)
      : 'manual';
    const permissionMode: ChatPermissionMode = persistedPermissionMode === 'full'
      ? 'full'
      : requestedPermissionMode ?? persistedPermissionMode;
    if (preferredPeerId) {
      preferredPeerByConversationId.set(conversationId, preferredPeerId);
      if (peerOverrideId && persistedPeer?.peerId !== peerOverrideId) {
        const peerLabel = getServiceCatalogEntries().find((entry) => entry.peerId === peerOverrideId)?.peerLabel;
        void store.setPeer(conversationId, peerOverrideId, peerLabel, 'pinned');
      }
    }
    // Catalog entry for this (service, peer) pair drives both the API
    // protocol (so we hit /v1/chat/completions vs /v1/responses vs
    // /v1/messages on the right peer) and vision-capability info. Look
    // up the peer-specific row first, then fall back to any row
    // matching the service alone if the user has no peer pinned.
    //
    // We look for a `multimodal` category tag; sellers announce this
    // via serviceCategories in their peer metadata. Absent catalog
    // info, we fall back to text-only so we never blindly forward
    // images to a model whose upstream will reject them (DeepInfra,
    // for example, returns "Multimodal is not supported for model: …"
    // for text-only LLMs).
    const normalizedServiceForCatalog = serviceId.trim().toLowerCase();
    const catalogEntry = getServiceCatalogEntries().find((entry) => (
      entry.id.trim().toLowerCase() === normalizedServiceForCatalog
      && (!preferredPeerId || entry.peerId === preferredPeerId)
    )) ?? getServiceCatalogEntries().find((entry) => (
      entry.id.trim().toLowerCase() === normalizedServiceForCatalog
    ));
    // Prefer the peer-aware protocol from the catalog entry. The global
    // serviceProtocolMap is first-write-wins per serviceId across all
    // peers, so when one peer offers a service via openai-chat-completions
    // and another via openai-responses, the map can return the wrong
    // protocol for the peer we're actually pinned to. Fall back to the
    // map only when we have no catalog row to read from.
    const advertisedProtocol = catalogEntry?.protocol;
    if (advertisedProtocol === 'openai-images') {
      return {
        ok: false,
        error: `Service "${serviceId}" generates images and cannot be used for text chat. Select a text-capable model.`,
      };
    }
    if (advertisedProtocol === 'typesafe-systemone') {
      return {
        ok: false,
        error: `Service "${serviceId}" is a decision model and cannot be used for text chat. Select a text-capable model.`,
      };
    }

    const protocol: ChatServiceProtocol = advertisedProtocol ?? await resolveProtocolForSend(serviceId);
    const supportsMultimodal = catalogEntry?.categories?.includes('multimodal') ?? false;
    const droppedImageCount = supportsMultimodal ? 0 : attachmentImages.length;
    if (droppedImageCount > 0) {
      appendSystemLog(
        `Dropping ${String(droppedImageCount)} image attachment(s): service `
        + `"${serviceId}" is not tagged \`multimodal\` in the catalog. `
        + 'Other attachment types (pdf/docs/text) are unaffected.',
      );
    }
    const effectiveAttachmentImages = supportsMultimodal ? attachmentImages : [];
    const proxyModel = makeProxyService(
      serviceId,
      proxyPort,
      protocol,
      preferredPeerId,
      null,
      supportsMultimodal,
      routeMode,
      conversationId,
    );

    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(PROXY_PROVIDER_ID, PROXY_RUNTIME_API_KEY);
    const modelRegistry = ModelRegistry.inMemory(authStorage);

    // Pass the system prompt via resourceLoader so it is applied on every turn.
    // (agent-session rebuilds _baseSystemPrompt from the loader each turn, so a
    // one-shot session.agent.setSystemPrompt call would be overridden.)
    // Priority: user override (env/config) → AI VPN default.
    const userSystemPrompt = await resolveSystemPrompt(configPath);
    const sessionWorkspaceDir = sessionManager.getCwd()?.trim();
    const chatWorkspaceDir = sessionWorkspaceDir && existsSync(sessionWorkspaceDir)
      ? sessionWorkspaceDir
      : getCurrentChatWorkspaceDir();
    if (sessionWorkspaceDir && sessionWorkspaceDir !== chatWorkspaceDir) {
      appendSystemLog(
        `Conversation workspace is no longer available: ${sessionWorkspaceDir}. `
        + `Using current workspace instead: ${chatWorkspaceDir}`,
      );
    }
    const settingsManager = SettingsManager.create(chatWorkspaceDir, CHAT_AGENT_DIR);
    const toolApprovalExtension = (pi: ExtensionAPI) => {
      pi.on('tool_call', async (event) => {
        if (!requiresToolApproval(permissionMode, event.toolName)) {
          return undefined;
        }
        const input = event.input && typeof event.input === 'object'
          ? event.input as Record<string, unknown>
          : {};
        const description = describeToolApproval(event.toolName, input, preferredPeerId);
        if (isToolPermissionAutoAllowed(description.permissionKey)) {
          return undefined;
        }
        if (await isToolAllowedForPeer(preferredPeerId, description.permissionKey)) {
          return undefined;
        }

        const peerName = preferredPeerId
          ? getServiceCatalogEntries().find((entry) => entry.peerId === preferredPeerId)?.peerLabel ?? null
          : null;
        const decision = await requestToolApproval({
          id: randomUUID(),
          conversationId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input,
          workspacePath: chatWorkspaceDir,
          peerId: preferredPeerId,
          peerName,
          ...description,
        });

        if (decision === 'always_allow_peer') {
          try {
            await allowToolForPeer(preferredPeerId, description.permissionKey);
          } catch (error) {
            appendSystemLog(`Failed to save peer-scoped tool approval rule: ${asErrorMessage(error)}`);
          }
          return undefined;
        }
        if (decision === 'allow_once') {
          return undefined;
        }
        return {
          block: true,
          reason: 'Tool execution was denied by the user.',
        };
      });
    };

    const resourceLoader = new DefaultResourceLoader({
      cwd: chatWorkspaceDir,
      agentDir: CHAT_AGENT_DIR,
      settingsManager,
      extensionFactories: [toolApprovalExtension],
      systemPrompt: buildVprSystemPrompt(userSystemPrompt, chatWorkspaceDir, permissionMode),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: chatWorkspaceDir,
      agentDir: CHAT_AGENT_DIR,
      sessionManager,
      authStorage,
      modelRegistry,
      model: proxyModel,
      customTools: [
        webFetchTool,
        createBrowserPreviewTool(sendToRenderer),
        createStartDevServerTool(sendToRenderer),
      ],
      resourceLoader,
    });

    // Activate all tools. Pi defaults to only [read, bash, edit, write] —
    // without this, other tools are missing from the API tool list, causing
    // the model to emit raw XML tool calls instead of structured tool_use.
    session.setActiveToolsByName([
      'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls',
      'web_fetch', 'open_browser_preview', 'start_dev_server',
    ]);

    await session.setModel(proxyModel);
    session.agent.sessionId = conversationId;

    const firstUserMessageText = getMessageText(session.messages.find((message) => message.role === 'user')) || trimmedMessage;
    const shouldGenerateConversationTitle = shouldGenerateConversationTitleForSession(
      session.sessionName,
      firstUserMessageText,
    );

    const turnMetaQueue: AiMessageMeta[] = [];
    const toolArgsById = new Map<string, Record<string, unknown>>();
    // Pi's native streaming handles all API formats (anthropic-messages,
    // openai-completions, openai-responses) via model.api + model.baseUrl.
    // No custom streamFn needed — the buyer proxy at model.baseUrl is a
    // transparent HTTP proxy that speaks the same API as the upstream provider.

    let turnIndex = 0;
    let userPersisted = false;
    let streamDone = false;
    let pendingAssistantMessage: AiChatMessage | null = null;
    let terminalStreamError: string | null = null;
    let terminalStreamFailure: ChatStreamStopReason | null = null;
    let paymentRequiredFailure: ChatStreamStopReason | null = null;
    let automaticRetryAttempted = false;
    let automaticRetrySucceeded = false;
    let hadPartialOutput = false;
    let telemetryFinished = false;
    const requestId = randomUUID();
    const requestStartedAt = Date.now();
    const eligibleOffersForService = getBuyerEligibleServiceCatalogEntries().filter((entry) => (
      entry.id.trim().toLowerCase() === normalizedServiceForCatalog
      && (routeMode !== 'pinned' || entry.peerId === preferredPeerId)
    ));
    const offersForService = eligibleOffersForService.length;
    const pricing = modelPricingSnapshot(eligibleOffersForService);
    const finishTelemetry = (
      outcome: TelemetryEventProperties['chat_request_finished']['outcome'],
      reason?: ChatStreamStopReason,
      rawMessage = '',
    ): void => {
      if (telemetryFinished || !recordChatRequestFinished) return;
      telemetryFinished = true;
      const failure = reason
        ? classifyChatRequestFailure(reason, rawMessage)
        : { failureCode: 'none' as const, failureStage: 'none' as const, retryable: false };
      const payload: TelemetryEventProperties['chat_request_finished'] = {
        request_id: requestId,
        outcome,
        failure_code: failure.failureCode,
        failure_stage: failure.failureStage,
        public_model_id: publicModelId(serviceId, catalogEntry !== undefined),
        service_category: classifyServiceCategory(serviceId),
        route_mode: routeMode,
        offers_available_bucket: offersAvailableBucket(offersForService),
        http_status_bucket: httpStatusBucket(failure.statusCode ?? reason?.statusCode),
        retryable: failure.failureCode === 'model_not_served_by_peer'
          ? routeMode === 'auto'
          : failure.retryable,
        automatic_retry_attempted: automaticRetryAttempted,
        automatic_retry_succeeded: automaticRetrySucceeded,
        had_partial_output: hadPartialOutput,
        duration_bucket: durationBucket(Date.now() - requestStartedAt),
        has_attachments: (attachments?.length ?? 0) > 0,
      };
      try {
        void Promise.resolve(recordChatRequestFinished(payload)).catch(() => {});
      } catch {
        // Telemetry must never affect the chat request.
      }
    };

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'turn_start') {
        sendToRenderer('chat:ai-stream-start', { conversationId, turn: turnIndex });
        turnIndex += 1;
        return;
      }

      if (event.type === 'message_update') {
        const message = event.message as Message;
        if (message.role !== 'assistant') {
          return;
        }
        const update = event.assistantMessageEvent as AssistantMessageEvent;
        if (update.type === 'text_start') {
          sendToRenderer('chat:ai-stream-block-start', {
            conversationId,
            index: update.contentIndex,
            blockType: 'text',
          });
          return;
        }
        if (update.type === 'text_delta') {
          if (update.delta.length > 0) hadPartialOutput = true;
          sendToRenderer('chat:ai-stream-delta', {
            conversationId,
            index: update.contentIndex,
            blockType: 'text',
            text: update.delta,
          });
          return;
        }
        if (update.type === 'text_end') {
          sendToRenderer('chat:ai-stream-block-stop', {
            conversationId,
            index: update.contentIndex,
            blockType: 'text',
          });
          return;
        }
        if (update.type === 'thinking_start') {
          sendToRenderer('chat:ai-stream-block-start', {
            conversationId,
            index: update.contentIndex,
            blockType: 'thinking',
          });
          return;
        }
        if (update.type === 'thinking_delta') {
          sendToRenderer('chat:ai-stream-delta', {
            conversationId,
            index: update.contentIndex,
            blockType: 'thinking',
            text: update.delta,
          });
          return;
        }
        if (update.type === 'thinking_end') {
          sendToRenderer('chat:ai-stream-block-stop', {
            conversationId,
            index: update.contentIndex,
            blockType: 'thinking',
          });
          return;
        }
        if (update.type === 'toolcall_start') {
          const tool = extractToolCallFromPartial(update.partial, update.contentIndex);
          if (isToolArgumentsObject(tool.arguments)) {
            toolArgsById.set(tool.id, tool.arguments);
          }
          sendToRenderer('chat:ai-stream-block-start', {
            conversationId,
            index: update.contentIndex,
            blockType: 'tool_use',
            toolId: tool.id,
            toolName: tool.name,
          });
          return;
        }
        if (update.type === 'toolcall_end') {
          const toolInput = isToolArgumentsObject(update.toolCall.arguments)
            ? update.toolCall.arguments
            : {};
          toolArgsById.set(update.toolCall.id, toolInput);
          sendToRenderer('chat:ai-stream-block-stop', {
            conversationId,
            index: update.contentIndex,
            blockType: 'tool_use',
            toolId: update.toolCall.id,
            toolName: update.toolCall.name,
            input: toolInput,
          });
        }
        return;
      }

      if (event.type === 'tool_execution_start') {
        const eventArgs = isToolArgumentsObject(event.args) ? event.args : undefined;
        if (eventArgs) {
          toolArgsById.set(event.toolCallId, eventArgs);
        }
        sendToRenderer('chat:ai-tool-executing', {
          conversationId,
          toolUseId: event.toolCallId,
          name: event.toolName,
          input: eventArgs ?? toolArgsById.get(event.toolCallId) ?? {},
        });
        return;
      }

      if (event.type === 'tool_execution_update') {
        const eventArgs = isToolArgumentsObject(event.args) ? event.args : undefined;
        sendToRenderer('chat:ai-tool-update', {
          conversationId,
          toolUseId: event.toolCallId,
          name: event.toolName,
          input: eventArgs ?? toolArgsById.get(event.toolCallId) ?? {},
          output: toToolOutputString(event.partialResult),
          details:
            event.partialResult &&
            typeof event.partialResult === 'object' &&
            'details' in event.partialResult &&
            event.partialResult.details &&
            typeof event.partialResult.details === 'object'
              ? (event.partialResult.details as Record<string, unknown>)
              : undefined,
        });
        return;
      }

      if (event.type === 'tool_execution_end') {
        toolArgsById.delete(event.toolCallId);
        const details =
          event.result &&
          typeof event.result === 'object' &&
          'details' in event.result &&
          event.result.details &&
          typeof event.result.details === 'object'
            ? (event.result.details as Record<string, unknown>)
            : undefined;
        sendToRenderer('chat:ai-tool-result', {
          conversationId,
          toolUseId: event.toolCallId,
          output: toToolOutputString(event.result),
          isError: Boolean(event.isError),
          details,
        });

        return;
      }

      if (event.type === 'message_end') {
        const message = event.message as Message | (AssistantMessage & { meta?: AiMessageMeta });
        if (message.role === 'user' && !userPersisted) {
          userPersisted = true;
          sendToRenderer('chat:ai-user-persisted', {
            conversationId,
            message: convertUserMessageForUi(message),
          });
          return;
        }
        if (message.role === 'assistant') {
          // Detect payment errors from the provider's 402 JSON response
          const msgAny = message as unknown as Record<string, unknown>;
          const errorMsg = typeof msgAny.errorMessage === 'string' ? msgAny.errorMessage : '';
          const rawContent = Array.isArray(msgAny.content)
            ? (msgAny.content as Array<Record<string, unknown>>).map((b) => String(b.text ?? '')).join('')
            : String(msgAny.content ?? '');

          // Check errorMessage first (Pi agent may put "402 {"error":"payment_required",...}" there)
          if (/402.*payment_required|payment_required/i.test(errorMsg) || /402.*payment_required|payment_required/i.test(rawContent)) {
            // Try to parse the full payment body from content, errorMessage, or embedded JSON
            let paymentBody: Record<string, unknown> | null = null;
            try { paymentBody = JSON.parse(rawContent) as Record<string, unknown>; } catch { /* not JSON */ }
            if (!paymentBody) {
              try { paymentBody = JSON.parse(errorMsg) as Record<string, unknown>; } catch { /* not JSON */ }
            }
            // SDK wraps the body as "402 {json}" — extract the embedded JSON
            if (!paymentBody) {
              const jsonStart = errorMsg.indexOf('{');
              if (jsonStart >= 0) {
                try { paymentBody = JSON.parse(errorMsg.slice(jsonStart)) as Record<string, unknown>; } catch { /* not JSON */ }
              }
            }
            if (paymentBody) paymentBody = normalizePaymentBody(paymentBody);
            const suggestedAmount = typeof paymentBody?.suggestedAmount === 'string'
              ? paymentBody.suggestedAmount : '100000';
            if (paymentBody?.peerId) {
              cachedPaymentRequired.set(conversationId, paymentBody);
            } else {
              cacheFallbackPaymentRequired(conversationId, suggestedAmount);
            }
            paymentRequiredFailure = emitPaymentRequiredStreamError(conversationId, suggestedAmount);
            const activeRun = activeRunsByConversation.get(conversationId);
            if (activeRun) void abortAndClearActiveRun(activeRun);
            return;
          }

          // Also check if the response body itself is a payment_required JSON
          let paymentBody: Record<string, unknown> | null = null;
          try { paymentBody = JSON.parse(rawContent) as Record<string, unknown>; } catch { /* not JSON */ }
          if (paymentBody?.error === 'payment_required') {
            paymentBody = normalizePaymentBody(paymentBody);
            const suggestedAmount = typeof paymentBody.suggestedAmount === 'string'
              ? paymentBody.suggestedAmount : '100000';
            // Cache payment info so the approve IPC handler can build the SpendingAuth
            cachedPaymentRequired.set(conversationId, paymentBody);
            paymentRequiredFailure = emitPaymentRequiredStreamError(conversationId, suggestedAmount);
            const activeRun = activeRunsByConversation.get(conversationId);
            if (activeRun) void abortAndClearActiveRun(activeRun);
            return;
          }

          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            terminalStreamError = errorMsg || rawContent || (message.stopReason === 'aborted'
              ? 'Request aborted'
              : 'The request ended unexpectedly.');
            terminalStreamFailure = classifyChatStreamFailure({
              error: message,
              message: terminalStreamError,
              stopReason: message.stopReason,
            });
            pendingAssistantMessage = null;
            return;
          }

          const proxyMeta = turnMetaQueue.shift();
          const parsedMeta = parseAssistantMetaFromSessionEvent(message, proxyMeta);
          const peerId = normalizePeerId(parsedMeta.peerId);
          if (peerId) {
            const prevPeerId = preferredPeerByConversationId.get(conversationId);
            preferredPeerByConversationId.set(conversationId, peerId);
            // Persist peer to session file if it's new or changed
            if (peerId !== prevPeerId) {
              const peerLabel = getServiceCatalogEntries().find((e) => e.peerId === peerId)?.peerLabel;
              void store.setPeer(conversationId, peerId, peerLabel);
            }
          }
          const assistantMessage = message as AssistantMessage & { meta?: AiMessageMeta };
          assistantMessage.meta = parsedMeta;
          pendingAssistantMessage = mergeAssistantMessagesForUi(
            pendingAssistantMessage,
            convertAssistantMessageForUi(assistantMessage),
          );
        }
        return;
      }

      if (event.type === 'auto_retry_start') {
        automaticRetryAttempted = true;
        const reason = classifyChatStreamFailure({
          error: event.errorMessage,
          message: event.errorMessage,
          stopReason: 'error',
        });
        appendSystemLog(
          `AI stream interrupted. Retrying in ${(event.delayMs / 1000).toFixed(1)}s `
          + `(${String(event.attempt)}/${String(event.maxAttempts)}) `
          + `[${formatChatStreamStopForLog(reason)}]`,
        );
        return;
      }

      if (event.type === 'auto_retry_end') {
        if (event.success) {
          automaticRetrySucceeded = true;
          appendSystemLog(`AI stream retry succeeded on attempt ${String(event.attempt)}.`);
        } else if (event.finalError) {
          const reason = classifyChatStreamFailure({
            error: event.finalError,
            message: event.finalError,
            stopReason: 'error',
          });
          appendSystemLog(`AI stream retry exhausted: ${formatChatStreamStopForLog(reason)}`);
        }
        return;
      }

      if (event.type === 'agent_end') {
        // Don't finalize here — auto-retry may follow with a new agent_start.
        // The post-session.prompt code handles final chat:ai-done / chat:ai-stream-done.
      }
    });

    const run: ActiveRun = { conversationId, session, unsubscribe };
    activeRunsByConversation.set(conversationId, run);

    if (recordChatRequestStarted) {
      try {
        void Promise.resolve(recordChatRequestStarted({
          request_id: requestId,
          public_model_id: publicModelId(serviceId, catalogEntry !== undefined),
          service_category: classifyServiceCategory(serviceId),
          route_mode: routeMode,
          pricing_tier: pricing.pricingTier,
          has_free_eligible_offer: pricing.hasFreeEligibleOffer,
          offers_available_bucket: pricing.eligibleOfferCountBucket,
          has_attachments: (attachments?.length ?? 0) > 0,
        })).catch(() => {});
      } catch {
        // Telemetry must never affect the chat request.
      }
    }

    // Capture only after every local preflight and session-construction step
    // succeeded. The telemetry service gates the lazy balance read and keeps it
    // off the chat critical path.
    if (recordFirstChatStarted) {
      void Promise.resolve(recordFirstChatStarted({
        serviceCategory: classifyServiceCategory(serviceId),
        hasAttachments: (attachments?.length ?? 0) > 0,
      })).catch(() => {});
    }

    try {
      const promptText = [trimmedMessage, attachmentPromptText].filter((part) => part.length > 0).join('\n\n');
      await session.prompt(promptText || ' ', { images: effectiveAttachmentImages.length > 0 ? effectiveAttachmentImages : undefined });

      if (paymentRequiredFailure !== null) {
        const paymentFailure = paymentRequiredFailure as ChatStreamStopReason;
        finishTelemetry('failed', paymentFailure);
        return { ok: false, error: 'Payment required', stopReason: paymentFailure };
      }

      if (terminalStreamFailure !== null) {
        // `terminalStreamFailure` is mutated inside the subscribe callback,
        // which TypeScript can't see — control-flow analysis narrows it to
        // `never` here. Cast back to the real type (we already guarded on
        // `!== null` above).
        const streamFailure = terminalStreamFailure as ChatStreamStopReason;
        emitChatStreamError({
          conversationId,
          error: terminalStreamError ?? streamFailure.message,
          stopReason: streamFailure,
        });
        appendSystemLog(`Pi chat error: ${formatChatStreamStopForLog(streamFailure)}`);
        finishTelemetry('failed', streamFailure, terminalStreamError ?? streamFailure.message);
        return {
          ok: false,
          error: terminalStreamError ?? streamFailure.message,
          stopReason: streamFailure,
        };
      }

      // Check if the agent received a 402 payment_required response.
      // The node returns JSON with "error":"payment_required" which the agent
      // treats as a completed turn with empty/error content.
      if (pendingAssistantMessage) {
        const lastMsg = pendingAssistantMessage as AiChatMessage;
        const c = lastMsg.content;
        const lastText = typeof c === 'string' ? c : Array.isArray(c)
          ? c.map((b) => typeof b === 'object' && b !== null && 'text' in b ? String(b.text) : '').join('')
          : '';
        let payBody: Record<string, unknown> | null = null;
        try { payBody = JSON.parse(lastText) as Record<string, unknown>; } catch { /* not JSON */ }
        if (payBody?.error === 'payment_required') {
          payBody = normalizePaymentBody(payBody);
          const amt = typeof payBody.suggestedAmount === 'string' ? payBody.suggestedAmount : '100000';
          if (payBody.peerId) {
            cachedPaymentRequired.set(conversationId, payBody);
          } else {
            cacheFallbackPaymentRequired(conversationId, amt);
          }
          pendingAssistantMessage = null;
          const reason = emitPaymentRequiredStreamError(conversationId, amt);
          finishTelemetry('failed', reason, lastText);
          return { ok: false, error: 'Payment required', stopReason: reason };
        }
      }

      const completedAssistantMessage = pendingAssistantMessage as AiChatMessage | null;
      if (completedAssistantMessage) {
        const routed = await fetchProxyConversationRoute(proxyPort, conversationId);
        if (routed?.peerId) {
          completedAssistantMessage.meta = {
            ...(completedAssistantMessage.meta ?? {}),
            peerId: routed.peerId,
            service: routed.service,
          };
          preferredPeerByConversationId.set(conversationId, routed.peerId);
          const peerLabel = getServiceCatalogEntries().find((entry) => entry.peerId === routed.peerId)?.peerLabel;
          await store.setPeer(conversationId, routed.peerId, peerLabel, routeMode);
        }
        sendToRenderer('chat:ai-done', {
          conversationId,
          message: completedAssistantMessage,
        });
        pendingAssistantMessage = null;
      }
      if (!streamDone) {
        streamDone = true;
        sendToRenderer('chat:ai-stream-done', { conversationId });
      }
      finishTelemetry('success');

      if (shouldGenerateConversationTitle) {
        try {
          let title = await generateConversationTitleWithModel({
            proxyPort,
            serviceId,
            protocol,
            peerId: preferredPeerId,
            userMessage: firstUserMessageText,
          });

          if (title) {
            session.setSessionName(title);
            sendToRenderer('chat:conversation-title-updated', { conversationId, title });
          }
        } catch (error) {
          appendSystemLog(`Conversation title generation failed: ${asErrorMessage(error)}`);
        }
      }
      return { ok: true };
    } catch (error) {
      // Always discard any buffered assistant message on error — it will not be committed.
      pendingAssistantMessage = null;
      if ((error as Error).name === 'AbortError') {
        if (paymentRequiredFailure) {
          finishTelemetry('failed', paymentRequiredFailure, asErrorMessage(error));
        }
        const reason = classifyChatStreamFailure({
          error,
          message: 'Request aborted',
          stopReason: 'aborted',
        });
        emitChatStreamError({
          conversationId,
          error: 'Request aborted',
          stopReason: reason,
        });
        if (!paymentRequiredFailure) finishTelemetry('cancelled', reason, 'Request aborted');
        return { ok: false, error: 'Aborted', stopReason: reason };
      }
      const message = asErrorMessage(error);
      // Map insufficient balance / 402 errors to payment_required format
      // so the renderer shows the Add Credits card
      const isPaymentError = /insufficient.*balance|escrow.*balance|402.*payment/i.test(message);
      if (isPaymentError) {
        // Try to extract the payment_required JSON from the error message (SDK wraps it as "402 {json}")
        let payBody: Record<string, unknown> | null = null;
        const jsonStart = message.indexOf('{');
        if (jsonStart >= 0) {
          try { payBody = JSON.parse(message.slice(jsonStart)) as Record<string, unknown>; } catch { /* not JSON */ }
        }
        if (payBody) payBody = normalizePaymentBody(payBody);
        const amt = typeof payBody?.suggestedAmount === 'string' ? payBody.suggestedAmount : '100000';
        if (payBody?.peerId) {
          cachedPaymentRequired.set(conversationId, payBody);
        } else {
          const peerId = preferredPeerByConversationId.get(conversationId) ?? '';
          cachedPaymentRequired.set(conversationId, {
            ...(payBody ?? {}),
            peerId,
            suggestedAmount: amt,
          });
        }
        const reason = emitPaymentRequiredStreamError(conversationId, amt);
        finishTelemetry('failed', reason, message);
        return { ok: false, error: message, stopReason: reason };
      } else {
        const reason = classifyChatStreamFailure({
          error,
          message,
          stopReason: 'error',
        });
        emitChatStreamError({
          conversationId,
          error: message,
          stopReason: reason,
        });
        appendSystemLog(`Pi chat error: ${formatChatStreamStopForLog(reason)}`);
        finishTelemetry('failed', reason, message);
        return { ok: false, error: message, stopReason: reason };
      }
    } finally {
      clearActiveRun(run);
      store.markPersistedIfAvailable(conversationId);
    }
  };

  return runStreamingPrompt;
}
