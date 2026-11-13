// ── Telegram bridge settings (Electron safeStorage) ──
// The bot token grants full control of the user's bot, so the whole settings
// blob is encrypted at rest with the same safeStorage pattern as identity.ts.

import { safeStorage } from 'electron';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const ENCRYPTED_SETTINGS_PATH = path.join(homedir(), '.antseed', 'telegram.enc');

/** For the rename migration: the whole file is one encrypted blob. */
export function telegramSettingsPath(): string {
  return ENCRYPTED_SETTINGS_PATH;
}

export type TelegramSettings = {
  botToken: string;
  botId: number;
  botUsername: string;
  /** Chat that owns this bot. Until paired the bridge answers no one else. */
  ownerChatId: number | null;
  ownerName: string | null;
  /** One-time code the owner must present via /start <code> to pair. */
  pairingCode: string | null;
  /** Conversation new Telegram messages append to; /new rotates it. */
  activeConversationId: string | null;
  /** Model picked with /model; null until then. */
  model: string | null;
  /** Last acknowledged getUpdates id, so restarts don't replay messages. */
  lastUpdateId: number | null;
};

let settingsCache: TelegramSettings | null | undefined;

function safeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function normalizeSettings(value: unknown): TelegramSettings | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.botToken !== 'string' || raw.botToken.length === 0) return null;
  return {
    botToken: raw.botToken,
    botId: Number(raw.botId) || 0,
    botUsername: typeof raw.botUsername === 'string' ? raw.botUsername : '',
    ownerChatId: typeof raw.ownerChatId === 'number' ? raw.ownerChatId : null,
    ownerName: typeof raw.ownerName === 'string' ? raw.ownerName : null,
    pairingCode: typeof raw.pairingCode === 'string' ? raw.pairingCode : null,
    activeConversationId: typeof raw.activeConversationId === 'string' ? raw.activeConversationId : null,
    model: typeof raw.model === 'string' ? raw.model : null,
    lastUpdateId: typeof raw.lastUpdateId === 'number' ? raw.lastUpdateId : null,
  };
}

export async function loadTelegramSettings(): Promise<TelegramSettings | null> {
  if (settingsCache !== undefined) return settingsCache;
  if (!safeStorageAvailable()) {
    settingsCache = null;
    return null;
  }
  try {
    const encrypted = await readFile(ENCRYPTED_SETTINGS_PATH);
    settingsCache = normalizeSettings(JSON.parse(safeStorage.decryptString(encrypted)));
  } catch {
    // Missing file or undecryptable blob. Unlike identity.enc there is no
    // irrecoverable key here — the user can simply reconnect the bot.
    settingsCache = null;
  }
  return settingsCache;
}

export async function saveTelegramSettings(settings: TelegramSettings): Promise<void> {
  if (!safeStorageAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(settings));
  const tmpPath = ENCRYPTED_SETTINGS_PATH + '.tmp';
  await mkdir(path.dirname(ENCRYPTED_SETTINGS_PATH), { recursive: true });
  await writeFile(tmpPath, encrypted, { mode: 0o600 });
  await rename(tmpPath, ENCRYPTED_SETTINGS_PATH);
  settingsCache = settings;
}

export async function clearTelegramSettings(): Promise<void> {
  settingsCache = null;
  try {
    await unlink(ENCRYPTED_SETTINGS_PATH);
  } catch {
    // Already absent.
  }
}
