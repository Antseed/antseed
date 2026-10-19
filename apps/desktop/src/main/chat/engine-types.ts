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
  isBuyerRuntimeRunning: () => boolean;
  ensureBuyerRuntimeStarted?: () => Promise<boolean>;
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
