// ── Telegram Bot API client ──
// Minimal fetch-based client for the handful of Bot API methods the desktop
// bridge needs. No SDK dependency: every call is POST
// https://api.telegram.org/bot<token>/<method> with a JSON body.

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Long-poll wait passed to getUpdates (seconds). */
export const TELEGRAM_POLL_TIMEOUT_S = 50;

export type TgUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
};

export type TgChat = {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  first_name?: string;
  username?: string;
  title?: string;
};

export type TgPhotoSize = {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
};

export type TgDocument = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export type TgVoice = {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
};

export type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  /** Caption on media messages (photos, documents, voice notes). */
  caption?: string;
  /** Present on photo messages; ordered smallest → largest. */
  photo?: TgPhotoSize[];
  document?: TgDocument;
  voice?: TgVoice;
};

export type TgCallbackQuery = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

export type TgInlineKeyboardButton = { text: string; callback_data: string };
export type TgReplyMarkup = { inline_keyboard: TgInlineKeyboardButton[][] };

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number | null,
    description: string,
    readonly retryAfterS: number | null = null,
  ) {
    super(`Telegram ${method} failed${errorCode != null ? ` (${String(errorCode)})` : ''}: ${description}`);
    this.name = 'TelegramApiError';
  }
}

export type TgFile = {
  file_id: string;
  /** Relative path under https://api.telegram.org/file/bot<token>/ — absent for files >20 MB. */
  file_path?: string;
};

type TgResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

async function parseTgResponse<T>(method: string, response: Response): Promise<T> {
  let body: TgResponse<T>;
  try {
    body = await response.json() as TgResponse<T>;
  } catch {
    throw new TelegramApiError(method, response.status, 'Invalid response from Telegram');
  }
  if (!body.ok || body.result === undefined) {
    throw new TelegramApiError(
      method,
      body.error_code ?? response.status,
      body.description ?? 'Unknown error',
      body.parameters?.retry_after ?? null,
    );
  }
  return body.result;
}

async function tgCall<T>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  return parseTgResponse(method, response);
}

/** File payload for the multipart upload methods (sendPhoto / sendDocument). */
export type TgUploadFile = {
  bytes: Uint8Array;
  fileName: string;
  contentType: string;
};

async function tgUpload<T>(
  token: string,
  method: string,
  fileField: string,
  file: TgUploadFile,
  params: Record<string, string>,
  timeoutMs = 120_000,
): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) form.append(key, value);
  form.append(fileField, new Blob([file.bytes], { type: file.contentType }), file.fileName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    // No explicit content-type: fetch derives the multipart boundary.
    response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  return parseTgResponse(method, response);
}

export type TelegramBotClient = {
  getMe(): Promise<TgUser>;
  /**
   * Long-polls for updates; resolves with [] on poll timeout. Pass
   * timeoutS: 0 for an immediate snapshot of the queued backlog only.
   */
  getUpdates(offset: number | undefined, signal?: AbortSignal, timeoutS?: number): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, options?: {
    replyMarkup?: TgReplyMarkup;
    disableNotification?: boolean;
    parseMode?: 'HTML';
  }): Promise<TgMessage>;
  /**
   * Streams partial text into an ephemeral draft bubble (Bot API 9.3+).
   * Repeated calls with the same non-zero draftId animate the update
   * natively. Private chats only; the draft clears once a real
   * sendMessage arrives. Errors are the caller's to swallow — drafts are
   * cosmetic and must never fail a turn.
   */
  sendMessageDraft(chatId: number, draftId: number, text: string): Promise<void>;
  /** Uploads an image as a photo (Telegram caps photos at ~10 MB). */
  sendPhoto(chatId: number, file: TgUploadFile, options?: { caption?: string }): Promise<TgMessage>;
  /** Uploads a file as a document — the fallback for oversized or exotic images. */
  sendDocument(chatId: number, file: TgUploadFile, options?: { caption?: string }): Promise<TgMessage>;
  /** Resolves a media file_id to a downloadable path. */
  getFile(fileId: string): Promise<TgFile>;
  /** Downloads media bytes for a path returned by getFile (bots: ≤20 MB). */
  downloadFile(filePath: string): Promise<Buffer>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
  /** Drops any configured webhook so getUpdates polling works. */
  deleteWebhook(): Promise<void>;
};

export function createTelegramBotClient(token: string): TelegramBotClient {
  return {
    getMe: () => tgCall<TgUser>(token, 'getMe'),

    getUpdates: async (offset, signal, timeoutS = TELEGRAM_POLL_TIMEOUT_S) => {
      const controller = new AbortController();
      const abort = (): void => { controller.abort(); };
      signal?.addEventListener('abort', abort, { once: true });
      // Timeout must exceed the long-poll wait or every quiet poll aborts.
      const timer = setTimeout(abort, (timeoutS + 15) * 1000);
      try {
        const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getUpdates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            timeout: timeoutS,
            allowed_updates: ['message', 'callback_query'],
            ...(offset !== undefined ? { offset } : {}),
          }),
          signal: controller.signal,
        });
        const body = await response.json() as TgResponse<TgUpdate[]>;
        if (!body.ok || !Array.isArray(body.result)) {
          throw new TelegramApiError(
            'getUpdates',
            body.error_code ?? response.status,
            body.description ?? 'Unknown error',
            body.parameters?.retry_after ?? null,
          );
        }
        return body.result;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },

    sendMessage: (chatId, text, options) => tgCall<TgMessage>(token, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      ...(options?.disableNotification ? { disable_notification: true } : {}),
      ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
    }),

    sendMessageDraft: async (chatId, draftId, text) => {
      await tgCall(token, 'sendMessageDraft', {
        chat_id: chatId,
        draft_id: draftId,
        text,
      }, 10_000);
    },

    sendPhoto: (chatId, file, options) => tgUpload<TgMessage>(token, 'sendPhoto', 'photo', file, {
      chat_id: String(chatId),
      ...(options?.caption ? { caption: options.caption } : {}),
    }),

    sendDocument: (chatId, file, options) => tgUpload<TgMessage>(token, 'sendDocument', 'document', file, {
      chat_id: String(chatId),
      ...(options?.caption ? { caption: options.caption } : {}),
    }),

    getFile: (fileId) => tgCall<TgFile>(token, 'getFile', { file_id: fileId }),

    downloadFile: async (filePath) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const response = await fetch(`${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new TelegramApiError('downloadFile', response.status, `HTTP ${String(response.status)}`);
        }
        return Buffer.from(await response.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    },

    editMessageText: async (chatId, messageId, text) => {
      await tgCall(token, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
      });
    },

    answerCallbackQuery: async (callbackQueryId, text) => {
      await tgCall(token, 'answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      });
    },

    setMyCommands: async (commands) => {
      await tgCall(token, 'setMyCommands', { commands });
    },

    deleteWebhook: async () => {
      await tgCall(token, 'deleteWebhook', {});
    },
  };
}

/** Telegram messages cap at 4096 chars; split on line boundaries when possible. */
export function splitTelegramMessage(text: string, limit = 4096): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];
  const parts: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
