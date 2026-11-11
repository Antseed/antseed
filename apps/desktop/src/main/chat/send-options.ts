/**
 * What the renderer's `chat:ai-send-stream` call may set for a run, read
 * from untrusted IPC input. Kept free of Electron so the forwarding is
 * testable: the run's terminal events carry `sendId` back, and the renderer
 * drops a late one from a stopped send, so losing it here undoes that guard.
 */
import type { OutgoingPrivacy } from '../../shared/chat-gateway-types.js';
import type { PreparedChatAttachment } from './attachments/prepare.js';

export function streamOptionsFrom(options: unknown): OutgoingPrivacy {
  const given = options && typeof options === 'object'
    ? options as { requirePrivate?: unknown; allowPrivateHistory?: unknown; sendId?: unknown }
    : {};
  return {
    requirePrivate: given.requirePrivate === true,
    allowPrivateHistory: given.allowPrivateHistory === true,
    ...(Number.isSafeInteger(given.sendId) ? { sendId: given.sendId as number } : {}),
  };
}

/** The `sendId` every event of a run carries, when the send had one. */
export function sendTagOf(options: OutgoingPrivacy): { sendId?: number } {
  return typeof options.sendId === 'number' ? { sendId: options.sendId } : {};
}

/**
 * Emits a run's reply events (start, blocks, deltas, tools, reply meta) tagged
 * with its send, so the renderer drops a stopped run's late output instead of
 * adding it to a newer send's reply.
 */
export function runEventEmitter(
  sendToRenderer: (channel: string, payload: unknown) => void,
  options: OutgoingPrivacy,
): (channel: string, payload: Record<string, unknown>) => void {
  const tag = sendTagOf(options);
  return (channel, payload) => sendToRenderer(channel, { ...payload, ...tag });
}

type RunStreamingPrompt<R> = (
  conversationId: string,
  userMessage: string,
  model: string | undefined,
  attachments: PreparedChatAttachment[] | undefined,
  permissionMode: unknown,
  options: OutgoingPrivacy,
) => Promise<R>;

/** The `chat:ai-send-stream` IPC handler: the renderer's arguments, options read with `streamOptionsFrom`. */
export function sendStreamHandler<R>(run: RunStreamingPrompt<R>) {
  return async (
    _event: unknown,
    conversationId: string,
    userMessage: string,
    model?: string,
    attachments?: PreparedChatAttachment[],
    permissionMode?: unknown,
    options?: unknown,
  ): Promise<R> => run(conversationId, userMessage, model, attachments, permissionMode, streamOptionsFrom(options));
}
