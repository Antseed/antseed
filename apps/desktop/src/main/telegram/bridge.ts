// ── Telegram bridge ──
// Runs the user's personal Telegram bot against the local pi chat engine.
// Long-polls getUpdates (works behind NAT, no webhook), maps the owner's
// private chat onto pi conversations, streams replies via sendMessageDraft
// and finalizes them with sendMessage. Tool approvals surface as inline
// keyboards; whichever surface (desktop dialog or Telegram) decides first
// wins via PiChatEngine.resolveToolApproval.

import { splitPinnedModel } from '../../shared/pinned-model.js';
import { randomBytes } from 'node:crypto';
import { onChatEvents } from '../chat/event-bus.js';
import type { ChatStreamStopReason } from '../chat/stream-stop.js';
import type { ToolApprovalRequest } from '../chat/permissions.js';
import type { PiChatEngine } from '../chat/engine-types.js';
import {
  createTelegramBotClient,
  splitTelegramMessage,
  TelegramApiError,
  type TelegramBotClient,
  type TgCallbackQuery,
  type TgMessage,
  type TgReplyMarkup,
} from './bot-api.js';
import { markdownToTelegramHtml } from './markdown.js';
import {
  clearTelegramSettings,
  loadTelegramSettings,
  saveTelegramSettings,
  type TelegramSettings,
} from './store.js';
import { asErrorMessage } from '../utils.js';
import { TurnSlot } from './turn-slot.js';

function telegramModelPickerText(hasModels: boolean): string {
  return hasModels
    ? 'Pick a model. It applies to this chat and to new ones here:'
    : 'No models available yet. Try again in a moment.';
}

export type TelegramBridgeStatus = {
  configured: boolean;
  running: boolean;
  botUsername: string | null;
  paired: boolean;
  ownerName: string | null;
  /** t.me deep link the owner opens to pair; null once paired. */
  pairingLink: string | null;
  lastError: string | null;
};

export type TelegramBridge = {
  /** Resumes a previously configured bot on app launch. */
  start(): Promise<void>;
  connect(botToken: string): Promise<{ ok: boolean; status: TelegramBridgeStatus; error?: string }>;
  /** Stops polling and forgets the bot entirely. */
  disconnect(): Promise<void>;
  /** Sends a best-effort "going offline" notice, then stops polling but keeps settings (app quit). */
  stop(): Promise<void>;
  getStatus(): TelegramBridgeStatus;
};

export type TelegramBridgeOptions = {
  engine: PiChatEngine;
  appendLog: (line: string) => void;
  onStatusChanged?: (status: TelegramBridgeStatus) => void;
};

const OFFLINE_NOTE = 'I can only answer while your computer is on and Antseed Desktop is open.';
/** Cap on the best-effort goodbye send so a slow network can never delay quit. */
const GOODBYE_TIMEOUT_MS = 3_000;

const DRAFT_THROTTLE_MS = 900;
const POLL_BACKOFF_MIN_MS = 1_000;
const POLL_BACKOFF_MAX_MS = 30_000;
/** Telegram hard message limit; drafts share it. */
const TG_TEXT_LIMIT = 4096;

const WELCOME_TEXT = [
  'Connected to Antseed Desktop. Messages here run on the agent on your computer.',
  OFFLINE_NOTE,
  '',
  '/new — start a fresh conversation',
  '/model — choose which model answers',
  '/stop — cancel the reply in progress',
].join('\n');

/** Inline keyboards get unwieldy past this. Sized for the app's dropdown:
 *  starred favorites plus the ~12-slot recommended lineup. */
const MODEL_PICK_LIMIT = 24;

const BOT_COMMANDS = [
  { command: 'new', description: 'Start a fresh conversation' },
  { command: 'model', description: 'Choose which model answers' },
  { command: 'stop', description: 'Cancel the reply in progress' },
];

