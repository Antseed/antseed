/**
 * Types shared between `engine.ts` and the pieces split out of it.
 *
 * They live here rather than in `engine.ts` so `streaming-run.ts` can name the
 * engine state it borrows without importing the engine back — that cycle is
 * what forced these three types out of their original home.
 */
import type { IpcMain } from 'electron';
import type { AgentSession } from '@mariozechner/pi-coding-agent';
import type { ChatStreamStopReason } from './stream-stop.js';
import type { ToolApprovalDecision } from './permissions.js';
import type { AiConversation } from './conversation-types.js';
import type { ChatModel } from './gateway-model.js';
import type {
  ServiceCategory,
  TelemetryEventProperties,
} from '../telemetry/events.js';

export type FirstChatTelemetryInput = {
  serviceCategory: ServiceCategory;
  hasAttachments: boolean;
};

export type FirstModelShownTelemetryInput = Omit<
  TelemetryEventProperties['first_model_shown'],
  'duration_bucket'
>;

export type RegisterPiChatHandlersOptions = {
  ipcMain: IpcMain;
  sendToRenderer: (channel: string, payload: unknown) => void;
  configPath: string;
  appendSystemLog: (line: string) => void;
  recordFirstChatStarted?: (input: FirstChatTelemetryInput) => void | Promise<void>;
  recordFirstModelShown?: (input: FirstModelShownTelemetryInput) => void | Promise<void>;
  recordModelSelected?: (
    input: TelemetryEventProperties['model_selected'],
    selectionKey: string,
  ) => void | Promise<void>;
  recordChatRequestStarted?: (
    input: TelemetryEventProperties['chat_request_started'],
  ) => void | Promise<void>;
  recordChatRequestFinished?: (
    input: TelemetryEventProperties['chat_request_finished'],
  ) => void | Promise<void>;
  recordDiscoveryFailed?: (
    input: TelemetryEventProperties['discovery_failed'],
  ) => void | Promise<void>;
};

export type ChatStreamErrorPayload = {
  conversationId: string;
  error: string;
  stopReason: ChatStreamStopReason;
};

/** A streaming run currently in flight for one conversation. */
export type ActiveRun = {
  conversationId: string;
  session: AgentSession;
  unsubscribe: () => void;
};

/**
 * Programmatic surface over the chat engine for non-renderer frontends (the
 * Telegram bridge). Events still flow through the sendToRenderer callback;
 * tee it into the chat event bus to observe them.
 */
export type PiChatEngine = {
  invalidateModelCatalog(): void;
  createConversation(model: string): Promise<AiConversation>;
  hasConversation(conversationId: string): Promise<boolean>;
  setConversationModel(conversationId: string, model: string): Promise<void>;
  sendMessageStream(conversationId: string, userMessage: string): Promise<{ ok: boolean; error?: string; stopReason?: ChatStreamStopReason }>;
  abort(conversationId?: string): Promise<void>;
  /** Resolves a pending tool approval; false when the id is unknown (already decided). */
  resolveToolApproval(id: string, decision: ToolApprovalDecision): boolean;
  /** Chat models the gateway can route to right now, best first: free for everyone, then able to use tools. */
  listModels(): Promise<ChatModel[]>;
};
