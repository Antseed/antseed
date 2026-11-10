/**
 * One turn of the chat agent: prompt in, streamed assistant reply out.
 *
 * Every model call goes to the gateway (`getGatewayEndpoint()`) as a plain
 * API client: base URL + bearer key + model id. The gateway picks sellers and
 * pays them; the chat only surfaces its errors (a 402 becomes the calm
 * "Add funds" notice in the renderer). The context object below is the
 * complete set of engine state this run touches.
 */
import { isReplyCutOff, REPLY_CUT_OFF_MESSAGE } from './stream-stop.js';
import { trackChatRun } from './served-peer.js';
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
import {
  createChatImagePathTool,
  createChatVideoPathTool,
  createShowMediaTool,
  GET_CHAT_IMAGE_PATH_TOOL_NAME,
  GET_CHAT_VIDEO_PATH_TOOL_NAME,
  resolveBundledChatSkillPaths,
  SHOW_MEDIA_TOOL_NAME,
} from './media-tools.js';
import { buildVprSystemPrompt } from './system-prompt.js';
import {
  classifyChatStreamFailure,
  cancelFreeTierRetry,
  formatChatStreamStopForLog,
  toGatewayStopReason,
  type ChatStreamStopReason,
} from './stream-stop.js';
import {
  allowToolForModel,
  getModelPermissionMode,
  isToolAllowedForModel,
  normalizePermissionMode,
  type ChatPermissionMode,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from './permissions.js';
import {
  effectivePermissionMode,
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
import { normalizeServiceId } from './normalize.js';
import { asErrorMessage } from '../utils.js';
import {
  GATEWAY_PROVIDER_ID,
  makeGatewayModel,
  type ChatModel,
} from './gateway-model.js';
import { modelAcceptsImages, routeModeOf, splitPinnedModel } from '../../shared/pinned-model.js';
import { createGatewayBashTool } from './gateway-bash-tool.js';
import { grantShellGateway } from './gateway-shell-relay.js';
import { resolveSystemPrompt } from './system-prompt.js';
import { sessionServiceId } from './legacy-seller-pin.js';
import {
  convertAssistantMessageForUi,
  convertUserMessageForUi,
  extractToolCallFromPartial,
  isToolArgumentsObject,
  mergeAssistantMessagesForUi,
  parseAssistantMetaFromSessionEvent,
  toToolOutputString,
} from './message-projection.js';
import { CHAT_AGENT_DIR, PiConversationStore } from './conversation-store.js';
import {
  attemptCountBucket,
  classifyServiceCategory,
  durationBucket,
  httpStatusBucket,
  modelPricingSnapshot,
  offerPricingKind,
  offersAvailableBucket,
  publicModelId,
  secsSinceAppStartBucket,
  telemetryHttpStatus,
  ttftBucket,
  type TelemetryEventProperties,
} from '../telemetry/events.js';
import {
  chatFailureHttpStatus,
  classifyChatFailureReason,
  classifyChatRequestFailure,
} from '../telemetry/classify.js';
import {
  generateConversationTitleWithModel,
  getMessageText,
  shouldGenerateConversationTitleForSession,
} from './conversation-title.js';
import type { AiChatMessage, AiMessageMeta } from './conversation-types.js';
import type { ActiveRun, ChatStreamErrorPayload } from './engine-types.js';
import type { GatewayEndpoint } from '../gateway/service.js';
import { passPrivacyGate, requiresPrivate, type PrivacyGate } from './privacy-gate.js';
import type { OutgoingPrivacy } from '../../shared/chat-gateway-types.js';

/** What the engine knows about a gateway model, for one send. */
export type ResolvedChatModel = {
  /** Null when the gateway's list could not be read or does not list the id. */
  model: ChatModel | null;
  /** Seller offers the gateway reported for the model (telemetry pricing only). */
  offers: Parameters<typeof modelPricingSnapshot>[0];
};

/**
 * Everything a streaming run reaches for outside its own arguments. Passing it
 * explicitly keeps the run honest about the engine state it mutates.
 */
export type StreamingRunContext = {
  /** A seller's display name, when the model list has it. */
  sellerName: (peerId: string) => string | null;
  /** Waits out a privacy switch and says which mode a send goes out under. */
  privacy?: PrivacyGate;
  store: PiConversationStore;
  activeRunsByConversation: Map<string, ActiveRun>;
  configPath: string;
  sendToRenderer: (channel: string, payload: unknown) => void;
  appendSystemLog: (line: string) => void;
  getEndpoint: () => Promise<GatewayEndpoint>;
  resolveModel: (endpoint: GatewayEndpoint, modelId: string) => Promise<ResolvedChatModel>;
  requestToolApproval: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
  emitChatStreamError: (payload: ChatStreamErrorPayload) => void;
  clearActiveRun: (run: ActiveRun | null) => void;
  abortAndClearActiveRun: (run: ActiveRun | null) => Promise<void>;
  recordFirstChatStarted?: StreamingRunContextTelemetry['recordFirstChatStarted'];
  recordChatRequestStarted?: StreamingRunContextTelemetry['recordChatRequestStarted'];
  recordChatRequestFinished?: StreamingRunContextTelemetry['recordChatRequestFinished'];
  getChatSendTelemetryContext?: StreamingRunContextTelemetry['getChatSendTelemetryContext'];
  recordPremiumBlocked?: StreamingRunContextTelemetry['recordPremiumBlocked'];
};

type StreamingRunContextTelemetry = Pick<
  import('./engine-types.js').RegisterPiChatHandlersOptions,
  | 'recordFirstChatStarted'
  | 'recordChatRequestStarted'
  | 'recordChatRequestFinished'
  | 'getChatSendTelemetryContext'
  | 'recordPremiumBlocked'
>;

export type StreamingRunResult = { ok: boolean; error?: string; stopReason?: ChatStreamStopReason };
type StreamingRunArgs = [
  conversationId: string,
  userMessage: string,
  modelOverride?: string,
  attachments?: PreparedChatAttachment[],
  permissionModeInput?: unknown,
  options?: OutgoingPrivacy,
];
export function createStreamingRunner(ctx: StreamingRunContext) {
  const {
    store,
    activeRunsByConversation,
    configPath,
    sendToRenderer,
    appendSystemLog,
    getEndpoint,
    resolveModel,
    requestToolApproval,
    emitChatStreamError,
    clearActiveRun,
    abortAndClearActiveRun,
    recordFirstChatStarted,
    recordChatRequestStarted,
    recordChatRequestFinished,
    sellerName,
    getChatSendTelemetryContext,
    recordPremiumBlocked,
  } = ctx;

  /** Classify a failure the way a gateway client should present it. */
  const classifyGatewayFailure = (
    error: unknown,
    message: string,
    stopReason: 'error' | 'aborted',
  ): ChatStreamStopReason => toGatewayStopReason(classifyChatStreamFailure({ error, message, stopReason }), message);

  const runStreamingPromptOnce = async (
    revokers: Array<() => void>,
    conversationId: string,
    userMessage: string,
    modelOverride?: string,
    attachments?: PreparedChatAttachment[],
    permissionModeInput?: unknown,
    options: OutgoingPrivacy = {},
  ): Promise<StreamingRunResult> => {
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

    // Nothing goes out under a policy that is still changing, and a chat sent
    // in Private doesn't go out once Private is off.
    const mustBePrivate = requiresPrivate(options, (await store.get(conversationId))?.messages ?? []);
    const refused = await passPrivacyGate(ctx.privacy, mustBePrivate);
    if (refused) return { ok: false, error: refused };

    // Starts the local gateway on demand; a remote gateway without a URL or
    // key throws a readable error the renderer shows as-is.
    // A Private run asks for TEE sellers with each of its requests (follow-ups
    // and the title too), so a switch to Anonymous mid-run can't widen it.
    const protect = mustBePrivate || ctx.privacy?.mode() === 'private';
    let endpoint: GatewayEndpoint;
    try {
      endpoint = { ...await getEndpoint(), ...(protect ? { requireTee: true } : {}) };
    } catch (error) {
      const message = asErrorMessage(error);
      appendSystemLog(`Chat could not reach the gateway: ${message}`);
      return { ok: false, error: message };
    }

    let revokeShellGateway = (): void => undefined;
    const sessionManager = await store.openSessionManager(conversationId);
    if (!sessionManager) {
      return { ok: false, error: 'Conversation not found' };
    }

    const serviceId = normalizeServiceId(modelOverride) || sessionServiceId(sessionManager);
    if (!serviceId) {
      return { ok: false, error: 'Choose a model for this chat.' };
    }

    const { model: chatModel, offers } = await resolveModel(endpoint, serviceId);
    if (chatModel && chatModel.type !== 'text') {
      return {
        ok: false,
        error: `"${chatModel.label}" is a ${chatModel.type} model and cannot be used for text chat. Choose a text model.`,
      };
    }
    if (chatModel && !chatModel.protocol) {
      return { ok: false, error: `"${chatModel.label}" does not offer a chat API. Choose another model.` };
    }
    // A model the list does not describe (plain OpenAI-compatible gateway, or
    // the list failed) is spoken to over chat completions, text only.
    const protocol = chatModel?.protocol ?? 'openai-chat-completions';
    const supportsImages = chatModel ? modelAcceptsImages(chatModel, serviceId) : false;
    const modelLabel = chatModel?.label ?? serviceId;

    // Permissions belong to the model, whichever seller serves it.
    const permissionModel = splitPinnedModel(serviceId).modelId;
    const persistedPermissionMode = await getModelPermissionMode(permissionModel);
    const permissionMode: ChatPermissionMode = effectivePermissionMode(persistedPermissionMode, requestedPermissionMode);

    const droppedImageCount = supportsImages ? 0 : attachmentImages.length;
    if (droppedImageCount > 0) {
      appendSystemLog(
        `Dropping ${String(droppedImageCount)} image attachment(s): model "${serviceId}" does not accept image input. `
        + 'Other attachment types (pdf/docs/text) are unaffected.',
      );
    }
    const effectiveAttachmentImages = supportsImages ? attachmentImages : [];
    const gatewayModel = makeGatewayModel({
      modelId: serviceId,
      endpoint,
      protocol,
      supportsImages,
      conversationId,
      ...(chatModel?.contextWindow ? { contextWindow: chatModel.contextWindow } : {}),
    });

    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(GATEWAY_PROVIDER_ID, endpoint.apiKey);
    const modelRegistry = ModelRegistry.inMemory(authStorage);

    // Pass the system prompt via resourceLoader so it is applied on every turn.
    // (agent-session rebuilds _baseSystemPrompt from the loader each turn, so a
    // one-shot session.agent.setSystemPrompt call would be overridden.)
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
        const description = describeToolApproval(event.toolName, input, permissionModel);
        if (isToolPermissionAutoAllowed(description.permissionKey)) {
          return undefined;
        }
        if (await isToolAllowedForModel(permissionModel, description.permissionKey)) {
          return undefined;
        }

        const decision = await requestToolApproval({
          id: randomUUID(),
          conversationId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input,
          workspacePath: chatWorkspaceDir,
          modelId: serviceId,
          modelName: modelLabel,
          ...description,
        });

        if (decision === 'always_allow') {
          try {
            await allowToolForModel(permissionModel, description.permissionKey);
          } catch (error) {
            appendSystemLog(`Failed to save model-scoped tool approval rule: ${asErrorMessage(error)}`);
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
      additionalSkillPaths: resolveBundledChatSkillPaths(),
      extensionFactories: [toolApprovalExtension],
      systemPrompt: buildVprSystemPrompt(userSystemPrompt, chatWorkspaceDir, permissionMode),
    });
    await resourceLoader.reload();

    const shellGateway = await grantShellGateway(endpoint);
    revokeShellGateway = shellGateway.revoke;
    // Revoked however the run ends, a failure while setting up the session included.
    revokers.push(shellGateway.revoke);
    const { session } = await createAgentSession({
      cwd: chatWorkspaceDir,
      agentDir: CHAT_AGENT_DIR,
      sessionManager,
      authStorage,
      modelRegistry,
      model: gatewayModel,
      customTools: [
        // Registered under the built-in's name, so it takes that tool's place.
        createGatewayBashTool(chatWorkspaceDir, shellGateway, settingsManager.getShellCommandPrefix()),
        webFetchTool,
        createBrowserPreviewTool(sendToRenderer),
        createStartDevServerTool(sendToRenderer),
        createShowMediaTool(conversationId, chatWorkspaceDir),
        createChatImagePathTool(conversationId),
        createChatVideoPathTool(conversationId),
      ],
      resourceLoader,
    });

    // Activate all tools. Pi defaults to only [read, bash, edit, write] —
    // without this, other tools are missing from the API tool list, causing
    // the model to emit raw XML tool calls instead of structured tool_use.
    session.setActiveToolsByName([
      'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls',
      'web_fetch', 'open_browser_preview', 'start_dev_server',
      SHOW_MEDIA_TOOL_NAME, GET_CHAT_IMAGE_PATH_TOOL_NAME, GET_CHAT_VIDEO_PATH_TOOL_NAME,
    ]);

    await session.setModel(gatewayModel);
    session.agent.sessionId = conversationId;

    const firstUserMessageText = getMessageText(session.messages.find((message) => message.role === 'user')) || trimmedMessage;
    const shouldGenerateConversationTitle = shouldGenerateConversationTitleForSession(
      session.sessionName,
      firstUserMessageText,
    );

    let finalAssistantCreatedAt: number | undefined;
    let replyCutOff = false;
    let servedPeer: { peerId: string; peerName?: string } | null = null;
    // Read after the gate waited for any privacy switch to settle.
    const sentUnder = ctx.privacy?.mode() ?? null;
    const routeMeta = (): AiMessageMeta => ({ ...(servedPeer ?? {}), ...(sentUnder ? { privacy: sentUnder } : {}) });
    const replyModel = splitPinnedModel(serviceId).modelId;
    const toolArgsById = new Map<string, Record<string, unknown>>();

    let turnIndex = 0;
    let userPersisted = false;
    let streamDone = false;
    let pendingAssistantMessage: AiChatMessage | null = null;
    let terminalStreamError: string | null = null;
    let terminalStreamFailure: ChatStreamStopReason | null = null;
    let automaticRetryAttempted = false;
    let automaticRetrySucceeded = false;
    let hadPartialOutput = false;
    let telemetryFinished = false;
    // Per-attempt state: an automatic retry starts a fresh attempt, so the
    // final outcome, partial-output split and TTFT describe the last attempt.
    let attemptCount = 1;
    let attemptHadOutput = false;
    let attemptStartedAt = Date.now();
    let firstTokenMs: number | null = null;
    let answeringPeerId: string | null = null;
    const requestId = randomUUID();
    const requestStartedAt = Date.now();
    const pricing = modelPricingSnapshot(offers);
    const sendContext = (() => {
      try {
        return getChatSendTelemetryContext?.() ?? null;
      } catch {
        return null;
      }
    })();
    const preferredPeerAtSend = splitPinnedModel(serviceId).peerId ?? null;
    // Counts only, never the peers themselves.
    const sellersKnown = offers.length;
    const freeSellersKnown = offers.filter((offer) => offerPricingKind(offer) === 'free').length;
    const markFirstToken = (): void => {
      attemptHadOutput = true;
      if (firstTokenMs === null) firstTokenMs = Math.max(0, Date.now() - attemptStartedAt);
    };
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
      const failureReason = reason && outcome === 'failed'
        ? classifyChatFailureReason(reason, rawMessage, {
          hadPartialOutput: attemptHadOutput,
          peersDiscoveredAtSend: sellersKnown > 0,
          sellersKnown,
          freeSellersKnown,
          ...(sendContext?.buyerBalanceZero !== undefined ? { buyerBalanceZero: sendContext.buyerBalanceZero } : {}),
        })
        : 'none' as const;
      const httpStatus = reason && outcome === 'failed'
        ? telemetryHttpStatus(chatFailureHttpStatus(reason, rawMessage))
        : undefined;
      // Which sellers the proxy tried, the seller that answered, whether it
      // fell back and their tier come from the buyer's own
      // `buyer_request_finished`, which sees every attempt; the desktop only
      // sees the ends.
      const answeredByOther = answeringPeerId !== null
        && preferredPeerAtSend !== null
        && answeringPeerId !== preferredPeerAtSend;
      const payload: TelemetryEventProperties['chat_request_finished'] = {
        request_id: requestId,
        outcome,
        failure_code: failure.failureCode,
        failure_stage: failure.failureStage,
        public_model_id: publicModelId(replyModel, chatModel !== null),
        service_category: classifyServiceCategory(replyModel),
        route_mode: routeModeOf(serviceId),
        offers_available_bucket: offersAvailableBucket(offers.length),
        http_status_bucket: httpStatusBucket(failure.statusCode ?? reason?.statusCode),
        retryable: failure.retryable,
        automatic_retry_attempted: automaticRetryAttempted,
        automatic_retry_succeeded: automaticRetrySucceeded,
        had_partial_output: hadPartialOutput,
        duration_bucket: durationBucket(Date.now() - requestStartedAt),
        has_attachments: (attachments?.length ?? 0) > 0,
        failure_reason: failureReason,
        ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
        attempt_count: attemptCountBucket(attemptCount),
        answered_by_different_seller: automaticRetryAttempted && answeredByOther,
        secs_since_app_start: secsSinceAppStartBucket(sendContext?.msSinceAppStart ?? 0),
        peers_discovered_at_send: sellersKnown > 0,
        sellers_known_bucket: offersAvailableBucket(sellersKnown),
        free_sellers_known_bucket: offersAvailableBucket(freeSellersKnown),
        ...(sendContext?.buyerBalanceZero !== undefined ? { buyer_balance_zero: sendContext.buyerBalanceZero } : {}),
        ttft_bucket: ttftBucket(firstTokenMs),
      };
      try {
        void Promise.resolve(recordChatRequestFinished(payload)).catch(() => {});
        if (failureReason === 'model_needs_paid' && recordPremiumBlocked) {
          void Promise.resolve(recordPremiumBlocked({
            public_model_id: payload.public_model_id,
            service_category: payload.service_category,
          })).catch(() => {});
        }
      } catch {
        // Telemetry must never affect the chat request.
      }
    };

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'turn_start') {
        sendToRenderer('chat:ai-stream-start', { conversationId, turn: turnIndex });
        sendToRenderer('chat:ai-reply-meta', { conversationId, meta: { service: replyModel, ...routeMeta() } });
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
          if (update.delta.length > 0) {
            hadPartialOutput = true;
            markFirstToken();
          }
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
          if (update.delta.length > 0) markFirstToken();
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
          markFirstToken();
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
          // Before it's saved, so a reply that was stopped still names its seller when reopened.
          (message as AssistantMessage & { meta?: AiMessageMeta }).meta = routeMeta();
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            const errorMessage = typeof message.errorMessage === 'string' ? message.errorMessage : '';
            const rawContent = Array.isArray(message.content)
              ? message.content.map((block) => ('text' in block ? String(block.text ?? '') : '')).join('')
              : '';
            terminalStreamError = errorMessage || rawContent || (message.stopReason === 'aborted'
              ? 'Request aborted'
              : 'The request ended unexpectedly.');
            terminalStreamFailure = classifyGatewayFailure(message, terminalStreamError, message.stopReason);
            pendingAssistantMessage = null;
            return;
          }

          const assistantMessage = message as AssistantMessage & { meta?: AiMessageMeta };
          finalAssistantCreatedAt = assistantMessage.timestamp;
          replyCutOff = isReplyCutOff(assistantMessage);
          assistantMessage.meta = { ...parseAssistantMetaFromSessionEvent(message, undefined), ...routeMeta() };
          pendingAssistantMessage = mergeAssistantMessagesForUi(
            pendingAssistantMessage,
            convertAssistantMessageForUi(assistantMessage),
          );
        }
        return;
      }

      if (event.type === 'auto_retry_start') {
        const reason = classifyGatewayFailure(event.errorMessage, event.errorMessage, 'error');
        // Neither an exhausted free tier nor an empty balance clears on retry.
        if (cancelFreeTierRetry(reason, session)) {
          appendSystemLog(`AI stream stopped without retrying [${formatChatStreamStopForLog(reason)}]`);
          return;
        }
        automaticRetryAttempted = true;
        // Telemetry-only per-attempt state. The failed attempt's terminal
        // error is deliberately kept: what the user sees after a retry is
        // unchanged here (see automatic_retry_succeeded on the finished event).
        attemptCount += 1;
        attemptHadOutput = false;
        firstTokenMs = null;
        attemptStartedAt = Date.now() + Math.max(0, event.delayMs);
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
          const reason = classifyGatewayFailure(event.finalError, event.finalError, 'error');
          appendSystemLog(`AI stream retry exhausted: ${formatChatStreamStopForLog(reason)}`);
        }
      }
    });

    const run: ActiveRun = { conversationId, session, unsubscribe };
    activeRunsByConversation.set(conversationId, run);

    if (recordChatRequestStarted) {
      try {
        void Promise.resolve(recordChatRequestStarted({
          request_id: requestId,
          public_model_id: publicModelId(replyModel, chatModel !== null),
          service_category: classifyServiceCategory(replyModel),
          route_mode: routeModeOf(serviceId),
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
      const chatRun = trackChatRun((peerId) => {
        const peerName = sellerName(peerId);
        servedPeer = { peerId, ...(peerName ? { peerName } : {}) };
        answeringPeerId = peerId;
        sendToRenderer('chat:ai-reply-meta', { conversationId, meta: { service: replyModel, ...routeMeta() } });
      }, () => session.prompt(promptText || ' ', { images: effectiveAttachmentImages.length > 0 ? effectiveAttachmentImages : undefined }));
      await chatRun.result;
      // No tokens counted is the sign, but some sellers never report them, so the stream decides.
      if (replyCutOff) replyCutOff = !(await chatRun.lastStreamEnded());

      if (terminalStreamFailure !== null) {
        // Mutated inside the subscribe callback, which TypeScript can't see —
        // control-flow analysis narrows it to `never` here.
        const streamFailure = terminalStreamFailure as ChatStreamStopReason;
        const errorText = streamFailure.kind === 'payment_required'
          ? streamFailure.message
          : terminalStreamError ?? streamFailure.message;
        emitChatStreamError({ conversationId, error: errorText, stopReason: streamFailure });
        appendSystemLog(`Pi chat error: ${formatChatStreamStopForLog(streamFailure)}`);
        finishTelemetry(streamFailure.kind === 'aborted' ? 'cancelled' : 'failed', streamFailure, terminalStreamError ?? streamFailure.message);
        return { ok: false, error: errorText, stopReason: streamFailure };
      }

      const completedAssistantMessage = pendingAssistantMessage as AiChatMessage | null;
      if (completedAssistantMessage) {
        if (finalAssistantCreatedAt && !completedAssistantMessage.createdAt) {
          completedAssistantMessage.createdAt = finalAssistantCreatedAt;
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
      // After done, which clears notes.
      if (replyCutOff) {
        emitChatStreamError({
          conversationId,
          error: REPLY_CUT_OFF_MESSAGE,
          stopReason: { kind: 'network_error', source: 'transport', retryable: true, message: REPLY_CUT_OFF_MESSAGE },
        });
      }
      finishTelemetry('success');

      if (shouldGenerateConversationTitle) {
        try {
          const title = await generateConversationTitleWithModel({
            endpoint,
            serviceId,
            protocol,
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
        const reason = classifyChatStreamFailure({ error, message: 'Request aborted', stopReason: 'aborted' });
        emitChatStreamError({ conversationId, error: 'Request aborted', stopReason: reason });
        finishTelemetry('cancelled', reason, 'Request aborted');
        return { ok: false, error: 'Aborted', stopReason: reason };
      }
      const message = asErrorMessage(error);
      const reason = classifyGatewayFailure(error, message, 'error');
      const errorText = reason.kind === 'payment_required' ? reason.message : message;
      emitChatStreamError({ conversationId, error: errorText, stopReason: reason });
      appendSystemLog(`Pi chat error: ${formatChatStreamStopForLog(reason)}`);
      finishTelemetry('failed', reason, message);
      return { ok: false, error: errorText, stopReason: reason };
    } finally {
      revokeShellGateway();
      clearActiveRun(run);
      store.markPersistedIfAvailable(conversationId);
    }
  };

  const runStreamingPrompt = async (...args: StreamingRunArgs): Promise<StreamingRunResult> => {
    const revokers: Array<() => void> = [];
    try {
      return await runStreamingPromptOnce(revokers, ...args);
    } finally {
      for (const revoke of revokers) revoke();
    }
  };

  return runStreamingPrompt;
}