type ActiveTurn = {
  /** Empty until the chat is looked up: the turn holds the slot from the moment its message arrives. */
  conversationId: string;
  /** Set by /stop or /new, or when the bridge stops: the turn must not send. */
  cancelled: boolean;
  chatId: number;
  draftId: number;
  buffer: string;
  lastDraftAt: number;
  draftTimer: ReturnType<typeof setTimeout> | null;
  draftInFlight: boolean;
  /** Set when the final message was already delivered from chat:ai-done. */
  finalized: boolean;
  /** "Thinking…" / "⚙️ bash…" line shown while there is no text to stream. */
  statusText: string | null;
  /** Re-sends the draft every few seconds so the ~30s preview never expires. */
  keepAliveTimer: ReturnType<typeof setInterval> | null;
};

type PendingApproval = {
  chatId: number;
  messageId: number;
  title: string;
};

function newPairingCode(): string {
  // start payloads allow [A-Za-z0-9_-]; base64url of 9 bytes fits comfortably.
  return randomBytes(9).toString('base64url');
}

function pairingLinkFor(settings: TelegramSettings): string | null {
  if (settings.ownerChatId != null || !settings.pairingCode || !settings.botUsername) return null;
  return `https://t.me/${settings.botUsername}?start=${settings.pairingCode}`;
}

function extractTextFromUiMessage(payload: unknown): string {
  const message = (payload as { message?: { content?: unknown } } | null)?.message;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => (
      !!block && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map((block) => block.text)
    .join('');
}

function describeStreamError(error: string, stopReason?: ChatStreamStopReason): string {
  if (stopReason?.kind === 'payment_required' || /payment_required/i.test(error)) {
    return 'Payment required — open Antseed Desktop to add funds, then send your message again.';
  }
  if (stopReason?.kind === 'aborted' || /aborted/i.test(error)) {
    return 'Stopped.';
  }
  return `Something went wrong: ${error}`;
}

export function createTelegramBridge({ engine, appendLog, onStatusChanged }: TelegramBridgeOptions): TelegramBridge {
  let settings: TelegramSettings | null = null;
  let client: TelegramBotClient | null = null;
  let pollAbort: AbortController | null = null;
  let pollGeneration = 0;
  let lastError: string | null = null;
  const turnSlot = new TurnSlot<ActiveTurn>();
  let unsubscribeBus: (() => void) | null = null;
  let draftCounter = 0;
  /** Disabled for the session after the first hard sendMessageDraft failure. */
  let draftsSupported = true;
  const pendingApprovals = new Map<string, PendingApproval>();
  /** Conversations this bridge created — used to claim bus events. */
  const bridgeConversationIds = new Set<string>();
  /** Snapshot behind the /model keyboard; gen invalidates stale keyboards. */
  let modelPick: {
    gen: number;
    options: Array<{ id: string; label: string }>;
    chatId: number;
    messageId: number;
  } | null = null;
  let modelPickGen = 0;

  const log = (line: string): void => { appendLog(`[telegram] ${line}`); };

  const getStatus = (): TelegramBridgeStatus => ({
    configured: settings != null,
    running: pollAbort != null,
    botUsername: settings?.botUsername ?? null,
    paired: settings?.ownerChatId != null,
    ownerName: settings?.ownerName ?? null,
    pairingLink: settings ? pairingLinkFor(settings) : null,
    lastError,
  });

  const notifyStatus = (): void => { onStatusChanged?.(getStatus()); };

  const persistSettings = async (): Promise<void> => {
    if (!settings) return;
    try {
      await saveTelegramSettings(settings);
    } catch (err) {
      log(`Failed to persist settings: ${asErrorMessage(err)}`);
    }
  };

  const isBridgeConversation = (conversationId: unknown): conversationId is string => (
    typeof conversationId === 'string' && bridgeConversationIds.has(conversationId)
  );

  // ── Draft streaming ─────────────────────────────────────────────────

  const draftText = (turn: ActiveTurn): string => {
    let text = turn.buffer.trimStart();
    if (text.length === 0) return turn.statusText ?? '';
    if (turn.statusText) text = `${text}\n\n${turn.statusText}`;
    if (text.length <= TG_TEXT_LIMIT) return text;
    // The full reply arrives as real messages on completion; while typing,
    // keep the visible tail so the draft tracks what's being written now.
    return `…${text.slice(-(TG_TEXT_LIMIT - 1))}`;
  };

  const pushDraft = (turn: ActiveTurn): void => {
    if (!client || !draftsSupported || turn.finalized) return;
    if (turn.draftInFlight) return;
    const text = draftText(turn);
    if (text.length === 0) return;
    turn.draftInFlight = true;
    turn.lastDraftAt = Date.now();
    client.sendMessageDraft(turn.chatId, turn.draftId, text)
      .catch((err) => {
        // Drafts are cosmetic. 400/404 mean the server or chat doesn't
        // support them — stop trying; anything else is dropped silently.
        if (err instanceof TelegramApiError && (err.errorCode === 400 || err.errorCode === 404)) {
          draftsSupported = false;
          log('sendMessageDraft unsupported; falling back to plain replies.');
        }
      })
      .finally(() => { turn.draftInFlight = false; });
  };

  const scheduleDraft = (turn: ActiveTurn): void => {
    if (!draftsSupported || turn.finalized) return;
    const elapsed = Date.now() - turn.lastDraftAt;
    if (elapsed >= DRAFT_THROTTLE_MS) {
      pushDraft(turn);
      return;
    }
    if (turn.draftTimer) return;
    turn.draftTimer = setTimeout(() => {
      turn.draftTimer = null;
      pushDraft(turn);
    }, DRAFT_THROTTLE_MS - elapsed);
  };

  const clearTurn = (turn: ActiveTurn): void => {
    if (turn.draftTimer) {
      clearTimeout(turn.draftTimer);
      turn.draftTimer = null;
    }
    if (turn.keepAliveTimer) {
      clearInterval(turn.keepAliveTimer);
      turn.keepAliveTimer = null;
    }
    turnSlot.release(turn);
  };

  // ── Outbound messages ───────────────────────────────────────────────

  const sendToOwner = async (text: string, replyMarkup?: TgReplyMarkup): Promise<TgMessage | null> => {
    if (!client || settings?.ownerChatId == null) return null;
    const chatId = settings.ownerChatId;
    try {
      let last: TgMessage | null = null;
      // Split the raw markdown (with headroom for HTML entity overhead),
      // then format each chunk; a chunk whose entities Telegram rejects
      // (e.g. a code fence cut by the split) falls back to plain text.
      const parts = splitTelegramMessage(text, 4000);
      for (const [index, part] of parts.entries()) {
        const markup = replyMarkup && index === parts.length - 1 ? { replyMarkup } : {};
        try {
          last = await client.sendMessage(chatId, markdownToTelegramHtml(part), {
            ...markup,
            parseMode: 'HTML',
          });
        } catch (err) {
          if (!(err instanceof TelegramApiError && err.errorCode === 400)) throw err;
          last = await client.sendMessage(chatId, part, markup);
        }
      }
      return last;
    } catch (err) {
      log(`sendMessage failed: ${asErrorMessage(err)}`);
      return null;
    }
  };

  // ── Chat engine events ──────────────────────────────────────────────

  const handleToolApprovalRequested = (payload: ToolApprovalRequest): void => {
    if (!isBridgeConversation(payload.conversationId)) return;
    const chatId = settings?.ownerChatId;
    if (chatId == null) return;
    const detail = [payload.title, payload.subject].filter(Boolean).join('\n');
    const text = `⚙️ The agent wants to run a tool:\n\n${detail}`;
    const keyboard: TgReplyMarkup = {
      inline_keyboard: [[
        { text: 'Allow once', callback_data: `apr:a1:${payload.id}` },
        { text: 'Deny', callback_data: `apr:d:${payload.id}` },
      ], [
        { text: payload.canAlwaysAllow ? payload.alwaysAllowLabel || 'Always allow' : 'Always allow', callback_data: `apr:ap:${payload.id}` },
      ]],
    };
    void sendToOwner(text, keyboard).then((sent) => {
      if (sent) {
        pendingApprovals.set(payload.id, { chatId, messageId: sent.message_id, title: payload.title });
      }
    });
  };

  const handleToolApprovalCleared = (payload: { id?: unknown }): void => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const pending = pendingApprovals.get(id);
    if (!pending) return;
    pendingApprovals.delete(id);
    // Settled elsewhere (desktop dialog, run aborted) — collapse the keyboard.
    void client?.editMessageText(pending.chatId, pending.messageId, `⚙️ ${pending.title} — handled.`).catch(() => {});
  };

  const handleChatEvent = (channel: string, payload: unknown): void => {
    if (channel === 'chat:tool-approval-requested') {
      handleToolApprovalRequested(payload as ToolApprovalRequest);
      return;
    }
    if (channel === 'chat:tool-approval-cleared') {
      handleToolApprovalCleared(payload as { id?: unknown });
      return;
    }

    const conversationId = (payload as { conversationId?: unknown } | null)?.conversationId;
    const turn = turnSlot.current;
    if (!turn || !turn.conversationId || conversationId !== turn.conversationId) return;

    if (channel === 'chat:ai-stream-delta') {
      const delta = payload as { blockType?: unknown; text?: unknown };
      if (delta.blockType === 'text' && typeof delta.text === 'string') {
        turn.buffer += delta.text;
        turn.statusText = null;
        scheduleDraft(turn);
      }
      return;
    }

    if (channel === 'chat:ai-tool-executing') {
      const name = (payload as { name?: unknown }).name;
      turn.statusText = `⚙️ ${typeof name === 'string' ? name : 'tool'}…`;
      pushDraft(turn);
      return;
    }

    if (channel === 'chat:ai-tool-result') {
      turn.statusText = turn.buffer.trim().length > 0 ? null : 'Thinking…';
      pushDraft(turn);
      return;
    }

    if (channel === 'chat:ai-done') {
      turn.finalized = true;
      clearTurn(turn);
      const finalText = extractTextFromUiMessage(payload) || turn.buffer;
      void sendToOwner(finalText.trim().length > 0 ? finalText : 'Done (no text reply).');
      return;
    }

    if (channel === 'chat:ai-stream-error') {
      const { error, stopReason } = payload as { error?: unknown; stopReason?: ChatStreamStopReason };
      turn.finalized = true;
      clearTurn(turn);
      void sendToOwner(describeStreamError(typeof error === 'string' ? error : 'Unknown error', stopReason));
    }
  };

  // ── Inbound Telegram updates ────────────────────────────────────────

  /** The bot's own pick while it can still be routed to, else the best model that works without funds. */
  /** Pass `models` when the caller has just loaded them, so the catalog isn't fetched twice. */
  const resolveModel = async (models?: Awaited<ReturnType<PiChatEngine['listModels']>>): Promise<string | null> => {
    models ??= await engine.listModels();
    const saved = settings?.model;
    if (saved && models.some((model) => model.id === saved)) return saved;
    return models[0]?.id ?? null;
  };

  const showModelPicker = async (): Promise<void> => {
    let models: Awaited<ReturnType<PiChatEngine['listModels']>> = [];
    try {
      models = await engine.listModels();
    } catch (err) {
      log(`Could not load models for /model: ${asErrorMessage(err)}`);
    }
    const options = models.slice(0, MODEL_PICK_LIMIT).map((model) => ({ id: model.id, label: model.label || model.id }));
    if (options.length === 0) {
      void sendToOwner(telegramModelPickerText(false));
      return;
    }
    const current = await resolveModel(models).catch(() => null);
    modelPickGen += 1;
    const gen = modelPickGen;
    const keyboard: TgReplyMarkup = {
      inline_keyboard: options.map((option, index) => ([{
        text: `${option.id === current ? '✓ ' : ''}${option.label}`,
        callback_data: `mdl:${String(gen)}:${String(index)}`,
      }])),
    };
    const sent = await sendToOwner(telegramModelPickerText(true), keyboard);
    if (sent && settings?.ownerChatId != null) {
      modelPick = { gen, options, chatId: settings.ownerChatId, messageId: sent.message_id };
    }
  };

  const handleModelPick = async (query: TgCallbackQuery, gen: number, index: number): Promise<void> => {
    if (!client) return;
    const pick = modelPick;
    const option = pick?.gen === gen ? pick.options[index] : undefined;
    if (!pick || !option) {
      await client.answerCallbackQuery(query.id, 'Expired. Send /model again.').catch(() => {});
      return;
    }
    modelPick = null;
    const conversationId = settings?.activeConversationId;
    if (settings) {
      settings.model = option.id;
      await persistSettings();
    }
    if (conversationId) {
      await engine.setConversationModel(conversationId, option.id).catch((err: unknown) => {
        log(`Conversation model update after /model failed: ${asErrorMessage(err)}`);
      });
    }
    await client.answerCallbackQuery(query.id, 'Model set').catch(() => {});
    await client.editMessageText(pick.chatId, pick.messageId, `Model: ${option.label}`).catch(() => {});
  };

  /** Private may have narrowed the list since this chat's model was chosen; its messages would all fail. */
  const moveOffUnlistedModel = async (conversationId: string): Promise<void> => {
    const current = await engine.getConversationModel(conversationId);
    if (!current) return;
    const models = await engine.listModels();
    const { modelId } = splitPinnedModel(current);
    if (models.length === 0 || models.some((model) => model.id === modelId)) return;
    const next = await resolveModel(models);
    if (!next) return;
    await engine.setConversationModel(conversationId, next);
    const label = models.find((model) => model.id === next)?.label || next;
    void sendToOwner(`${modelId} isn't available with your current privacy setting, so this chat now uses ${label}.`);
  };

  const ensureConversation = async (): Promise<string> => {
    const active = settings?.activeConversationId;
    // The chat may have been deleted in the app since the last message.
    if (active && await engine.hasConversation(active)) {
      await moveOffUnlistedModel(active).catch((err: unknown) => {
        log(`Could not check this chat's model: ${asErrorMessage(err)}`);
      });
      bridgeConversationIds.add(active);
      return active;
    }
    const model = await resolveModel();
    if (!model) throw new Error('no models are available yet. Try again in a moment.');
    const conversation = await engine.createConversation(model);
    bridgeConversationIds.add(conversation.id);
    if (settings) {
      settings.activeConversationId = conversation.id;
      await persistSettings();
    }
    return conversation.id;
  };

  const runUserText = async (chatId: number, text: string): Promise<void> => {
    draftCounter += 1;
    const turn: ActiveTurn = {
      conversationId: '',
      cancelled: false,
      chatId,
      draftId: draftCounter,
      buffer: '',
      lastDraftAt: 0,
      draftTimer: null,
      draftInFlight: false,
      finalized: false,
      statusText: 'Thinking…',
      keepAliveTimer: null,
    };
    // Taken before the chat and its model are looked up, so a second message
    // can't start a competing turn meanwhile and /stop can cancel this one.
    if (!turnSlot.reserve(turn)) {
      void sendToOwner('Still working on the previous message — send /stop to cancel it first.');
      return;
    }
    let conversationId: string;
    try {
      conversationId = await ensureConversation();
    } catch (err) {
      if (turnSlot.owns(turn)) void sendToOwner(`Couldn't start a conversation: ${asErrorMessage(err)}`);
      clearTurn(turn);
      return;
    }
    if (!turnSlot.owns(turn)) {
      clearTurn(turn);
      return;
    }
    turn.conversationId = conversationId;
    // Show "Thinking…" right away, and keep the ephemeral draft alive while
    // the agent works without producing text (long tool calls, retries).
    pushDraft(turn);
    turn.keepAliveTimer = setInterval(() => { pushDraft(turn); }, 4_000);
    try {
      const result = await engine.sendMessageStream(conversationId, text);
      // Success and stream errors are reported through bus events; this
      // fallback only covers early returns that never started a stream
      // (e.g. gateway unreachable).
      if (!result.ok && !turn.finalized) {
        turn.finalized = true;
        void sendToOwner(describeStreamError(result.error ?? 'Unknown error', result.stopReason));
      }
    } catch (err) {
      if (!turn.finalized) {
        turn.finalized = true;
        void sendToOwner(`Something went wrong: ${asErrorMessage(err)}`);
      }
    } finally {
      clearTurn(turn);
    }
  };

  const handlePairingAttempt = async (message: TgMessage): Promise<void> => {
    if (!settings) return;
    const text = message.text?.trim() ?? '';
    const payload = text.startsWith('/start') ? text.slice('/start'.length).trim() : '';
    if (settings.pairingCode && payload === settings.pairingCode) {
      const from = message.from;
      settings.ownerChatId = message.chat.id;
      settings.ownerName = from ? [from.first_name, from.last_name].filter(Boolean).join(' ') : null;
      settings.pairingCode = null;
      await persistSettings();
      log(`Paired with ${settings.ownerName ?? 'owner'} (chat ${String(message.chat.id)}).`);
      notifyStatus();
      void sendToOwner(WELCOME_TEXT);
      return;
    }
    // Never respond with anything useful to strangers poking an unpaired bot.
    try {
      await client?.sendMessage(message.chat.id, 'This bot is not paired. Pair it from Antseed Desktop on your computer.');
    } catch {
      // Ignore.
    }
  };

  const handleOwnerMessage = async (message: TgMessage): Promise<void> => {
    const text = message.text?.trim() ?? '';
    if (text.length === 0) {
      void sendToOwner('Only text messages are supported for now.');
      return;
    }
    if (text.startsWith('/start')) {
      void sendToOwner(WELCOME_TEXT);
      return;
    }
    if (text === '/new') {
      const turn = turnSlot.cancel();
      if (turn) {
        clearTurn(turn);
        if (turn.conversationId) await engine.abort(turn.conversationId).catch(() => {});
      }
      if (settings) {
        settings.activeConversationId = null;
        await persistSettings();
      }
      void sendToOwner(`Fresh conversation — send your next message.\n${OFFLINE_NOTE}`);
      return;
    }
    if (text === '/model') {
      await showModelPicker();
      return;
    }
    if (text === '/stop') {
      const turn = turnSlot.current;
      if (!turn) {
        void sendToOwner('Nothing is running.');
        return;
      }
      // Still being set up: nothing was sent, so it just doesn't go.
      if (!turn.conversationId) {
        turnSlot.cancel();
        clearTurn(turn);
        void sendToOwner('Stopped.');
        return;
      }
      await engine.abort(turn.conversationId).catch(() => {});
      return;
    }
    // Deliberately not awaited: replies stream in the background while the
    // poll loop stays free for /stop and approval callbacks.
    void runUserText(message.chat.id, text);
  };

  const handleCallbackQuery = async (query: TgCallbackQuery): Promise<void> => {
    if (!client) return;
    if (settings?.ownerChatId == null || query.from.id !== settings.ownerChatId) {
      await client.answerCallbackQuery(query.id).catch(() => {});
      return;
    }
    const modelMatch = /^mdl:(\d+):(\d+)$/.exec(query.data ?? '');
    if (modelMatch) {
      await handleModelPick(query, Number(modelMatch[1]), Number(modelMatch[2]));
      return;
    }
    const match = /^apr:(a1|ap|d):(.+)$/.exec(query.data ?? '');
    const decisionCode = match?.[1];
    const approvalId = match?.[2];
    if (!decisionCode || !approvalId) {
      await client.answerCallbackQuery(query.id).catch(() => {});
      return;
    }
    const decision = decisionCode === 'a1' ? 'allow_once' : decisionCode === 'ap' ? 'always_allow' : 'deny';
    const pending = pendingApprovals.get(approvalId);
    pendingApprovals.delete(approvalId);
    const resolved = engine.resolveToolApproval(approvalId, decision);
    await client.answerCallbackQuery(
      query.id,
      resolved ? (decision === 'deny' ? 'Denied' : 'Approved') : 'Already handled',
    ).catch(() => {});
    if (pending) {
      const label = decision === 'deny' ? 'denied' : decision === 'allow_once' ? 'allowed once' : 'always allowed';
      await client.editMessageText(pending.chatId, pending.messageId, `⚙️ ${pending.title} — ${label}.`).catch(() => {});
    }
  };

  const handleUpdateMessage = async (message: TgMessage): Promise<void> => {
    if (message.chat.type !== 'private') return;
    if (message.from?.is_bot) return;
    if (!settings) return;
    if (settings.ownerChatId == null) {
      await handlePairingAttempt(message);
      return;
    }
    if (message.chat.id !== settings.ownerChatId) {
      // Hard rule: the bridge serves exactly one chat — the owner's.
      return;
    }
    await handleOwnerMessage(message);
  };

  // ── Poll loop ───────────────────────────────────────────────────────

  const pollLoop = async (generation: number, signal: AbortSignal): Promise<void> => {
    let backoffMs = POLL_BACKOFF_MIN_MS;
    // On a fresh connect (no acknowledged update id) skip the bot's backlog:
    // offset=-1 acks everything older than the most recent update.
    let drainBacklog = settings?.lastUpdateId == null;
    while (!signal.aborted && pollGeneration === generation && client && settings) {
      try {
        const offset = drainBacklog
          ? -1
          : settings.lastUpdateId != null ? settings.lastUpdateId + 1 : undefined;
        // The drain pass must not long-poll: timeout 0 returns only what is
        // already queued, so a live message arriving right after connect is
        // never mistaken for backlog and swallowed.
        const updates = await client.getUpdates(offset, signal, drainBacklog ? 0 : undefined);
        if (signal.aborted || pollGeneration !== generation) return;
        backoffMs = POLL_BACKOFF_MIN_MS;
        if (updates.length > 0) {
          const maxId = Math.max(...updates.map((u) => u.update_id));
          const stale = drainBacklog;
          settings.lastUpdateId = maxId;
          await persistSettings();
          if (!stale) {
            for (const update of updates) {
              try {
                if (update.message) await handleUpdateMessage(update.message);
                else if (update.callback_query) await handleCallbackQuery(update.callback_query);
              } catch (err) {
                log(`Update handling failed: ${asErrorMessage(err)}`);
              }
            }
          }
        }
        drainBacklog = false;
        if (lastError) {
          lastError = null;
          notifyStatus();
        }
      } catch (err) {
        if (signal.aborted || pollGeneration !== generation) return;
        const isConflict = err instanceof TelegramApiError && err.errorCode === 409;
        lastError = isConflict
          ? 'Another process is polling this bot (409). Stop it or reconnect.'
          : asErrorMessage(err);
        notifyStatus();
        const retryAfter = err instanceof TelegramApiError && err.retryAfterS
          ? err.retryAfterS * 1000
          : backoffMs;
        backoffMs = Math.min(backoffMs * 2, POLL_BACKOFF_MAX_MS);
        await new Promise((resolve) => setTimeout(resolve, retryAfter));
      }
    }
  };

  const startPolling = (): void => {
    stopPolling();
    if (!client || !settings) return;
    pollGeneration += 1;
    const abort = new AbortController();
    pollAbort = abort;
    if (!unsubscribeBus) unsubscribeBus = onChatEvents(handleChatEvent);
    void pollLoop(pollGeneration, abort.signal).finally(() => {
      if (pollAbort === abort) pollAbort = null;
    });
    notifyStatus();
  };

  const stopPolling = (): void => {
    pollGeneration += 1;
    pollAbort?.abort();
    pollAbort = null;
    const turn = turnSlot.cancel();
    if (turn) clearTurn(turn);
  };

  // ── Public API ──────────────────────────────────────────────────────

  return {
    async start(): Promise<void> {
      settings = await loadTelegramSettings();
      if (!settings) return;
      if (settings.activeConversationId) bridgeConversationIds.add(settings.activeConversationId);
      client = createTelegramBotClient(settings.botToken);
      try {
        await client.deleteWebhook();
        // Re-assert on every resume so bots connected before a command was
        // added still get it in their menu.
        await client.setMyCommands(BOT_COMMANDS);
      } catch (err) {
        log(`Bot setup call failed (continuing): ${asErrorMessage(err)}`);
      }
      startPolling();
      log(`Resumed bridge for @${settings.botUsername}.`);
    },

    async connect(botToken: string): Promise<{ ok: boolean; status: TelegramBridgeStatus; error?: string }> {
      const token = botToken.trim();
      if (!/^\d+:[\w-]+$/.test(token)) {
        return { ok: false, status: getStatus(), error: 'That does not look like a bot token (expected 123456:ABC-...).' };
      }
      const nextClient = createTelegramBotClient(token);
      let me;
      try {
        me = await nextClient.getMe();
      } catch (err) {
        const detail = err instanceof TelegramApiError && err.errorCode === 401
          ? 'Telegram rejected the token.'
          : asErrorMessage(err);
        return { ok: false, status: getStatus(), error: detail };
      }
      stopPolling();
      // Reconnecting with the same bot keeps the pairing; a different bot
      // starts unpaired with a fresh code.
      const samePairedBot = settings?.botId === me.id && settings.ownerChatId != null;
      settings = {
        botToken: token,
        botId: me.id,
        botUsername: me.username ?? '',
        ownerChatId: samePairedBot ? settings!.ownerChatId : null,
        ownerName: samePairedBot ? settings!.ownerName : null,
        pairingCode: samePairedBot ? null : newPairingCode(),
        activeConversationId: samePairedBot ? settings!.activeConversationId : null,
        lastUpdateId: null,
        model: samePairedBot ? settings!.model : null,
      };
      client = nextClient;
      lastError = null;
      await saveTelegramSettings(settings);
      try {
        await client.deleteWebhook();
        await client.setMyCommands(BOT_COMMANDS);
      } catch (err) {
        log(`Bot setup call failed (continuing): ${asErrorMessage(err)}`);
      }
      startPolling();
      log(`Connected bot @${settings.botUsername}.`);
      return { ok: true, status: getStatus() };
    },

    async disconnect(): Promise<void> {
      stopPolling();
      if (unsubscribeBus) {
        unsubscribeBus();
        unsubscribeBus = null;
      }
      const username = settings?.botUsername;
      settings = null;
      client = null;
      lastError = null;
      pendingApprovals.clear();
      bridgeConversationIds.clear();
      await clearTelegramSettings();
      if (username) log(`Disconnected bot @${username}.`);
      notifyStatus();
    },

    async stop(): Promise<void> {
      const wasRunning = pollAbort != null;
      stopPolling();
      if (unsubscribeBus) {
        unsubscribeBus();
        unsubscribeBus = null;
      }
      if (!wasRunning || settings?.ownerChatId == null) return;
      await Promise.race([
        sendToOwner(`Going offline: Antseed Desktop is closing. ${OFFLINE_NOTE}`),
        new Promise((resolve) => { setTimeout(resolve, GOODBYE_TIMEOUT_MS); }),
      ]);
    },

    getStatus,
  };
}
